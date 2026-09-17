require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] } });

const activeQuestions = new Map();
const timerIntervals = new Map();
const activeSessions = new Map(); // sessionKey -> { userId, assemblyId, socketId, identificadorUnico }
const socketUserMap = new Map();

// BASE DE DATOS AUXILIAR EN MEMORIA EN CASO DE FALLBACK
const memoryDocuments = [];
const memoryChat = [];
const memoryAssemblies = [
  { id: 1, nombre_copropiedad: 'Conjunto Residencial Parque Real', logo_url: 'https://via.placeholder.com/150x40?text=Copropiedad', admin_user: 'ADMIN01' }
];

function toBase64Url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function parseZoomCredentials(rawUrl, manualPasscode) {
  if (!rawUrl || typeof rawUrl !== 'string') return { meetingId: '', passcode: '' };
  const url = rawUrl.trim();
  const meetingIdMatch = url.match(/\/(?:j|wc|embed|join)\/(\d+)/) || url.match(/(\d{9,11})/);
  const meetingId = meetingIdMatch ? meetingIdMatch[1] : url.replace(/\D/g, '');
  const passcode = (manualPasscode || '').trim();
  return { meetingId, passcode };
}

// VERIFICA SI UN USUARIO HA DELEGADO SU VOTO A UN APODERADO AUTORIZADO
async function checkUserRepresentedStatus(userId, assemblyId) {
  try {
    const [rows] = await db.query(
      `SELECT p.id, u_ap.nombre_completo AS apoderado_nombre, u_ap.identificador_unico AS apoderado_id
       FROM poderes p
       JOIN usuarios u_ap ON p.apoderado_id = u_ap.id
       WHERE p.otorgante_id = ? AND p.assembly_id = ? AND p.estado = 'autorizado'`,
      [userId, assemblyId]
    );

    if (rows.length > 0) {
      return { isRepresented: true, apoderadoNombre: rows[0].apoderado_nombre, apoderadoId: rows[0].apoderado_id };
    }
    return { isRepresented: false, apoderadoNombre: null, apoderadoId: null };
  } catch (err) {
    return { isRepresented: false, apoderadoNombre: null, apoderadoId: null };
  }
}

// DETALLE DE PODERES Y CÁLCULO DE COEFICIENTES
async function getUserPowerDetails(userId, assemblyId) {
  try {
    const { isRepresented } = await checkUserRepresentedStatus(userId, assemblyId);

    // Poderes autorizados donde este usuario es APODERADO
    const [aprobados] = await db.query(
      `SELECT p.id AS poder_id, u_ot.identificador_unico, u_ot.nombre_completo, u_ot.unidad, u_ot.coeficiente
       FROM poderes p
       JOIN usuarios u_ot ON p.otorgante_id = u_ot.id
       WHERE p.apoderado_id = ? AND p.assembly_id = ? AND p.estado = 'autorizado'`,
      [userId, assemblyId]
    );

    // Poderes pendientes
    const [pendientes] = await db.query(
      `SELECT p.id AS poder_id, u_ot.identificador_unico, u_ot.nombre_completo, u_ot.unidad, u_ot.coeficiente
       FROM poderes p
       JOIN usuarios u_ot ON p.otorgante_id = u_ot.id
       WHERE p.apoderado_id = ? AND p.assembly_id = ? AND p.estado = 'pendiente'`,
      [userId, assemblyId]
    );

    let coefPoderes = 0;
    const representadosAprobados = aprobados.map(r => {
      const c = parseFloat(r.coeficiente) || 0;
      coefPoderes += c;
      return { id: r.poder_id, identificador: r.identificador_unico, nombre: r.nombre_completo, unidad: r.unidad, coeficiente: c, estado: 'autorizado' };
    });

    const representadosPendientes = pendientes.map(r => {
      return { id: r.poder_id, identificador: r.identificador_unico, nombre: r.nombre_completo, unidad: r.unidad, coeficiente: parseFloat(r.coeficiente) || 0, estado: 'pendiente' };
    });

    return { coefPoderes, representadosAprobados, representadosPendientes, isRepresented };
  } catch (err) {
    return { coefPoderes: 0, representadosAprobados: [], representadosPendientes: [], isRepresented: false };
  }
}

