require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const activeQuestions = new Map();
const timerIntervals = new Map();

// CONTROL DE SESIONES Y PERIODO DE GRACIA (10 MINUTOS)
const activeSessions = new Map(); 
const disconnectTimeouts = new Map(); 
const GRACE_PERIOD_MS = 10 * 60 * 1000; 

// Helper: Calcular Coeficiente Efectivo del Usuario (Propio + Poderes Autorizados)
async function getUserEffectiveCoefficient(userId, assemblyId) {
  try {
    const [rows] = await db.query(
      `SELECT u.coeficiente,
         COALESCE(SUM(u_ot.coeficiente), 0) AS coef_poderes
       FROM usuarios u
       LEFT JOIN poderes p ON p.apoderado_id = u.id AND p.assembly_id = ? AND p.estado = 'autorizado'
       LEFT JOIN usuarios u_ot ON p.otorgante_id = u_ot.id
       WHERE u.id = ? AND u.assembly_id = ?
       GROUP BY u.id`,
      [assemblyId, userId, assemblyId]
    );

    if (rows.length === 0) return 0.00000;
    
    const propio = parseFloat(rows[0].coeficiente) || 0;
    const poderes = parseFloat(rows[0].coef_poderes) || 0;
    return propio + poderes;
  } catch (err) {
    console.error('Error calculando coeficiente efectivo:', err);
    return 0.00000;
  }
}

// Helper: Calcular quórum de usuarios conectados
async function updateAndBroadcastQuorum(assemblyId) {
  try {
    const activeUserIds = [];

    for (const [key, session] of activeSessions.entries()) {
      if (session.assemblyId === parseInt(assemblyId)) {
        activeUserIds.push(session.userId);
      }
    }

    if (activeUserIds.length === 0) {
      io.to(`assembly_${assemblyId}`).emit('quorum:update', { quorumPercentage: "0.0000" });
      return;
    }

    let totalQuorum = 0;
    for (let uId of activeUserIds) {
      totalQuorum += await getUserEffectiveCoefficient(uId, assemblyId);
    }

    const quorumPercentage = (totalQuorum * 100).toFixed(4);
    io.to(`assembly_${assemblyId}`).emit('quorum:update', { quorumPercentage });
  } catch (err) {
    console.error('Error calculando quórum:', err);
  }
}

// Helper: Resultados ponderados por coeficiente
async function calculateWeightedResults(assemblyId, preguntaId) {
  const [votos] = await db.query(
    `SELECT v.opcion_id, v.coeficiente_aplicado 
     FROM votos v 
     WHERE v.assembly_id = ? AND v.pregunta_id = ?`,
    [assemblyId, preguntaId]
  );

  const [opciones] = await db.query(
    `SELECT id, texto_opcion FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`,
    [preguntaId]
  );

  const results = {};
  opciones.forEach(opt => {
    results[opt.id] = {
      id: opt.id,
      texto: opt.texto_opcion,
      votosConteo: 0,
      coeficienteAcumulado: 0.00000
    };
  });

  votos.forEach(voto => {
    if (results[voto.opcion_id]) {
      results[voto.opcion_id].votosConteo += 1;
      results[voto.opcion_id].coeficienteAcumulado += parseFloat(voto.coeficiente_aplicado);
    }
  });

  return results;
}

// API: Obtener preguntas para el panel admin
app.get('/api/questions/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    const [preguntas] = await db.query(
      `SELECT * FROM preguntas WHERE assembly_id = ? ORDER BY orden ASC`,
      [assemblyId]
    );

    for (let p of preguntas) {
      const [opciones] = await db.query(
        `SELECT * FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`,
        [p.id]
      );
      p.opciones = opciones;
    }

    res.json({ ok: true, preguntas });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: CREAR NUEVA PREGUNTA DESDE ADMIN
