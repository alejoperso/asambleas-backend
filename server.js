require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const activeQuestions = new Map();
const timerIntervals = new Map();
const activeSessions = new Map(); 
const disconnectTimeouts = new Map(); 
const GRACE_PERIOD_MS = 10 * 60 * 1000; 

// HELPER: CONVERTIDOR AUTOMÁTICO CON EXTRACCIÓN AVANZADA DE PASSCODE Y RUTA /wc/join/
function formatZoomEmbedUrl(rawUrl, manualPasscode) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let url = rawUrl.trim();

  try {
    const meetingIdMatch = url.match(/\/(?:j|wc|embed|join)\/(\d+)/) || url.match(/(\d{9,11})/);
    if (meetingIdMatch && meetingIdMatch[1]) {
      const meetingId = meetingIdMatch[1];
      let pwd = (manualPasscode || '').trim();

      if (!pwd) {
        const pwdMatch = url.match(/[?&]pwd=([^&]+)/);
        if (pwdMatch && pwdMatch[1]) {
          pwd = pwdMatch[1];
        }
      }

      return `https://zoom.us/wc/join/${meetingId}${pwd ? '?pwd=' + encodeURIComponent(pwd) : ''}`;
    }
  } catch (err) {
    console.error('Error al procesar URL de Zoom:', err);
  }

  return url;
}

// HELPER: CONSULTA DETALLADA DE PODERES Y COEFICIENTE EFECTIVO
async function getUserPowerDetails(userId, assemblyId) {
  try {
    const [rows] = await db.query(
      `SELECT p.id AS poder_id, u_ot.identificador_unico, u_ot.nombre_completo, u_ot.unidad, u_ot.coeficiente
       FROM poderes p
       JOIN usuarios u_ot ON p.otorgante_id = u_ot.id
       WHERE p.apoderado_id = ? AND p.assembly_id = ? AND p.estado = 'autorizado'`,
      [userId, assemblyId]
    );

    let coefPoderes = 0;
    const representados = rows.map(r => {
      const c = parseFloat(r.coeficiente) || 0;
      coefPoderes += c;
      return {
        identificador: r.identificador_unico,
        nombre: r.nombre_completo,
        unidad: r.unidad,
        coeficiente: c
      };
    });

    return { coefPoderes, representados };
  } catch (err) {
    return { coefPoderes: 0, representados: [] };
  }
}

async function getUserEffectiveCoefficient(userId, assemblyId) {
  const [u] = await db.query(`SELECT coeficiente FROM usuarios WHERE id = ?`, [userId]);
  const propio = u.length > 0 ? parseFloat(u[0].coeficiente) || 0 : 0;
  const { coefPoderes } = await getUserPowerDetails(userId, assemblyId);
  return propio + coefPoderes;
}

