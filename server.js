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

// MAPAS DE ESTADO EN MEMORIA (Optimizado para latencia < 500ms)
// Estructura: activeQuestions.get(assemblyId)
const activeQuestions = new Map();

// Estructura: timerIntervals.get(assemblyId)
const timerIntervals = new Map();

// Control de Sesión Única global: Map<"assemblyId_userId", socketId>
const activeSessions = new Map();

// Helper: Calcular resultados ponderados por coeficiente para una asamblea
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

// ROUTE DE PRUEBA HTTP
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    system: 'Plataforma Multi-tenant de Asambleas',
    version: '1.0.0'
  });
});

// LÓGICA DE WEBSOCKETS (Sockets en Tiempo Real)
io.on('connection', (socket) => {
  console.log(`🔌 Nuevo cliente conectado: ${socket.id}`);

  // 1. UNIRSE A UNA ASAMBLEA Y AUTENTICAR (SESIÓN ÚNICA + SALA MULTI-TENANT)
  socket.on('auth:join', async ({ assemblyId, userId }) => {
    try {
      const [rows] = await db.query(
        `SELECT id, identificador_unico, nombre_completo, unidad, coeficiente, rol 
         FROM usuarios 
         WHERE assembly_id = ? AND id = ?`,
        [assemblyId, userId]
      );

      if (rows.length === 0) {
        return socket.emit('auth:error', 'Usuario o Asamblea no válidos.');
      }

      const user = rows[0];
      const sessionKey = `${assemblyId}_${userId}`;

      // CONTROL DE SESIÓN ÚNICA: Desconectar dispositivo anterior si existe
      if (activeSessions.has(sessionKey)) {
        const previousSocketId = activeSessions.get(sessionKey);
        io.to(previousSocketId).emit('session:invalidated', {
          message: 'Se ha iniciado sesión con este usuario desde otro dispositivo.'
        });
      }

      // Registrar nueva sesión
      activeSessions.set(sessionKey, socket.id);
      socket.sessionKey = sessionKey;
      socket.assemblyId = assemblyId;
      socket.userId = userId;

      // Unir socket a la sala privada de esta copropiedad
      const roomName = `assembly_${assemblyId}`;
      socket.join(roomName);

      // Actualizar socket_id en BD
      await db.query(`UPDATE usuarios SET last_socket_id = ? WHERE id = ?`, [socket.id, userId]);

      // Enviar confirmación al usuario
      socket.emit('auth:success', {
        user,
        room: roomName
      });

      // Si hay una pregunta activa corriendo en esta asamblea, enviársela al usuario
      if (activeQuestions.has(assemblyId)) {
        const activeQ = activeQuestions.get(assemblyId);
        
        // Consultar si este usuario ya votó en esta pregunta
        const [votoUsuario] = await db.query(
          `SELECT opcion_id FROM votos WHERE pregunta_id = ? AND usuario_id = ?`,
          [activeQ.id, userId]
        );

        socket.emit('voting:current_state', {
          ...activeQ,
          myCurrentVote: votoUsuario.length > 0 ? votoUsuario[0].opcion_id : null
        });
      }

      console.log(`✅ ${user.nombre_completo} unido a la sala: ${roomName}`);
    } catch (error) {
      console.error('Error en auth:join:', error);
      socket.emit('auth:error', 'Error en la verificación de credenciales.');
    }
  });

  // 2. ADMINISTRADOR: ABRIR VOTACIÓN CON CRONÓMETRO
  socket.on('admin:start_voting', async ({ assemblyId, preguntaId, duracionSegundos }) => {
    try {
      // Detener cronómetro anterior si existía
      if (timerIntervals.has(assemblyId)) {
        clearInterval(timerIntervals.get(assemblyId));
      }

      // Marcar pregunta como activa en BD
      await db.query(`UPDATE preguntas SET estado = 'activa' WHERE id = ? AND assembly_id = ?`, [preguntaId, assemblyId]);

      // Consultar detalle de pregunta y opciones
      const [preguntas] = await db.query(`SELECT id, texto_pregunta FROM preguntas WHERE id = ?`, [preguntaId]);
      const [opciones] = await db.query(`SELECT id, texto_opcion FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`, [preguntaId]);

      if (preguntas.length === 0) return;

      const activeQData = {
        id: preguntas[0].id,
        texto: preguntas[0].texto_pregunta,
        opciones,
        duracion: duracionSegundos,
        tiempoRestante: duracionSegundos,
        isOpen: true
      };

      activeQuestions.set(assemblyId, activeQData);

      const roomName = `assembly_${assemblyId}`;

      // Emitir inicio de votación a toda la copropiedad
      io.to(roomName).emit('voting:started', activeQData);

      // INICIAR CRONÓMETRO REGRESIVO EN EL SERVIDOR
      const interval = setInterval(async () => {
        const currentQ = activeQuestions.get(assemblyId);

        if (!currentQ) {
          clearInterval(interval);
          return;
        }

        currentQ.tiempoRestante -= 1;

        // Notificar tick de reloj a los conectados de esta asamblea
        io.to(roomName).emit('timer:tick', { tiempoRestante: currentQ.tiempoRestante });

        // AL LLEGAR A CERO: CERRAR VOTACIÓN
        if (currentQ.tiempoRestante <= 0) {
          clearInterval(interval);
          timerIntervals.delete(assemblyId);
          currentQ.isOpen = false;

          // Cambiar estado en BD a 'cerrada'
          await db.query(`UPDATE preguntas SET estado = 'cerrada' WHERE id = ?`, [preguntaId]);

          // Calcular resultados finales por coeficiente
          const finalResults = await calculateWeightedResults(assemblyId, preguntaId);

          io.to(roomName).emit('voting:closed', {
            preguntaId,
            resultados: finalResults
          });

          activeQuestions.delete(assemblyId);
          console.log(`⏳ Votación ${preguntaId} cerrada en la asamblea ${assemblyId}`);
        }
      }, 1000);

      timerIntervals.set(assemblyId, interval);

    } catch (error) {
      console.error('Error al iniciar votación:', error);
    }
  });

  // 3. ASISTENTE: EMITIR O CAMBIAR VOTO
  socket.on('vote:submit', async ({ opcionId }) => {
    const { assemblyId, userId } = socket;

    if (!assemblyId || !userId) {
      return socket.emit('vote:error', 'No autenticado.');
    }

    const currentQ = activeQuestions.get(assemblyId);
    if (!currentQ || !currentQ.isOpen) {
      return socket.emit('vote:error', 'La votación no está activa.');
    }

    try {
      // Obtenemos coeficiente del usuario
      const [u] = await db.query(`SELECT coeficiente FROM usuarios WHERE id = ?`, [userId]);
      if (u.length === 0) return;

      const coef = u[0].coeficiente;

      // INSERT ON DUPLICATE KEY UPDATE: 
      // Si el usuario ya votó, actualiza la opción y la marca de tiempo; si no, inserta.
      await db.query(
        `INSERT INTO votos (assembly_id, pregunta_id, usuario_id, opcion_id, coeficiente_aplicado)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE opcion_id = VALUES(opcion_id), coeficiente_aplicado = VALUES(coeficiente_aplicado)`,
        [assemblyId, currentQ.id, userId, opcionId, coef]
      );

      // Confirmar al votante
      socket.emit('vote:confirmed', { opcionId });

      // Calcular y transmitir resultados en vivo a la sala de la asamblea
      const updatedResults = await calculateWeightedResults(assemblyId, currentQ.id);
      io.to(`assembly_${assemblyId}`).emit('voting:results_update', { resultados: updatedResults });

    } catch (error) {
      console.error('Error al registrar voto:', error);
      socket.emit('vote:error', 'Error interno al guardar el voto.');
    }
  });

  // 4. DESCONEXIÓN DE USUARIO
  socket.on('disconnect', () => {
    if (socket.sessionKey && activeSessions.get(socket.sessionKey) === socket.id) {
      activeSessions.delete(socket.sessionKey);
      console.log(`❌ Sesión finalizada: ${socket.sessionKey}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor de Asambleas corriendo en puerto ${PORT}`);
});