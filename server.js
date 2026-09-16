require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// CONFIGURACIÓN DE CORS Y MIDDLEWARES
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// CONEXIÓN A BASE DE DATOS MYSQL
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'asambleas_db',
  waitForConnections: true,
  connectionLimit: 50,
  queueLimit: 0
});

// CONFIGURACIÓN SOCKET.IO
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 30000,
  pingInterval: 10000
});

// ESTRUCTURAS EN MEMORIA PARA ESTADO EN TIEMPO REAL
const activeSockets = {}; // { assemblyId: { userId: socketId } }
const activePolls = {};   // { assemblyId: { questionId, texto, opciones, timerInterval, tiempoRestante, votos: { userId: opcionId } } }

// GENERADOR DE FIRMA NATIVA PARA ZOOM EMBEDDED SDK 3.8.5
function generateZoomSignature(sdkKey, sdkSecret, meetingNumber, role) {
  const iat = Math.floor(Date.now() / 1000) - 30;
  const exp = iat + 60 * 60 * 2;
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sdkKey: sdkKey,
    appKey: sdkKey,
    mn: meetingNumber.toString().replace(/\D/g, ''),
    role: parseInt(role),
    iat: iat,
    exp: exp,
    tokenExp: exp
  };

  const sHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const sPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', sdkSecret)
    .update(`${sHeader}.${sPayload}`)
    .digest('base64url');

  return `${sHeader}.${sPayload}.${signature}`;
}

// -------------------------------------------------------------------
// RUTAS HTTP Y ENDPOINTS REST API
// -------------------------------------------------------------------

// GET: Listar asambleas activas para la Landing Page
app.get('/api/assemblies', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, nombre_copropiedad, logo_url, activo FROM asambleas WHERE activo = 1 ORDER BY id DESC'
    );
    res.json({ ok: true, assemblies: rows });
  } catch (err) {
    console.error('Error al obtener asambleas:', err);
    res.status(500).json({ ok: false, error: 'Error al consultar asambleas' });
  }
});