async function updateAndBroadcastQuorum(assemblyId) {
  try {
    const activeUserIds = [];
    for (const [key, session] of activeSessions.entries()) {
      if (session.assemblyId === parseInt(assemblyId)) activeUserIds.push(session.userId);
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

async function calculateWeightedResults(assemblyId, preguntaId) {
  const [votos] = await db.query(
    `SELECT v.opcion_id, v.coeficiente_aplicado FROM votos v WHERE v.assembly_id = ? AND v.pregunta_id = ?`,
    [assemblyId, preguntaId]
  );
  const [opciones] = await db.query(
    `SELECT id, texto_opcion FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`,
    [preguntaId]
  );
  const results = {};
  opciones.forEach(opt => {
    results[opt.id] = { id: opt.id, texto: opt.texto_opcion, votosConteo: 0, coeficienteAcumulado: 0.00000 };
  });
  votos.forEach(voto => {
    if (results[voto.opcion_id]) {
      results[voto.opcion_id].votosConteo += 1;
      results[voto.opcion_id].coeficienteAcumulado += parseFloat(voto.coeficiente_aplicado);
    }
  });
  return results;
}

// REST API: GESTIÓN DE ZOOM
app.get('/api/assemblies/:id/zoom', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(`SELECT zoom_embed_url, zoom_meeting_id, zoom_passcode FROM asambleas WHERE id = ?`, [id]);
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Asamblea no encontrada' });
    res.json({ ok: true, zoom: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/assemblies/:id/zoom', async (req, res) => {
  try {
    const { id } = req.params;
    const { zoomEmbedUrl, zoomPasscode } = req.body;
    const formattedUrl = formatZoomEmbedUrl(zoomEmbedUrl, zoomPasscode);

    await db.query(
      `UPDATE asambleas SET zoom_embed_url = ?, zoom_passcode = ? WHERE id = ?`,
      [formattedUrl, zoomPasscode || '', id]
    );
    io.to(`assembly_${id}`).emit('zoom:updated', { zoomEmbedUrl: formattedUrl });
    res.json({ ok: true, message: 'Enlace de Zoom procesado y guardado correctamente.', zoomEmbedUrl: formattedUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: REPORTES EN EXCEL / CSV
app.get('/api/reports/assembly/:id/excel', async (req, res) => {
  try {
    const { id } = req.params;
    const [votos] = await db.query(
      `SELECT 
         p.texto_pregunta AS Pregunta,
         u.identificador_unico AS ID_Votante,
         u.nombre_completo AS Nombre,
         u.unidad AS Unidad,
         o.texto_opcion AS Opcion_Votada,
         v.coeficiente_aplicado AS Coeficiente_Efectivo,
         v.created_at AS Fecha_Hora_Voto
       FROM votos v
       JOIN preguntas p ON v.pregunta_id = p.id
       JOIN usuarios u ON v.usuario_id = u.id
       JOIN opciones_pregunta o ON v.opcion_id = o.id
       WHERE v.assembly_id = ?
       ORDER BY p.id ASC, v.created_at ASC`,
      [id]
    );

    let csvContent = "\uFEFFPregunta;ID Votante;Nombre;Unidad;Opción Votada;Coeficiente Aplicado (%);Fecha y Hora\n";
    votos.forEach(v => {
      const coefPct = (parseFloat(v.Coeficiente_Efectivo) * 100).toFixed(4);
      const fecha = new Date(v.Fecha_Hora_Voto).toLocaleString('es-CO');
      csvContent += `"${v.Pregunta}";"${v.ID_Votante}";"${v.Nombre}";"${v.Unidad}";"${v.Opcion_Votada}";"${coefPct}%";"${fecha}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=Reporte_Votacion_Asamblea_${id}.csv`);
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: PREGUNTAS
app.get('/api/questions/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    const [preguntas] = await db.query(`SELECT * FROM preguntas WHERE assembly_id = ? ORDER BY orden ASC`, [assemblyId]);
    for (let p of preguntas) {
      const [opciones] = await db.query(`SELECT * FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`, [p.id]);
      p.opciones = opciones;
    }
    res.json({ ok: true, preguntas });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/questions', async (req, res) => {
  try {
    const { assemblyId, textoPregunta, duracionSegundos, opciones } = req.body;
    const [result] = await db.query(
      `INSERT INTO preguntas (assembly_id, texto_pregunta, duracion_segundos, estado) VALUES (?, ?, ?, 'borrador')`,
      [assemblyId || 1, textoPregunta, parseInt(duracionSegundos) || 60]
    );
    const preguntaId = result.insertId;
    for (let i = 0; i < opciones.length; i++) {
      await db.query(`INSERT INTO opciones_pregunta (pregunta_id, texto_opcion, orden) VALUES (?, ?, ?)`, [preguntaId, opciones[i], i + 1]);
    }
    io.to(`assembly_${assemblyId || 1}`).emit('questions:updated');
    res.json({ ok: true, preguntaId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { textoPregunta, duracionSegundos, opciones, assemblyId } = req.body;
    await db.query(`UPDATE preguntas SET texto_pregunta = ?, duracion_segundos = ? WHERE id = ?`, [textoPregunta, parseInt(duracionSegundos) || 60, id]);
    
    if (opciones && opciones.length >= 2) {
      await db.query(`DELETE FROM opciones_pregunta WHERE pregunta_id = ?`, [id]);
      for (let i = 0; i < opciones.length; i++) {
        await db.query(`INSERT INTO opciones_pregunta (pregunta_id, texto_opcion, orden) VALUES (?, ?, ?)`, [id, opciones[i], i + 1]);
      }
    }
    io.to(`assembly_${assemblyId || 1}`).emit('questions:updated');
    res.json({ ok: true, message: 'Pregunta actualizada.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { assemblyId } = req.query;
    await db.query(`DELETE FROM votos WHERE pregunta_id = ?`, [id]);
    await db.query(`DELETE FROM opciones_pregunta WHERE pregunta_id = ?`, [id]);
    await db.query(`DELETE FROM preguntas WHERE id = ?`, [id]);
    io.to(`assembly_${assemblyId || 1}`).emit('questions:updated');
    res.json({ ok: true, message: 'Pregunta eliminada.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/questions/:id/reset', async (req, res) => {
  try {
    const { id } = req.params;
    const { assemblyId } = req.body;
    await db.query(`DELETE FROM votos WHERE pregunta_id = ?`, [id]);
    await db.query(`UPDATE preguntas SET estado = 'borrador' WHERE id = ?`, [id]);
    io.to(`assembly_${assemblyId || 1}`).emit('questions:updated');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: USUARIOS Y BUSCADOR
app.get('/api/users/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    const { search } = req.query;
    let sql = `SELECT id, identificador_unico, nombre_completo, unidad, coeficiente, rol FROM usuarios WHERE assembly_id = ?`;
    let params = [assemblyId];

    if (search) {
      sql += ` AND (UPPER(identificador_unico) LIKE ? OR UPPER(nombre_completo) LIKE ? OR UPPER(unidad) LIKE ?)`;
      const term = `%${search.toUpperCase()}%`;
      params.push(term, term, term);
    }
    sql += ` ORDER BY unidad ASC LIMIT 50`;
    const [usuarios] = await db.query(sql, params);
    res.json({ ok: true, usuarios });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: PODERES Y APODERADO EXTERNO
app.post('/api/powers/manual', async (req, res) => {
  try {
    const { assemblyId, otorganteId, apoderadoIdentificador, apoderadoNombre } = req.body;
    const targetAssembly = assemblyId || 1;
    const targetApoderadoId = apoderadoIdentificador.toString().trim().toUpperCase();

    let [apoderadoRows] = await db.query(
      `SELECT id FROM usuarios WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`,
      [targetAssembly, targetApoderadoId]
    );

    let apoderadoNumId;
    if (apoderadoRows.length === 0) {
      const [ins] = await db.query(
        `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, coeficiente, rol)
         VALUES (?, ?, ?, 'Apoderado Externo', 0.00000, 'asistente')`,
        [targetAssembly, targetApoderadoId, apoderadoNombre || 'Apoderado Externo']
      );
      apoderadoNumId = ins.insertId;
    } else {
      apoderadoNumId = apoderadoRows[0].id;
    }

    await db.query(
      `INSERT INTO poderes (assembly_id, otorgante_id, apoderado_id, documento_url, estado, observaciones)
       VALUES (?, ?, ?, 'ASIGNACIÓN DIRECTA ADMIN', 'autorizado', 'Asignado manualmente')
       ON DUPLICATE KEY UPDATE apoderado_id = VALUES(apoderado_id), estado = 'autorizado'`,
      [targetAssembly, otorganteId, apoderadoNumId]
    );

    await updateAndBroadcastQuorum(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('powers:updated');
    res.json({ ok: true, message: 'Poder asignado correctamente.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/powers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [p] = await db.query(`SELECT assembly_id FROM poderes WHERE id = ?`, [id]);
    await db.query(`DELETE FROM poderes WHERE id = ?`, [id]);
    if (p.length > 0) {
      await updateAndBroadcastQuorum(p[0].assembly_id);
      io.to(`assembly_${p[0].assembly_id}`).emit('powers:updated');
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/powers/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    const [poderes] = await db.query(
      `SELECT p.id, p.estado, p.documento_url, p.observaciones, p.created_at,
              u_ot.id AS otorgante_num_id, u_ot.identificador_unico AS otorgante_id, u_ot.nombre_completo AS otorgante_nombre, u_ot.coeficiente AS otorgante_coef,
              u_ap.id AS apoderado_num_id, u_ap.identificador_unico AS apoderado_id, u_ap.nombre_completo AS apoderado_nombre
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

app.post('/api/powers', async (req, res) => {
  try {
    const { assemblyId, otorganteUnico, apoderadoUnico, documentoUrl } = req.body;
    const [otorgantes] = await db.query(`SELECT id FROM usuarios WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`, [assemblyId || 1, otorganteUnico.toString().trim().toUpperCase()]);
    const [apoderados] = await db.query(`SELECT id FROM usuarios WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`, [assemblyId || 1, apoderadoUnico.toString().trim().toUpperCase()]);

    if (otorgantes.length === 0) return res.status(400).json({ ok: false, error: 'El otorgante no existe.' });
    if (apoderados.length === 0) return res.status(400).json({ ok: false, error: 'El apoderado no existe.' });

    await db.query(
      `INSERT INTO poderes (assembly_id, otorgante_id, apoderado_id, documento_url, estado) VALUES (?, ?, ?, ?, 'pendiente')`,
      [assemblyId || 1, otorgantes[0].id, apoderados[0].id, documentoUrl]
    );
    io.to(`assembly_${assemblyId || 1}`).emit('powers:updated');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/powers/:powerId/status', async (req, res) => {
  try {
    const { powerId } = req.params;
    const { estado, observaciones } = req.body;
    await db.query(`UPDATE poderes SET estado = ?, observaciones = ? WHERE id = ?`, [estado, observaciones || '', powerId]);
    const [p] = await db.query(`SELECT assembly_id FROM poderes WHERE id = ?`, [powerId]);
    if (p.length > 0) {
      await updateAndBroadcastQuorum(p[0].assembly_id);
      io.to(`assembly_${p[0].assembly_id}`).emit('powers:updated');
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// SUPER ADMIN REST API
app.get('/api/super/assemblies', async (req, res) => {
  try {
    const [asambleas] = await db.query(`SELECT * FROM asambleas ORDER BY id DESC`);
    res.json({ ok: true, asambleas });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/super/assemblies', async (req, res) => {
  try {
    const { nombreCopropiedad, fechaEvento, adminId, adminNombre } = req.body;
    const [resAsamblea] = await db.query(
      `INSERT INTO asambleas (nombre_copropiedad, fecha_evento, estado) VALUES (?, ?, 'en_vivo')`,
      [nombreCopropiedad, fechaEvento || new Date()]
    );
    const newAssemblyId = resAsamblea.insertId;

    if (adminId) {
      await db.query(
        `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, coeficiente, rol)
         VALUES (?, ?, ?, 'Administración', 0.00000, 'administrador')`,
        [newAssemblyId, adminId.toUpperCase(), adminNombre || 'Administrador Asignado']
      );
    }
    res.json({ ok: true, assemblyId: newAssemblyId, message: 'Asamblea creada con éxito.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'online', version: '1.7.6' }));

// CANAL WEBSOCKETS EN TIEMPO REAL
io.on('connection', (socket) => {
  socket.on('auth:join', async ({ assemblyId, identificadorUnico }) => {
    try {
      const targetAssembly = parseInt(assemblyId) || 1;
      const targetId = (identificadorUnico || '').toString().trim().toUpperCase();

      const [rows] = await db.query(
        `SELECT id, identificador_unico, nombre_completo, unidad, coeficiente, rol 
         FROM usuarios WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`,
        [targetAssembly, targetId]
      );

      if (rows.length === 0) return socket.emit('auth:error', 'Identificador no registrado.');

      const user = rows[0];
      const userId = user.id;
      const sessionKey = `${targetAssembly}_${userId}`;

      if (disconnectTimeouts.has(sessionKey)) {
        clearTimeout(disconnectTimeouts.get(sessionKey));
        disconnectTimeouts.delete(sessionKey);
      } else if (activeSessions.has(sessionKey)) {
        const existingSession = activeSessions.get(sessionKey);
        if (existingSession.socketId !== socket.id) {
          io.to(existingSession.socketId).emit('session:invalidated', { message: 'Sesión iniciada desde otro dispositivo.' });
        }
      }

      activeSessions.set(sessionKey, { userId, assemblyId: targetAssembly, socketId: socket.id });
      socket.sessionKey = sessionKey;
      socket.assemblyId = targetAssembly;
      socket.userId = userId;

      const roomName = `assembly_${targetAssembly}`;
      socket.join(roomName);

      const { coefPoderes, representados } = await getUserPowerDetails(userId, targetAssembly);
      user.coeficientePropio = parseFloat(user.coeficiente) || 0;
      user.coeficienteEfectivo = user.coeficientePropio + coefPoderes;
      user.poderesRepresentados = representados;

      socket.emit('auth:success', { user, room: roomName });
      await updateAndBroadcastQuorum(targetAssembly);

      if (activeQuestions.has(targetAssembly)) {
        const activeQ = activeQuestions.get(targetAssembly);
        const [votoUsuario] = await db.query(`SELECT opcion_id FROM votos WHERE pregunta_id = ? AND usuario_id = ?`, [activeQ.id, userId]);
        socket.emit('voting:current_state', { ...activeQ, myCurrentVote: votoUsuario.length > 0 ? votoUsuario[0].opcion_id : null });
      }
    } catch (error) {
      socket.emit('auth:error', 'Error interno al autenticar.');
    }
  });

  socket.on('admin:start_voting', async ({ assemblyId, preguntaId, duracionSegundos }) => {
    try {
      if (timerIntervals.has(assemblyId)) clearInterval(timerIntervals.get(assemblyId));
      await db.query(`UPDATE preguntas SET estado = 'activa' WHERE id = ? AND assembly_id = ?`, [preguntaId, assemblyId]);

      const [preguntas] = await db.query(`SELECT id, texto_pregunta FROM preguntas WHERE id = ?`, [preguntaId]);
      const [opciones] = await db.query(`SELECT id, texto_opcion FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`, [preguntaId]);
      if (preguntas.length === 0) return;

      const duracion = parseInt(duracionSegundos) || 60;
      const activeQData = { id: preguntas[0].id, texto: preguntas[0].texto_pregunta, opciones, duracion, tiempoRestante: duracion, isOpen: true };

      activeQuestions.set(assemblyId, activeQData);
      const roomName = `assembly_${assemblyId}`;

      io.to(roomName).emit('voting:started', activeQData);
      io.to(roomName).emit('questions:updated');

      const interval = setInterval(async () => {
        const currentQ = activeQuestions.get(assemblyId);
        if (!currentQ) { clearInterval(interval); return; }

        currentQ.tiempoRestante -= 1;
        io.to(roomName).emit('timer:tick', { tiempoRestante: currentQ.tiempoRestante });

        if (currentQ.tiempoRestante <= 0) {
          clearInterval(interval);
          timerIntervals.delete(assemblyId);
          currentQ.isOpen = false;

          await db.query(`UPDATE preguntas SET estado = 'cerrada' WHERE id = ?`, [preguntaId]);
          const finalResults = await calculateWeightedResults(assemblyId, preguntaId);

          io.to(roomName).emit('voting:closed', { preguntaId, resultados: finalResults });
          io.to(roomName).emit('questions:updated');
          activeQuestions.delete(assemblyId);
        }
      }, 1000);

      timerIntervals.set(assemblyId, interval);
    } catch (error) {
      console.error('Error al iniciar votación:', error);
    }
  });

  socket.on('admin:stop_voting', async ({ assemblyId, preguntaId }) => {
    try {
      if (timerIntervals.has(assemblyId)) {
        clearInterval(timerIntervals.get(assemblyId));
        timerIntervals.delete(assemblyId);
      }
      const currentQ = activeQuestions.get(assemblyId);
      if (currentQ) { currentQ.isOpen = false; activeQuestions.delete(assemblyId); }

      await db.query(`UPDATE preguntas SET estado = 'cerrada' WHERE id = ? AND assembly_id = ?`, [preguntaId, assemblyId]);
      const finalResults = await calculateWeightedResults(assemblyId, preguntaId);

      const roomName = `assembly_${assemblyId}`;
      io.to(roomName).emit('voting:closed', { preguntaId, resultados: finalResults });
      io.to(roomName).emit('questions:updated');
    } catch (error) {
      console.error('Error al detener votación:', error);
    }
  });

  socket.on('vote:submit', async ({ opcionId }) => {
    const { assemblyId, userId } = socket;
    if (!assemblyId || !userId) return;

    const currentQ = activeQuestions.get(assemblyId);
    if (!currentQ || !currentQ.isOpen) return;

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
        if (disconnectTimeouts.has(sessionKey)) clearTimeout(disconnectTimeouts.get(sessionKey));
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
server.listen(PORT, () => console.log(`🚀 Servidor de Asambleas v1.7.6 corriendo en puerto ${PORT}`));