app.post('/api/questions', async (req, res) => {
  try {
    const { assemblyId, textoPregunta, duracionSegundos, opciones } = req.body;

    if (!textoPregunta || !opciones || opciones.length < 2) {
      return res.status(400).json({ ok: false, error: 'Debes proporcionar una pregunta y al menos 2 opciones.' });
    }

    const [result] = await db.query(
      `INSERT INTO preguntas (assembly_id, texto_pregunta, duracion_segundos, estado) VALUES (?, ?, ?, 'borrador')`,
      [assemblyId || 1, textoPregunta, parseInt(duracionSegundos) || 60]
    );

    const preguntaId = result.insertId;

    for (let i = 0; i < opciones.length; i++) {
      await db.query(
        `INSERT INTO opciones_pregunta (pregunta_id, texto_opcion, orden) VALUES (?, ?, ?)`,
        [preguntaId, opciones[i], i + 1]
      );
    }

    res.json({ ok: true, preguntaId, message: 'Pregunta creada exitosamente.' });
  } catch (err) {
    console.error('Error al crear pregunta:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: OBTENER PODERES REGISTRADOS
app.get('/api/powers/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    const [poderes] = await db.query(
      `SELECT p.id, p.estado, p.documento_url, p.observaciones, p.created_at,
              u_ot.identificador_unico AS otorgante_id, u_ot.nombre_completo AS otorgante_nombre, u_ot.coeficiente AS otorgante_coef,
              u_ap.identificador_unico AS apoderado_id, u_ap.nombre_completo AS apoderado_nombre
       FROM poderes p
       JOIN usuarios u_ot ON p.otorgante_id = u_ot.id
       JOIN usuarios u_ap ON p.apoderado_id = u_ap.id
       WHERE p.assembly_id = ?
       ORDER BY p.created_at DESC`,
      [assemblyId]
    );

    res.json({ ok: true, poderes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: REGISTRAR UN PODER
app.post('/api/powers', async (req, res) => {
  try {
    const { assemblyId, otorganteUnico, apoderadoUnico, documentoUrl } = req.body;

    const [otorgantes] = await db.query(
      `SELECT id FROM usuarios WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`,
      [assemblyId || 1, otorganteUnico.toString().trim().toUpperCase()]
    );

    const [apoderados] = await db.query(
      `SELECT id FROM usuarios WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`,
      [assemblyId || 1, apoderadoUnico.toString().trim().toUpperCase()]
    );

    if (otorgantes.length === 0) return res.status(400).json({ ok: false, error: 'El identificador del otorgante no existe.' });
    if (apoderados.length === 0) return res.status(400).json({ ok: false, error: 'El identificador del apoderado no existe.' });

    await db.query(
      `INSERT INTO poderes (assembly_id, otorgante_id, apoderado_id, documento_url, estado)
       VALUES (?, ?, ?, ?, 'pendiente')`,
      [assemblyId || 1, otorgantes[0].id, apoderados[0].id, documentoUrl || 'https://via.placeholder.com/300?text=Poder+PDF']
    );

    res.json({ ok: true, message: 'Poder cargado exitosamente. Pendiente de aprobación administrativa.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: CAMBIAR ESTADO DE PODER
app.put('/api/powers/:powerId/status', async (req, res) => {
  try {
    const { powerId } = req.params;
    const { estado, observaciones } = req.body;

    await db.query(
      `UPDATE poderes SET estado = ?, observaciones = ? WHERE id = ?`,
      [estado, observaciones || '', powerId]
    );

    const [p] = await db.query(`SELECT assembly_id FROM poderes WHERE id = ?`, [powerId]);
    if (p.length > 0) {
      await updateAndBroadcastQuorum(p[0].assembly_id);
      io.to(`assembly_${p[0].assembly_id}`).emit('powers:updated');
    }

    res.json({ ok: true, message: `Poder ${estado} correctamente.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ROUTE DE PRUEBA HTTP
app.get('/', (req, res) => {
  res.json({ status: 'online', system: 'Plataforma Multi-tenant de Asambleas', version: '1.3.0' });
});

// WEBSOCKETS
io.on('connection', (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  socket.on('auth:join', async ({ assemblyId, identificadorUnico }) => {
    try {
      const targetAssembly = parseInt(assemblyId) || 1;
      const targetId = (identificadorUnico || '').toString().trim().toUpperCase();

      const [rows] = await db.query(
        `SELECT id, identificador_unico, nombre_completo, unidad, coeficiente, rol 
         FROM usuarios 
         WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`,
        [targetAssembly, targetId]
      );

      if (rows.length === 0) {
        return socket.emit('auth:error', 'Identificador no registrado.');
      }

      const user = rows[0];
      const userId = user.id;
      const sessionKey = `${targetAssembly}_${userId}`;

      if (disconnectTimeouts.has(sessionKey)) {
        clearTimeout(disconnectTimeouts.get(sessionKey));
        disconnectTimeouts.delete(sessionKey);
      } else if (activeSessions.has(sessionKey)) {
        const existingSession = activeSessions.get(sessionKey);
        if (existingSession.socketId !== socket.id) {
          io.to(existingSession.socketId).emit('session:invalidated', {
            message: 'Se ha iniciado sesión con este usuario desde otro dispositivo.'
          });
        }
      }

      activeSessions.set(sessionKey, {
        userId,
        assemblyId: targetAssembly,
        socketId: socket.id
      });

      socket.sessionKey = sessionKey;
      socket.assemblyId = targetAssembly;
      socket.userId = userId;

      const roomName = `assembly_${targetAssembly}`;
      socket.join(roomName);

      await db.query(`UPDATE usuarios SET last_socket_id = ? WHERE id = ?`, [socket.id, userId]);

      const efCoef = await getUserEffectiveCoefficient(userId, targetAssembly);
      user.coeficienteEfectivo = efCoef;

      socket.emit('auth:success', { user, room: roomName });

      await updateAndBroadcastQuorum(targetAssembly);

      if (activeQuestions.has(targetAssembly)) {
        const activeQ = activeQuestions.get(targetAssembly);
        const [votoUsuario] = await db.query(
          `SELECT opcion_id FROM votos WHERE pregunta_id = ? AND usuario_id = ?`,
          [activeQ.id, userId]
        );
        socket.emit('voting:current_state', {
          ...activeQ,
          myCurrentVote: votoUsuario.length > 0 ? votoUsuario[0].opcion_id : null
        });
      }

    } catch (error) {
      console.error('Error en auth:join:', error);
      socket.emit('auth:error', 'Error interno al autenticar.');
    }
  });

  socket.on('admin:start_voting', async ({ assemblyId, preguntaId, duracionSegundos }) => {
    try {
      if (timerIntervals.has(assemblyId)) {
        clearInterval(timerIntervals.get(assemblyId));
      }

      await db.query(`UPDATE preguntas SET estado = 'activa' WHERE id = ? AND assembly_id = ?`, [preguntaId, assemblyId]);

      const [preguntas] = await db.query(`SELECT id, texto_pregunta FROM preguntas WHERE id = ?`, [preguntaId]);
      const [opciones] = await db.query(`SELECT id, texto_opcion FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`, [preguntaId]);

      if (preguntas.length === 0) return;

      const duracion = parseInt(duracionSegundos) || 60;

      const activeQData = {
        id: preguntas[0].id,
        texto: preguntas[0].texto_pregunta,
        opciones,
        duracion,
        tiempoRestante: duracion,
        isOpen: true
      };

      activeQuestions.set(assemblyId, activeQData);
      const roomName = `assembly_${assemblyId}`;

      io.to(roomName).emit('voting:started', activeQData);

      const interval = setInterval(async () => {
        const currentQ = activeQuestions.get(assemblyId);
        if (!currentQ) {
          clearInterval(interval);
          return;
        }

        currentQ.tiempoRestante -= 1;
        io.to(roomName).emit('timer:tick', { tiempoRestante: currentQ.tiempoRestante });

        if (currentQ.tiempoRestante <= 0) {
          clearInterval(interval);
          timerIntervals.delete(assemblyId);
          currentQ.isOpen = false;

          await db.query(`UPDATE preguntas SET estado = 'cerrada' WHERE id = ?`, [preguntaId]);
          const finalResults = await calculateWeightedResults(assemblyId, preguntaId);

          io.to(roomName).emit('voting:closed', {
            preguntaId,
            resultados: finalResults
          });

          activeQuestions.delete(assemblyId);
        }
      }, 1000);

      timerIntervals.set(assemblyId, interval);

    } catch (error) {
      console.error('Error al iniciar votación:', error);
    }
  });

  socket.on('vote:submit', async ({ opcionId }) => {
    const { assemblyId, userId } = socket;
    if (!assemblyId || !userId) return socket.emit('vote:error', 'No autenticado.');

    const currentQ = activeQuestions.get(assemblyId);
    if (!currentQ || !currentQ.isOpen) return socket.emit('vote:error', 'La votación no está activa.');

    try {
      const efCoef = await getUserEffectiveCoefficient(userId, assemblyId);

      await db.query(
        `INSERT INTO votos (assembly_id, pregunta_id, usuario_id, opcion_id, coeficiente_aplicado)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE opcion_id = VALUES(opcion_id), coeficiente_aplicado = VALUES(coeficiente_aplicado)`,
        [assemblyId, currentQ.id, userId, opcionId, efCoef]
      );

      socket.emit('vote:confirmed', { opcionId });
      const updatedResults = await calculateWeightedResults(assemblyId, currentQ.id);
      io.to(`assembly_${assemblyId}`).emit('voting:results_update', { resultados: updatedResults });

    } catch (error) {
      console.error('Error al registrar voto:', error);
    }
  });

  socket.on('disconnect', () => {
    if (socket.sessionKey && activeSessions.has(socket.sessionKey)) {
      const sessionKey = socket.sessionKey;
      const sessionData = activeSessions.get(socket.sessionKey);

      if (sessionData.socketId === socket.id) {
        if (disconnectTimeouts.has(sessionKey)) {
          clearTimeout(disconnectTimeouts.get(sessionKey));
        }

        const timeoutId = setTimeout(async () => {
          activeSessions.delete(sessionKey);
          disconnectTimeouts.delete(sessionKey);
          await updateAndBroadcastQuorum(sessionData.assemblyId);
        }, GRACE_PERIOD_MS);

        disconnectTimeouts.set(sessionKey, timeoutId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor de Asambleas v1.3 corriendo en puerto ${PORT}`);
});