// GET: Obtener detalle de una asamblea específica
app.get('/api/assemblies/:id', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, nombre_copropiedad, logo_url, zoom_meeting_id, zoom_passcode FROM asambleas WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Asamblea no encontrada' });
    res.json({ ok: true, assembly: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// POST: Crear una nueva asamblea desde Superadmin
app.post('/api/assemblies', async (req, res) => {
  try {
    const { nombre_copropiedad, logo_url, zoom_meeting_id, zoom_passcode } = req.body;
    if (!nombre_copropiedad) {
      return res.status(400).json({ ok: false, error: 'El nombre de la copropiedad es obligatorio.' });
    }

    const [result] = await db.query(
      'INSERT INTO asambleas (nombre_copropiedad, logo_url, zoom_meeting_id, zoom_passcode, activo) VALUES (?, ?, ?, ?, 1)',
      [nombre_copropiedad, logo_url || '', zoom_meeting_id || '', zoom_passcode || '']
    );

    const newAssemblyId = result.insertId;

    // Crear usuario de soporte predeterminado para esta asamblea
    await db.query(
      'INSERT INTO usuarios (asamblea_id, identificador_unico, unidad, nombre_completo, coeficiente, es_soporte) VALUES (?, ?, ?, ?, 0.0000, 1)',
      [newAssemblyId, `SOPORTE-${newAssemblyId}`, 'SOPORTE TÉCNICO', 'Soporte de la Asamblea', 0.0000]
    );

    io.emit('assemblies:updated');
    res.json({ ok: true, assemblyId: newAssemblyId, message: 'Asamblea creada con éxito.' });
  } catch (err) {
    console.error('Error al crear asamblea:', err);
    res.status(500).json({ ok: false, error: 'Error interno al registrar la asamblea.' });
  }
});

// POST: Crear usuario de soporte permanente
app.post('/api/support-users', async (req, res) => {
  try {
    const { assemblyId, identificadorUnico, nombreCompleto } = req.body;
    const idUpper = identificadorUnico.trim().toUpperCase();

    const [existing] = await db.query(
      'SELECT id FROM usuarios WHERE asamblea_id = ? AND identificador_unico = ?',
      [assemblyId, idUpper]
    );

    if (existing.length > 0) {
      return res.status(400).json({ ok: false, error: 'Este identificador de soporte ya existe en esta asamblea.' });
    }

    await db.query(
      'INSERT INTO usuarios (asamblea_id, identificador_unico, unidad, nombre_completo, coeficiente, es_soporte) VALUES (?, ?, ?, ?, 0.0000, 1)',
      [assemblyId, idUpper, 'SOPORTE', nombreCompleto || 'Técnico de Soporte', 0.0000]
    );

    res.json({ ok: true, message: 'Usuario de soporte guardado correctamente.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al registrar usuario de soporte.' });
  }
});

// GET: Obtener credenciales de Zoom para el cliente web
app.get('/api/assemblies/:id/zoom', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT zoom_meeting_id AS meetingId, zoom_passcode AS passcode FROM asambleas WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Configuración no encontrada' });
    res.json({ ok: true, zoom: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al obtener datos de Zoom' });
  }
});

// POST: Generar Firma de Zoom SDK
app.post('/api/zoom/signature', (req, res) => {
  try {
    const { meetingNumber, role } = req.body;
    const sdkKey = process.env.ZOOM_SDK_KEY || 'M34U7IqETI26K5_s2W3_vA';
    const sdkSecret = process.env.ZOOM_SDK_SECRET || 'wXAn549j8fH5aNf6x20GgW3QZpLLoX1c';

    if (!meetingNumber) return res.status(400).json({ ok: false, error: 'Número de reunión requerido.' });

    const signature = generateZoomSignature(sdkKey, sdkSecret, meetingNumber, role || 0);
    res.json({ ok: true, signature, sdkKey });
  } catch (err) {
    console.error('Error generando firma Zoom:', err);
    res.status(500).json({ ok: false, error: 'Error al generar firma SDK' });
  }
});

// GET: Obtener lista de documentos por asamblea
app.get('/api/documents/:assemblyId', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, titulo, archivo_url FROM documentos WHERE asamblea_id = ? ORDER BY id DESC',
      [req.params.assemblyId]
    );
    res.json({ ok: true, documentos: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al obtener documentos' });
  }
});

// POST: Registrar / Cargar Poder para Aprobación
app.post('/api/powers', async (req, res) => {
  try {
    const { assemblyId, otorganteUnico, apoderadoUnico, documentoUrl } = req.body;

    const [otorganteRows] = await db.query(
      'SELECT id, coeficiente FROM usuarios WHERE asamblea_id = ? AND identificador_unico = ?',
      [assemblyId, otorganteUnico.trim().toUpperCase()]
    );

    if (otorganteRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'El identificador del otorgante no existe.' });
    }

    const coefOtorgante = otorganteRows[0].coeficiente;

    await db.query(
      'INSERT INTO poderes (asamblea_id, otorgante_unico, apoderado_unico, coeficiente_otorgante, documento_url, estado) VALUES (?, ?, ?, ?, ?, "PENDIENTE")',
      [assemblyId, otorganteUnico.trim().toUpperCase(), apoderadoUnico.trim().toUpperCase(), coefOtorgante, documentoUrl]
    );

    io.to(`assembly_${assemblyId}`).emit('powers:updated');
    res.json({ ok: true, message: 'Poder subido correctamente.' });
  } catch (err) {
    console.error('Error al subir poder:', err);
    res.status(500).json({ ok: false, error: 'Error interno al registrar el poder.' });
  }
});

// GET: Obtener lista de poderes por asamblea (Para Administrador)
app.get('/api/powers/:assemblyId', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, otorgante_unico, apoderado_unico, coeficiente_otorgante, documento_url, estado FROM poderes WHERE asamblea_id = ? ORDER BY id DESC',
      [req.params.assemblyId]
    );
    res.json({ ok: true, poderes: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al consultar poderes' });
  }
});