async function getUserEffectiveCoefficient(userId, assemblyId) {
  const { isRepresented } = await checkUserRepresentedStatus(userId, assemblyId);
  if (isRepresented) return 0;

  const [u] = await db.query(`SELECT coeficiente, rol FROM usuarios WHERE id = ?`, [userId]);
  if (u.length === 0) return 0;
  if (u[0].rol === 'soporte') return 0;

  const propio = parseFloat(u[0].coeficiente) || 0;
  const { coefPoderes } = await getUserPowerDetails(userId, assemblyId);
  return propio + coefPoderes;
}

async function updateAndBroadcastQuorum(assemblyId) {
  try {
    const activeUserIds = new Set();
    for (const [key, session] of activeSessions.entries()) {
      if (session.assemblyId === parseInt(assemblyId)) {
        activeUserIds.add(session.userId);
      }
    }

    if (activeUserIds.size === 0) {
      io.to(`assembly_${assemblyId}`).emit('quorum:update', { quorumPercentage: "0.0000" });
      return;
    }

    let totalQuorum = 0;
    for (let uId of activeUserIds) {
      totalQuorum += await getUserEffectiveCoefficient(uId, assemblyId);
    }
    // CORRECCIÓN: Los coeficientes en la BD ya se encuentran en escala base 100
    const quorumPercentage = totalQuorum.toFixed(4);
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

// REST API: ASAMBLEAS ACTIVAS PARA LANDING PAGE
app.get(['/api/assemblies', '/api/assemblies/active'], async (req, res) => {
  try {
    try {
      const [rows] = await db.query(`SELECT id, nombre_copropiedad, logo_url, estado FROM asambleas ORDER BY id DESC`);
      return res.json({ ok: true, asambleas: rows, assemblies: rows });
    } catch (e) {
      return res.json({ ok: true, asambleas: memoryAssemblies, assemblies: memoryAssemblies });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: CREAR USUARIO DE SOPORTE PERMANENTE
app.post('/api/support-users', async (req, res) => {
  try {
    const { assemblyId, identificadorUnico, nombreCompleto } = req.body;
    const targetId = identificadorUnico.trim().toUpperCase();

    try {
      await db.query(
        `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, coeficiente, rol)
         VALUES (?, ?, ?, 'SOPORTE', 0.00000, 'soporte')
         ON DUPLICATE KEY UPDATE rol = 'soporte', nombre_completo = VALUES(nombre_completo)`,
        [assemblyId || 1, targetId, nombreCompleto || 'Soporte Técnico']
      );
      res.json({ ok: true, message: `Usuario de soporte ${targetId} creado correctamente.` });
    } catch (e) {
      res.json({ ok: true, message: `Usuario de soporte ${targetId} registrado.` });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: SUPER ADMINISTRADOR
app.get('/api/superadmin/assemblies', async (req, res) => {
  try {
    try {
      const [rows] = await db.query(`SELECT * FROM asambleas ORDER BY id DESC`);
      return res.json({ ok: true, asambleas: rows });
    } catch (e) {
      return res.json({ ok: true, asambleas: memoryAssemblies });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/superadmin/assemblies', async (req, res) => {
  try {
    const { nombreCopropiedad, logoBase64, adminIdentificador, zoomEmbedUrl, zoomPasscode } = req.body;
    const logoUrl = logoBase64 || 'https://via.placeholder.com/150x40?text=Copropiedad';
    const parsed = parseZoomCredentials(zoomEmbedUrl, zoomPasscode);

    // Se incluye fecha_evento (NOW()) para cumplir la restricción NOT NULL de la tabla asambleas
    const [result] = await db.query(
      `INSERT INTO asambleas (nombre_copropiedad, logo_url, fecha_evento, estado, zoom_embed_url, zoom_meeting_id, zoom_passcode, zoom_password) 
       VALUES (?, ?, NOW(), 'programada', ?, ?, ?, ?)`,
      [nombreCopropiedad, logoUrl, zoomEmbedUrl || '', parsed.meetingId, parsed.passcode, parsed.passcode]
    );
    const assemblyId = result.insertId;

    if (adminIdentificador && adminIdentificador.trim() !== '') {
      await db.query(
        `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, coeficiente, rol)
         VALUES (?, ?, 'Administrador Copropiedad', 'ADMIN', 0.00000, 'administrador')
         ON DUPLICATE KEY UPDATE rol = 'administrador'`,
        [assemblyId, adminIdentificador.trim().toUpperCase()]
      );
    }

    await db.query(
      `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, coeficiente, rol)
       VALUES (?, ?, 'Soporte Técnico', 'SOPORTE', 0.00000, 'soporte')
       ON DUPLICATE KEY UPDATE rol = 'soporte'`,
      [assemblyId, `SOPORTE-${assemblyId}`]
    );

    io.emit('assemblies:updated');
    return res.json({ ok: true, assemblyId, message: 'Asamblea creada con éxito.' });
  } catch (err) {
    console.error('Error crítico al crear asamblea en MySQL:', err);
    return res.status(500).json({ ok: false, error: `Error SQL: ${err.message}` });
  }
});

app.post('/api/superadmin/assign-role', async (req, res) => {
  try {
    const { assemblyId, identificadorUnico, nombreCompleto, rol } = req.body;
    const targetId = identificadorUnico.trim().toUpperCase();
    await db.query(
      `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, coeficiente, rol)
       VALUES (?, ?, ?, 'DIRECTIVA', 0.00000, ?)
       ON DUPLICATE KEY UPDATE rol = VALUES(rol), nombre_completo = VALUES(nombre_completo)`,
      [assemblyId || 1, targetId, nombreCompleto || 'Directiva', rol || 'administrador']
    );
    res.json({ ok: true, message: `Rol ${rol} asignado exitosamente a ${targetId}.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: CARGA MASIVA DE PADRÓN ELECTORAL (ASISTENTES VÍA EXCEL / CSV)
app.post('/api/superadmin/users/bulk', async (req, res) => {
  try {
    const { assemblyId, users } = req.body;
    if (!assemblyId || !Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ ok: false, error: 'Asamblea inválida o lista de usuarios vacía.' });
    }

    let count = 0;
    for (const u of users) {
      const idUnico = (u.identificadorUnico || u.identificador_unico || u.ID || u.id || u.Identificador || '').toString().trim().toUpperCase();
      const nombre = (u.nombreCompleto || u.nombre_completo || u.Nombre || u.nombre || '').toString().trim();
      const unidad = (u.unidad || u.Unidad || u.apto || u.Apto || u.Torre || '---').toString().trim();
      const email = (u.email || u.Email || '').toString().trim();
      
      let coefRaw = u.coeficiente !== undefined ? u.coeficiente : u.Coeficiente;
      let coef = parseFloat(coefRaw);
      if (isNaN(coef)) coef = 0.00000;

      if (!idUnico) continue;

      await db.query(
        `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, email, coeficiente, rol)
         VALUES (?, ?, ?, ?, ?, ?, 'asistente')
         ON DUPLICATE KEY UPDATE 
           nombre_completo = VALUES(nombre_completo),
           unidad = VALUES(unidad),
           email = VALUES(email),
           coeficiente = VALUES(coeficiente)`,
        [assemblyId, idUnico, nombre || idUnico, unidad, email, coef]
      );
      count++;
    }

    io.to(`assembly_${assemblyId}`).emit('users:updated');
    return res.json({ ok: true, count, message: `Se cargaron ${count} asistentes con éxito.` });
  } catch (err) {
    console.error('Error en carga masiva:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: BRANDING Y DETALLES DE ASAMBLEA
app.get('/api/assemblies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(`SELECT id, nombre_copropiedad, logo_url, zoom_embed_url, zoom_meeting_id, zoom_passcode FROM asambleas WHERE id = ?`, [id]);
    if (rows.length === 0) {
      return res.json({
        ok: true,
        assembly: { id: 1, nombre_copropiedad: 'Asamblea General', logo_url: 'https://via.placeholder.com/150x40?text=Copropiedad' }
      });
    }
    res.json({ ok: true, assembly: rows[0] });
  } catch (err) {
    res.json({ ok: true, assembly: { id: 1, nombre_copropiedad: 'Asamblea General', logo_url: 'https://via.placeholder.com/150x40?text=Copropiedad' } });
  }
});

app.put('/api/assemblies/:id/info', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombreCopropiedad, logoBase64 } = req.body;
    await db.query(`UPDATE asambleas SET nombre_copropiedad = ?, logo_url = ? WHERE id = ?`, [nombreCopropiedad, logoBase64, id]);
    io.to(`assembly_${id}`).emit('assembly:updated', { nombreCopropiedad, logoUrl: logoBase64 });
    res.json({ ok: true, message: 'Información de copropiedad actualizada.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: REPOSITORIO DE DOCUMENTOS DESDE EXPLORADOR DE ARCHIVOS
app.get('/api/documents/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    try {
      const [rows] = await db.query(`SELECT id, titulo, archivo_url, created_at FROM documentos WHERE assembly_id = ? ORDER BY created_at DESC`, [assemblyId]);
      return res.json({ ok: true, documentos: rows });
    } catch (e) {
      const docs = memoryDocuments.filter(d => d.assemblyId == assemblyId);
      return res.json({ ok: true, documentos: docs });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/documents', async (req, res) => {
  try {
    const { assemblyId, titulo, archivoBase64 } = req.body;
    const targetAssembly = assemblyId || 1;
    try {
      await db.query(`INSERT INTO documentos (assembly_id, titulo, archivo_url) VALUES (?, ?, ?)`, [targetAssembly, titulo, archivoBase64]);
    } catch (e) {
      memoryDocuments.push({ id: Date.now(), assemblyId: targetAssembly, titulo, archivo_url: archivoBase64, created_at: new Date() });
    }
    io.to(`assembly_${targetAssembly}`).emit('documents:updated');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/documents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    try {
      await db.query(`DELETE FROM documentos WHERE id = ?`, [id]);
    } catch (e) {
      const idx = memoryDocuments.findIndex(d => d.id == id);
      if (idx !== -1) memoryDocuments.splice(idx, 1);
    }
    io.to(`assembly_1`).emit('documents:updated');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: PREGUNTAS Y OPCIONES
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

app.get('/api/questions/detail/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [preguntas] = await db.query(`SELECT * FROM preguntas WHERE id = ?`, [id]);
    if (preguntas.length === 0) return res.status(404).json({ ok: false, error: 'Pregunta no encontrada' });
    const [opciones] = await db.query(`SELECT * FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`, [id]);
    preguntas[0].opciones = opciones;
    res.json({ ok: true, pregunta: preguntas[0] });
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
    res.json({ ok: true, message: 'Pregunta actualizada exitosamente.' });
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

// REST API: PODERES Y USUARIOS
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

app.put('/api/powers/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { estado, observaciones } = req.body;
    const [p] = await db.query(`SELECT assembly_id FROM poderes WHERE id = ?`, [id]);
    if (p.length === 0) return res.status(404).json({ ok: false, error: 'Poder no encontrado' });

    await db.query(`UPDATE poderes SET estado = ?, observaciones = ? WHERE id = ?`, [estado, observaciones || '', id]);

    const targetAssembly = p[0].assembly_id;
    await updateAndBroadcastQuorum(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('powers:updated');
    res.json({ ok: true, message: `Poder ${estado} correctamente.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

app.get('/api/reports/assembly/:id/excel', async (req, res) => {
  try {
    const { id } = req.params;
    const [votos] = await db.query(
      `SELECT p.texto_pregunta AS Pregunta, u.identificador_unico AS ID_Votante, u.nombre_completo AS Nombre, u.unidad AS Unidad, o.texto_opcion AS Opcion_Votada, v.coeficiente_aplicado AS Coeficiente_Efectivo, v.created_at AS Fecha_Hora_Voto
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
      // CORRECCIÓN: Los coeficientes en la BD ya se encuentran en escala base 100
      const coefPct = parseFloat(v.Coeficiente_Efectivo).toFixed(4);
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

// REST API: FIRMAS ZOOM
app.post('/api/zoom/signature', (req, res) => {
  try {
    const { meetingNumber, role } = req.body;
    const sdkKey = process.env.ZOOM_SDK_KEY || 'az3IqLFfQTiiF7dYI6Ka2w';
    const sdkSecret = process.env.ZOOM_SDK_SECRET || 'HUJ1kfoykJu5CXGMl5ZXn2txqnS5iPM6';

    const cleanMn = parseInt((meetingNumber || '').toString().replace(/\D/g, ''), 10);
    if (!cleanMn || isNaN(cleanMn)) return res.status(400).json({ ok: false, error: 'ID Zoom Inválido.' });

    const iat = Math.floor(Date.now() / 1000) - 30;
    const exp = iat + 60 * 60 * 2;

    const oHeader = { alg: 'HS256', typ: 'JWT' };
    const oPayload = { sdkKey, appKey: sdkKey, mn: cleanMn, role: parseInt(role || 0, 10), iat, exp, tokenExp: exp };

    const sHeader = toBase64Url(JSON.stringify(oHeader));
    const sPayload = toBase64Url(JSON.stringify(oPayload));
    const dataToSign = `${sHeader}.${sPayload}`;
    const hmac = crypto.createHmac('sha256', sdkSecret).update(dataToSign).digest();
    const signature = toBase64Url(hmac);

    res.json({ ok: true, signature: `${dataToSign}.${signature}`, sdkKey });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/assemblies/:id/zoom', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(`SELECT zoom_embed_url, zoom_meeting_id, zoom_passcode FROM asambleas WHERE id = ?`, [id]);
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Asamblea no encontrada' });
    const parsed = parseZoomCredentials(rows[0].zoom_embed_url, rows[0].zoom_passcode);
    res.json({ ok: true, zoom: { rawUrl: rows[0].zoom_embed_url, meetingId: rows[0].zoom_meeting_id || parsed.meetingId, passcode: rows[0].zoom_passcode || parsed.passcode } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/assemblies/:id/zoom', async (req, res) => {
  try {
    const { id } = req.params;
    const { zoomEmbedUrl, zoomPasscode } = req.body;
    const parsed = parseZoomCredentials(zoomEmbedUrl, zoomPasscode);
    await db.query(`UPDATE asambleas SET zoom_embed_url = ?, zoom_meeting_id = ?, zoom_passcode = ? WHERE id = ?`, [zoomEmbedUrl, parsed.meetingId, parsed.passcode, id]);
    const streamData = { meetingId: parsed.meetingId, passcode: parsed.passcode, rawUrl: zoomEmbedUrl };
    io.to(`assembly_${id}`).emit('zoom:updated', { streamInfo: streamData });
    res.json({ ok: true, message: 'Zoom actualizado.', streamInfo: streamData });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'online', version: '3.0.0-master' }));

// WEBSOCKETS EN TIEMPO REAL CON VALIDACIÓN ESTRICTA DE DUPLICADOS DE VOTO Y DESCONEXIÓN
io.on('connection', (socket) => {

  socket.on('auth:join', async ({ assemblyId, identificadorUnico }) => {
    try {
      const targetAssembly = parseInt(assemblyId) || 1;
      const targetId = (identificadorUnico || '').toString().trim().toUpperCase();

      let [rows] = await db.query(
        `SELECT id, identificador_unico, nombre_completo, unidad, coeficiente, rol FROM usuarios WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`,
        [targetAssembly, targetId]
      );

      // SOPORTE DINÁMICO EN CASO DE INGRESAR CON CÓDIGO DE SOPORTE SINO EXISTÍA
      if (rows.length === 0 && targetId.startsWith('SOPORTE')) {
        const [ins] = await db.query(
          `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, coeficiente, rol)
           VALUES (?, ?, 'Soporte Técnico', 'SOPORTE', 0.00000, 'soporte')`,
          [targetAssembly, targetId]
        );
        rows = [{ id: ins.insertId, identificador_unico: targetId, nombre_completo: 'Soporte Técnico', unidad: 'SOPORTE', coeficiente: 0.00000, rol: 'soporte' }];
      }

      if (rows.length === 0) return socket.emit('auth:error', 'Identificador no registrado.');

      const user = rows[0];
      const userId = user.id;
      const sessionKey = `${targetAssembly}_${userId}`;

      if (activeSessions.has(sessionKey)) {
        const existingSession = activeSessions.get(sessionKey);
        if (existingSession.socketId !== socket.id) {
          io.to(existingSession.socketId).emit('auth:kicked', { message: 'Tu sesión ha sido iniciada en otro dispositivo.' });
        }
      }

      activeSessions.set(sessionKey, { userId, assemblyId: targetAssembly, socketId: socket.id, identificadorUnico: targetId });
      socketUserMap.set(socket.id, sessionKey);

      socket.sessionKey = sessionKey;
      socket.assemblyId = targetAssembly;
      socket.userId = userId;

      const roomName = `assembly_${targetAssembly}`;
      socket.join(roomName);

      const { coefPoderes, representadosAprobados, representadosPendientes, isRepresented } = await getUserPowerDetails(userId, targetAssembly);
      user.coeficientePropio = parseFloat(user.coeficiente) || 0;
      user.coeficientePoderes = coefPoderes;
      user.coeficienteEfectivo = (isRepresented || user.rol === 'soporte') ? 0 : (user.coeficientePropio + coefPoderes);
      user.isRepresented = isRepresented;
      user.poderesAprobados = representadosAprobados;
      user.poderesPendientes = representadosPendientes;

      socket.emit('auth:success', { user, room: roomName });
      await updateAndBroadcastQuorum(targetAssembly);

      if (activeQuestions.has(targetAssembly)) {
        const activeQ = activeQuestions.get(targetAssembly);
        const [votoUsuario] = await db.query(`SELECT opcion_id FROM votos WHERE pregunta_id = ? AND usuario_id = ?`, [activeQ.id, userId]);
        socket.emit('voting:current_state', { ...activeQ, myCurrentVote: votoUsuario.length > 0 ? votoUsuario[0].opcion_id : null });
      }
    } catch (error) {
      socket.emit('auth:error', 'Error al autenticar.');
    }
  });

  socket.on('chat:message', ({ texto, emisor, unidad }) => {
    const targetAssembly = socket.assemblyId || 1;
    const msgData = {
      id: Date.now(),
      texto,
      emisor: emisor || 'Asistente',
      unidad: unidad || '---',
      hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
    };
    memoryChat.push(msgData);
    if (memoryChat.length > 100) memoryChat.shift();
    io.to(`assembly_${targetAssembly}`).emit('chat:broadcast', msgData);
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

  // BLOQUEO ABSOLUTO DE VOTO PARA USUARIOS REPRESENTADOS O SOPORTE
  socket.on('vote:submit', async ({ opcionId }) => {
    const { assemblyId, userId } = socket;
    if (!assemblyId || !userId) return;

    const currentQ = activeQuestions.get(assemblyId);
    if (!currentQ || !currentQ.isOpen) return;

    try {
      const { isRepresented, apoderadoNombre } = await checkUserRepresentedStatus(userId, assemblyId);
      if (isRepresented) {
        return socket.emit('vote:rejected', { message: `No puedes votar directamente. Tus derechos de voto están delegados por poder autorizado a ${apoderadoNombre}.` });
      }

      const efCoef = await getUserEffectiveCoefficient(userId, assemblyId);
      if (efCoef <= 0) {
        return socket.emit('vote:rejected', { message: 'Tu coeficiente habilitado de voto es 0.0000%.' });
      }

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

  // ACTUALIZACIÓN INMEDIATA DEL QUÓRUM CUANDO CUALQUIER NAVEGADOR O PESTAÑA SE DESCONECTA
  socket.on('disconnect', async () => {
    if (socket.sessionKey && activeSessions.has(socket.sessionKey)) {
      const sessionData = activeSessions.get(socket.sessionKey);
      if (sessionData.socketId === socket.id) {
        activeSessions.delete(socket.sessionKey);
        socketUserMap.delete(socket.id);
        await updateAndBroadcastQuorum(sessionData.assemblyId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor de Asambleas v3.0.0-master corriendo en puerto ${PORT}`));
