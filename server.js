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
const activeSessions = new Map();

// Helper: Calcular quórum de usuarios conectados en la asamblea
async function updateAndBroadcastQuorum(assemblyId) {
  try {
    const room = io.sockets.adapter.rooms.get(`assembly_${assemblyId}`);
    if (!room) {
      io.to(`assembly_${assemblyId}`).emit('quorum:update', { quorumPercentage: 0 });
      return;
    }

    const connectedSocketIds = Array.from(room);
    const userIds = [];

    connectedSocketIds.forEach(socketId => {
      const sock = io.sockets.sockets.get(socketId);
      if (sock && sock.userId) {
        userIds.push(sock.userId);
      }
    });

    if (userIds.length === 0) {
      io.to(`assembly_${assemblyId}`).emit('quorum:update', { quorumPercentage: 0 });
      return;
    }

    // Sumar coeficientes de usuarios conectados
    const [rows] = await db.query(
      `SELECT SUM(coeficiente) AS total_quorum FROM usuarios WHERE id IN (?) AND assembly_id = ?`,
      [userIds, assemblyId]
    );

    const totalQuorum = rows[0].total_quorum ? parseFloat(rows[0].total_quorum) : 0;
    const quorumPercentage = (totalQuorum * 100).toFixed(4);

    io.to(`assembly_${assemblyId}`).emit('quorum:update', { quorumPercentage });
  } catch (err) {
    console.error('Error calculando quórum:', err);
  }
}

// Helper: Resultados ponderados por coeficiente
async function calculateWeightedResults(assemblyId, preguntaId) {
  const [votos] = await db.query(
    `SELECT v.opcion_id, u.coeficiente 
     FROM votos v 
     JOIN usuarios u ON v.usuario_id = u.id 
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
      results[voto.opcion_id].coeficienteAcumulado += parseFloat(voto.coeficiente);
    }
  });

  return results;
}

// API: Obtener preguntas disponibles para el panel admin
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

// WEBSOCKETS
io.on('connection', (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  socket.on('auth:join', async ({ assemblyId, identificadorUnico }) => {
    try {
      const targetAssembly = assemblyId || 1;
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

      if (activeSessions.has(sessionKey)) {
        const previousSocketId = activeSessions.get(sessionKey);
        io.to(previousSocketId).emit('session:invalidated', {
          message: 'Se ha iniciado sesión con este usuario desde otro dispositivo.'
        });
      }

      activeSessions.set(sessionKey, socket.id);
      socket.sessionKey = sessionKey;
      socket.assemblyId = targetAssembly;
      socket.userId = userId;

      const roomName = `assembly_${targetAssembly}`;
      socket.join(roomName);

      await db.query(`UPDATE usuarios SET last_socket_id = ? WHERE id = ?`, [socket.id, userId]);

      socket.emit('auth:success', { user, room: roomName });

      // Actualizar Quórum global
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

  // ADMINISTRADOR: INICIAR VOTACIÓN
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

  // VOTO DE ASISTENTE
  socket.on('vote:submit', async ({ opcionId }) => {
    const { assemblyId, userId } = socket;
    if (!assemblyId || !userId) return socket.emit('vote:error', 'No autenticado.');

    const currentQ = activeQuestions.get(assemblyId);
    if (!currentQ || !currentQ.isOpen) return socket.emit('vote:error', 'La votación no está activa.');

    try {
      const [u] = await db.query(`SELECT coeficiente FROM usuarios WHERE id = ?`, [userId]);
      if (u.length === 0) return;

      const coef = u[0].coeficiente;

      await db.query(
        `INSERT INTO votos (assembly_id, pregunta_id, usuario_id, opcion_id, coeficiente_aplicado)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE opcion_id = VALUES(opcion_id), coeficiente_aplicado = VALUES(coeficiente_aplicado)`,
        [assemblyId, currentQ.id, userId, opcionId, coef]
      );

      socket.emit('vote:confirmed', { opcionId });
      const updatedResults = await calculateWeightedResults(assemblyId, currentQ.id);
      io.to(`assembly_${assemblyId}`).emit('voting:results_update', { resultados: updatedResults });

    } catch (error) {
      console.error('Error al registrar voto:', error);
    }
  });

  socket.on('disconnect', async () => {
    if (socket.sessionKey && activeSessions.get(socket.sessionKey) === socket.id) {
      activeSessions.delete(socket.sessionKey);
      if (socket.assemblyId) {
        await updateAndBroadcastQuorum(socket.assemblyId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor de Asambleas corriendo en puerto ${PORT}`);
});