// POST: Aprobar o Rechazar Poder (Administrador)
app.post('/api/powers/status', async (req, res) => {
  try {
    const { powerId, estado, assemblyId } = req.body;
    await db.query('UPDATE poderes SET estado = ? WHERE id = ?', [estado, powerId]);

    // Recalcular quórum y actualizar datos de usuarios conectados
    await recalcularQuorum(assemblyId);
    io.to(`assembly_${assemblyId}`).emit('powers:updated');

    res.json({ ok: true, message: `Poder ${estado.toLowerCase()} correctamente.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al cambiar estado del poder.' });
  }
});

// -------------------------------------------------------------------
// LÓGICA REUTILIZABLE DE QUÓRUM
// -------------------------------------------------------------------
async function recalcularQuorum(assemblyId) {
  const roomSockets = activeSockets[assemblyId] || {};
  const uniqueUserIds = Object.keys(roomSockets);

  if (uniqueUserIds.length === 0) {
    io.to(`assembly_${assemblyId}`).emit('quorum:update', { quorumPercentage: '0.0000' });
    return;
  }

  try {
    // 1. Obtener suma de coeficientes propios de usuarios conectados (excluyendo soporte)
    const [userRows] = await db.query(
      'SELECT identificador_unico, coeficiente, es_soporte FROM usuarios WHERE asamblea_id = ? AND identificador_unico IN (?)',
      [assemblyId, uniqueUserIds]
    );

    let totalCoeficiente = 0;
    const connectedNonSupportIds = [];

    userRows.forEach(u => {
      if (!u.es_soporte) {
        totalCoeficiente += parseFloat(u.coeficiente || 0);
        connectedNonSupportIds.push(u.identificador_unico);
      }
    });

    // 2. Sumar coeficientes de poderes aprobados asignados a los apoderados conectados
    if (connectedNonSupportIds.length > 0) {
      const [powerRows] = await db.query(
        'SELECT SUM(coeficiente_otorgante) AS totalPoderes FROM poderes WHERE asamblea_id = ? AND apoderado_unico IN (?) AND estado = "APROBADO"',
        [assemblyId, connectedNonSupportIds]
      );
      if (powerRows[0] && powerRows[0].totalPoderes) {
        totalCoeficiente += parseFloat(powerRows[0].totalPoderes);
      }
    }

    const quorumPct = (totalCoeficiente * 100).toFixed(4);
    io.to(`assembly_${assemblyId}`).emit('quorum:update', { quorumPercentage: quorumPct });

  } catch (err) {
    console.error('Error al calcular quórum:', err);
  }
}

// -------------------------------------------------------------------
// LÓGICA SOCKET.IO EN TIEMPO REAL MULTI-TENANT
// -------------------------------------------------------------------
io.on('connection', (socket) => {

  // AUTENTICACIÓN E INGRESO A LA SALA DE LA ASAMBLEA
  socket.on('auth:join', async ({ assemblyId, identificadorUnico }) => {
    try {
      const aid = parseInt(assemblyId);
      const idUpper = identificadorUnico.trim().toUpperCase();

      // Buscar usuario en la base de datos de esa asamblea
      let [rows] = await db.query(
        'SELECT * FROM usuarios WHERE asamblea_id = ? AND identificador_unico = ?',
        [aid, idUpper]
      );

      let user = rows[0];

      // Soporte comodín si no está pre-creado en la BD
      if (!user && (idUpper.startsWith('SOPORTE') || idUpper === 'ADMIN-SUPPORT')) {
        user = {
          id: 999000 + aid,
          asamblea_id: aid,
          identificador_unico: idUpper,
          unidad: 'SOPORTE TÉCNICO',
          nombre_completo: `Soporte Técnico (${idUpper})`,
          coeficiente: 0.0000,
          es_soporte: 1
        };
      }

      if (!user) {
        return socket.emit('auth:error', { message: 'Identificador no registrado en esta asamblea.' });
      }

      // EXPULSIÓN DE SESIÓN ÚNICA EN TIEMPO REAL
      if (!activeSockets[aid]) activeSockets[aid] = {};
      if (activeSockets[aid][idUpper]) {
        const previousSocketId = activeSockets[aid][idUpper];
        io.to(previousSocketId).emit('auth:kicked', {
          message: 'Se ha ingresado con tu mismo Identificador desde otro dispositivo o pestaña.'
        });
      }

      activeSockets[aid][idUpper] = socket.id;
      socket.assemblyId = aid;
      socket.userInfo = user;

      const roomName = `assembly_${aid}`;
      socket.join(roomName);

      // Calcular poderes asignados
      const [poderesAprobados] = await db.query(
        'SELECT otorgante_unico AS identificador, "Copropietario" AS nombre, coeficiente_otorgante AS coeficiente FROM poderes WHERE asamblea_id = ? AND apoderado_unico = ? AND estado = "APROBADO"',
        [aid, idUpper]
      );

      const [poderesPendientes] = await db.query(
        'SELECT otorgante_unico AS identificador, "Copropietario" AS nombre FROM poderes WHERE asamblea_id = ? AND apoderado_unico = ? AND estado = "PENDIENTE"',
        [aid, idUpper]
      );

      let coefPoderes = 0;
      poderesAprobados.forEach(p => coefPoderes += parseFloat(p.coeficiente || 0));

      const coefPropio = parseFloat(user.coeficiente || 0);
      const coefEfectivo = user.es_soporte ? 0 : (coefPropio + coefPoderes);

      socket.emit('auth:success', {
        user: {
          id: user.id,
          identificador_unico: user.identificador_unico,
          unidad: user.unidad,
          nombre_completo: user.nombre_completo,
          coeficientePropio: coefPropio,
          coeficientePoderes: coefPoderes,
          coeficienteEfectivo: coefEfectivo,
          esSoporte: !!user.es_soporte,
          poderesAprobados: poderesAprobados,
          poderesPendientes: poderesPendientes
        }
      });

      // Recalcular quórum para la sala de esta asamblea
      recalcularQuorum(aid);

      // Si hay una votación activa en la asamblea, enviarle el estado actual
      if (activePolls[aid]) {
        const poll = activePolls[aid];
        socket.emit('voting:current_state', {
          texto: poll.texto,
          opciones: poll.opciones,
          tiempoRestante: poll.tiempoRestante,
          myCurrentVote: poll.votos[idUpper] || null
        });
      }

    } catch (err) {
      console.error('Error en socket auth:join:', err);
      socket.emit('auth:error', { message: 'Error interno en la autenticación.' });
    }
  });

  // EMISIÓN Y RECEPCIÓN DE MENSAJES DE CHAT
  socket.on('chat:message', ({ texto, emisor, unidad }) => {
    if (!socket.assemblyId) return;
    const roomName = `assembly_${socket.assemblyId}`;
    const hora = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    io.to(roomName).emit('chat:broadcast', { texto, emisor, unidad, hora });
  });

  // INICIO DE VOTACIÓN POR EL ADMINISTRADOR
  socket.on('admin:start_voting', async ({ preguntaId, duracionSegundos }) => {
    const aid = socket.assemblyId;
    if (!aid) return;

    try {
      const [preguntas] = await db.query('SELECT * FROM preguntas WHERE id = ?', [preguntaId]);
      const [opciones] = await db.query('SELECT * FROM opciones WHERE pregunta_id = ?', [preguntaId]);

      if (preguntas.length === 0) return;

      if (activePolls[aid] && activePolls[aid].timerInterval) {
        clearInterval(activePolls[aid].timerInterval);
      }

      activePolls[aid] = {
        questionId: preguntaId,
        texto: preguntas[0].texto_pregunta,
        opciones: opciones,
        tiempoRestante: duracionSegundos || 60,
        votos: {}
      };

      io.to(`assembly_${aid}`).emit('voting:started', {
        texto: preguntas[0].texto_pregunta,
        opciones: opciones,
        tiempoRestante: activePolls[aid].tiempoRestante
      });

      // Cronómetro en vivo
      activePolls[aid].timerInterval = setInterval(() => {
        if (!activePolls[aid]) return;
        activePolls[aid].tiempoRestante -= 1;

        io.to(`assembly_${aid}`).emit('timer:tick', { tiempoRestante: activePolls[aid].tiempoRestante });

        if (activePolls[aid].tiempoRestante <= 0) {
          clearInterval(activePolls[aid].timerInterval);
          cerrarVotacion(aid);
        }
      }, 1000);

    } catch (err) {
      console.error('Error iniciando votación:', err);
    }
  });

  // REGISTRO Y MODIFICACIÓN DE VOTO EN TIEMPO REAL
  socket.on('vote:submit', ({ opcionId }) => {
    const aid = socket.assemblyId;
    const user = socket.userInfo;

    if (!aid || !user || !activePolls[aid]) return;

    const idUpper = user.identificador_unico;
    activePolls[aid].votos[idUpper] = opcionId;

    // Recalcular gráfica de resultados con coeficiente ponderado
    calcularYEmitirResultados(aid);
  });

  // CIERRE MANUAL DE VOTACIÓN
  socket.on('admin:close_voting', () => {
    const aid = socket.assemblyId;
    if (!aid || !activePolls[aid]) return;
    if (activePolls[aid].timerInterval) clearInterval(activePolls[aid].timerInterval);
    cerrarVotacion(aid);
  });

  // DESCONEXIÓN DEL USUARIO
  socket.on('disconnect', () => {
    const aid = socket.assemblyId;
    const user = socket.userInfo;

    if (aid && user && activeSockets[aid]) {
      if (activeSockets[aid][user.identificador_unico] === socket.id) {
        delete activeSockets[aid][user.identificador_unico];
        recalcularQuorum(aid);
      }
    }
  });
});

// -------------------------------------------------------------------
// CÁLCULO PONDERADO DE VOTACIONES
// -------------------------------------------------------------------
async function calcularYEmitirResultados(assemblyId) {
  const poll = activePolls[assemblyId];
  if (!poll) return;

  const resultados = {};
  poll.opciones.forEach(opt => {
    resultados[opt.id] = { texto: opt.texto_opcion, coeficienteAcumulado: 0, votosConteo: 0 };
  });

  const votedUserIds = Object.keys(poll.votos);

  if (votedUserIds.length > 0) {
    // Coeficiente propio
    const [userRows] = await db.query(
      'SELECT identificador_unico, coeficiente, es_soporte FROM usuarios WHERE asamblea_id = ? AND identificador_unico IN (?)',
      [assemblyId, votedUserIds]
    );

    const userMap = {};
    userRows.forEach(u => { userMap[u.identificador_unico] = u; });

    // Coeficiente de poderes aprobados
    const [powerRows] = await db.query(
      'SELECT apoderado_unico, coeficiente_otorgante FROM poderes WHERE asamblea_id = ? AND apoderado_unico IN (?) AND estado = "APROBADO"',
      [assemblyId, votedUserIds]
    );

    const powerMap = {};
    powerRows.forEach(p => {
      powerMap[p.apoderado_unico] = (powerMap[p.apoderado_unico] || 0) + parseFloat(p.coeficiente_otorgante || 0);
    });

    // Sumar porcentajes por cada voto emitido
    votedUserIds.forEach(userId => {
      const optionId = poll.votos[userId];
      const u = userMap[userId];

      if (u && !u.es_soporte && resultados[optionId]) {
        const cPropio = parseFloat(u.coeficiente || 0);
        const cPoderes = powerMap[userId] || 0;
        resultados[optionId].coeficienteAcumulado += (cPropio + cPoderes);
        resultados[optionId].votosConteo += 1;
      }
    });
  }

  io.to(`assembly_${assemblyId}`).emit('voting:results_update', { resultados });
}

function cerrarVotacion(assemblyId) {
  if (!activePolls[assemblyId]) return;
  calcularYEmitirResultados(assemblyId);
  io.to(`assembly_${assemblyId}`).emit('voting:closed', {
    message: 'Votación finalizada.',
    resultados: activePolls[assemblyId].resultados || {}
  });
}

// -------------------------------------------------------------------
// INICIO DEL SERVIDOR
// -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` Servidor de Asambleas Virtuales Activo en Puerto ${PORT}`);
  console.log(`===================================================`);
});
