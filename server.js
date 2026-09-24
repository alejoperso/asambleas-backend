require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { Resend } = require('resend');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] } });

// CONFIGURACIÓN DE CREDENCIALES MAESTRAS DE SUPERADMIN
const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'contacto@ajaudiovisual.com';
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || 'Alfaleon2030';

// INICIALIZACIÓN DE RESEND CON API KEY
const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy_key');

const activeQuestions = new Map();
const timerIntervals = new Map();
const activeSessions = new Map();
const socketUserMap = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// MIGRACIÓN AUTOMÁTICA SEGURA DE ESQUEMA COMPLETO (7 TABLAS DE SISTEMA)
async function initDbSchema() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS asambleas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre_copropiedad VARCHAR(255) NOT NULL,
        logo_url LONGTEXT NULL,
        estado VARCHAR(50) DEFAULT 'programada',
        zoom_embed_url LONGTEXT NULL,
        zoom_meeting_id VARCHAR(100) NULL,
        zoom_passcode VARCHAR(100) NULL,
        zoom_password VARCHAR(100) NULL,
        fecha_evento DATE NULL,
        hora_inicio DATETIME NULL,
        hora_cierre DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        assembly_id INT NOT NULL,
        identificador_unico VARCHAR(100) NOT NULL,
        nombre_completo VARCHAR(255) NOT NULL,
        unidad VARCHAR(100) DEFAULT '---',
        email VARCHAR(255) NULL,
        password VARCHAR(255) NULL,
        coeficiente DECIMAL(10,5) DEFAULT 0.00000,
        rol VARCHAR(50) NOT NULL DEFAULT 'asistente',
        estado VARCHAR(20) DEFAULT 'activo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY idx_assembly_user (assembly_id, identificador_unico)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS preguntas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        assembly_id INT NOT NULL,
        texto_pregunta TEXT NOT NULL,
        duracion_segundos INT DEFAULT 60,
        estado VARCHAR(20) DEFAULT 'borrador',
        orden INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS opciones_pregunta (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pregunta_id INT NOT NULL,
        texto_opcion VARCHAR(255) NOT NULL,
        orden INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS votos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        assembly_id INT NOT NULL,
        pregunta_id INT NOT NULL,
        usuario_id INT NOT NULL,
        opcion_id INT NOT NULL,
        coeficiente_aplicado DECIMAL(10,5) NOT NULL DEFAULT 0.00000,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY idx_user_question (pregunta_id, usuario_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS poderes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        assembly_id INT NOT NULL,
        otorgante_id INT NOT NULL,
        apoderado_id INT NOT NULL,
        documento_url LONGTEXT NULL,
        estado VARCHAR(20) DEFAULT 'pendiente',
        observaciones TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY idx_otorgante_assembly (assembly_id, otorgante_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS documentos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        assembly_id INT NOT NULL,
        titulo VARCHAR(255) NOT NULL,
        archivo_url LONGTEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS usuarios_admin (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre_completo VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        rol VARCHAR(50) DEFAULT 'superadmin',
        estado VARCHAR(20) DEFAULT 'activo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const alterQueries = [
      `ALTER TABLE usuarios MODIFY COLUMN rol VARCHAR(50) NOT NULL DEFAULT 'asistente'`,
      `ALTER TABLE asambleas ADD COLUMN fecha_evento DATE NULL`,
      `ALTER TABLE asambleas ADD COLUMN hora_inicio DATETIME NULL`,
      `ALTER TABLE asambleas ADD COLUMN hora_cierre DATETIME NULL`
    ];
    for (const q of alterQueries) {
      try {
        await db.query(q);
      } catch (e) {}
    }
    console.log('✅ Verificación y migración completa de las 7 tablas de base de datos.');
  } catch (err) {
    console.warn('Advertencia en verificación de esquema:', err.message);
  }
}
initDbSchema();

function generateAlphanumericPassword(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

const memoryDocuments = [];
const memoryChat = [];
const memoryAssemblies = [
  { id: 1, nombre_copropiedad: 'Conjunto Residencial Parque Real', logo_url: 'https://via.placeholder.com/150x40?text=Copropiedad', admin_user: 'ADMIN01', estado: 'programada' }
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

async function getUserPowerDetails(userId, assemblyId) {
  try {
    const { isRepresented } = await checkUserRepresentedStatus(userId, assemblyId);

    const [aprobados] = await db.query(
      `SELECT p.id AS poder_id, u_ot.identificador_unico, u_ot.nombre_completo, u_ot.unidad, u_ot.coeficiente
       FROM poderes p
       JOIN usuarios u_ot ON p.otorgante_id = u_ot.id
       WHERE p.apoderado_id = ? AND p.assembly_id = ? AND p.estado = 'autorizado'`,
      [userId, assemblyId]
    );

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
    const activeList = [];
    const activeUserIds = new Set();
    
    for (const [key, session] of activeSessions.entries()) {
      if (session.assemblyId === parseInt(assemblyId)) {
        activeUserIds.add(session.userId);
        activeList.push({
          userId: session.userId,
          identificadorUnico: session.identificadorUnico,
          nombreCompleto: session.nombreCompleto,
          unidad: session.unidad,
          rol: session.rol
        });
      }
    }

    let totalQuorum = 0;
    if (activeUserIds.size > 0) {
      for (let uId of activeUserIds) {
        totalQuorum += await getUserEffectiveCoefficient(uId, assemblyId);
      }
    }

    const quorumPercentage = totalQuorum.toFixed(4);
    
    // Broadcast Quórum y Lista en Tiempo Real de Conectados
    io.to(`assembly_${assemblyId}`).emit('quorum:update', { quorumPercentage });
    io.to(`assembly_${assemblyId}`).emit('users:connected_update', { total: activeList.length, usuarios: activeList });
  } catch (err) {
    console.error('Error calculando quórum:', err);
  }
}

async function getVotingStats(assemblyId, preguntaId) {
  try {
    const rawActiveUserIds = new Set();
    for (const [key, session] of activeSessions.entries()) {
      if (session.assemblyId === parseInt(assemblyId)) {
        rawActiveUserIds.add(session.userId);
      }
    }

    // Calcular cuántos inmuebles/unidades con coeficiente efectivomente habilitado están presentes
    let totalConectados = 0;
    for (const uId of rawActiveUserIds) {
      const { isRepresented } = await checkUserRepresentedStatus(uId, assemblyId);
      if (isRepresented) continue;

      const [u] = await db.query(`SELECT coeficiente, rol FROM usuarios WHERE id = ?`, [uId]);
      if (u.length === 0 || u[0].rol === 'soporte') continue;

      const propioCoef = parseFloat(u[0].coeficiente) || 0;
      if (propioCoef > 0) {
        totalConectados += 1;
      }

      const { representadosAprobados } = await getUserPowerDetails(uId, assemblyId);
      if (representadosAprobados && representadosAprobados.length > 0) {
        for (const rep of representadosAprobados) {
          if ((parseFloat(rep.coeficiente) || 0) > 0) {
            totalConectados += 1;
          }
        }
      }
    }

    // Contar únicamente votos registrados con coeficiente_aplicado > 0
    const [rows] = await db.query(
      `SELECT COUNT(DISTINCT usuario_id) AS totalVotaron FROM votos WHERE assembly_id = ? AND pregunta_id = ? AND coeficiente_aplicado > 0`,
      [assemblyId, preguntaId]
    );
    const hanVotado = rows[0] ? parseInt(rows[0].totalVotaron) || 0 : 0;
    const faltanPorVotar = Math.max(0, totalConectados - hanVotado);

    return { totalConectados, hanVotado, faltanPorVotar };
  } catch (err) {
    return { totalConectados: 0, hanVotado: 0, faltanPorVotar: 0 };
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

// REST API: LOGIN DE ADMINISTRACIÓN Y SUPERADMIN
app.post('/api/auth/admin-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Correo y contraseña requeridos.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanPass = password.trim();

    if (cleanEmail === SUPERADMIN_EMAIL.toLowerCase() && cleanPass === SUPERADMIN_PASSWORD) {
      const token = Buffer.from(`superadmin_${Date.now()}`).toString('base64');
      return res.json({
        ok: true,
        user: {
          id: 0,
          nombre_completo: 'Super Administrador',
          email: SUPERADMIN_EMAIL,
          rol: 'superadmin',
          assembly_id: null
        },
        token
      });
    }

    const [rows] = await db.query(
      `SELECT id, assembly_id, identificador_unico, nombre_completo, email, password, rol 
       FROM usuarios 
       WHERE LOWER(email) = ? AND rol IN ('administrador', 'soporte', 'moderador', 'representante_legal')`,
      [cleanEmail]
    );

    if (rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Credenciales inválidas o sin permisos de gestión.' });
    }

    const adminUser = rows[0];
    if (!adminUser.password || adminUser.password.trim() === '') {
      return res.status(401).json({ ok: false, error: 'El usuario no tiene una contraseña configurada.' });
    }

    const isMatch = await bcrypt.compare(cleanPass, adminUser.password);
    if (!isMatch) {
      return res.status(401).json({ ok: false, error: 'Contraseña incorrecta.' });
    }

    const token = Buffer.from(`${adminUser.rol}_${adminUser.id}_${Date.now()}`).toString('base64');
    return res.json({
      ok: true,
      user: {
        id: adminUser.id,
        nombre_completo: adminUser.nombre_completo,
        email: adminUser.email,
        rol: adminUser.rol,
        assembly_id: adminUser.assembly_id,
        identificador_unico: adminUser.identificador_unico
      },
      token
    });
  } catch (err) {
    console.error('Error en admin-login:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API SUPERADMIN: GESTIÓN GLOBAL DE USUARIOS DE CONTROL
app.get('/api/superadmin/admin-users', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.id, u.assembly_id, u.identificador_unico, u.nombre_completo, u.email, u.rol, u.created_at, a.nombre_copropiedad
       FROM usuarios u
       LEFT JOIN asambleas a ON u.assembly_id = a.id
       WHERE u.rol IN ('administrador', 'soporte', 'moderador', 'representante_legal')
       ORDER BY u.id DESC`
    );
    res.json({ ok: true, adminUsers: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/superadmin/admin-users', async (req, res) => {
  try {
    const { assemblyId, nombreCompleto, email, password, rol } = req.body;

    if (!email || !rol) {
      return res.status(400).json({ ok: false, error: 'Correo y rol son obligatorios.' });
    }

    const validRoles = ['administrador', 'soporte', 'moderador', 'representante_legal'];
    if (!validRoles.includes(rol)) {
      return res.status(400).json({ ok: false, error: 'Rol no válido.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = (nombreCompleto || 'Usuario Gestión').trim();
    const targetAssembly = parseInt(assemblyId) || 1;
    const identificadorUnico = `${rol.toUpperCase()}-${Date.now().toString().slice(-4)}`;

    let hashedPassword = null;
    if (password && password.trim() !== '') {
      const salt = await bcrypt.genSalt(10);
      hashedPassword = await bcrypt.hash(password.trim(), salt);
    }

    if (hashedPassword) {
      await db.query(
        `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, email, password, coeficiente, rol)
         VALUES (?, ?, ?, 'GESTIÓN', ?, ?, 0.00000, ?)
         ON DUPLICATE KEY UPDATE 
           nombre_completo = VALUES(nombre_completo),
           password = VALUES(password),
           rol = VALUES(rol),
           assembly_id = VALUES(assembly_id)`,
        [targetAssembly, identificadorUnico, cleanName, cleanEmail, hashedPassword, rol]
      );
    } else {
      await db.query(
        `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, email, password, coeficiente, rol)
         VALUES (?, ?, ?, 'GESTIÓN', ?, '', 0.00000, ?)
         ON DUPLICATE KEY UPDATE 
           nombre_completo = VALUES(nombre_completo),
           rol = VALUES(rol),
           assembly_id = VALUES(assembly_id)`,
        [targetAssembly, identificadorUnico, cleanName, cleanEmail, rol]
      );
    }

    res.json({ ok: true, message: `Usuario con rol [${rol}] guardado correctamente.` });
  } catch (err) {
    console.error('Error al crear/actualizar admin user:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ENVIAR CORREO CON CREDENCIALES AL PERSONAL DE CONTROL
app.post('/api/superadmin/admin-users/send-credential', async (req, res) => {
  try {
    const { userId, customPassword } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'ID de usuario requerido.' });

    const [usuarios] = await db.query(
      `SELECT u.id, u.identificador_unico, u.nombre_completo, u.email, u.rol, u.assembly_id, a.nombre_copropiedad 
       FROM usuarios u 
       LEFT JOIN asambleas a ON u.assembly_id = a.id 
       WHERE u.id = ?`,
      [userId]
    );

    if (usuarios.length === 0) {
      return res.status(404).json({ ok: false, error: 'Usuario de control no encontrado.' });
    }

    const user = usuarios[0];
    if (!user.email || user.email.trim() === '') {
      return res.status(400).json({ ok: false, error: 'El usuario no tiene un correo electrónico registrado.' });
    }

    const plainPassword = (customPassword && customPassword.trim() !== '') 
      ? customPassword.trim() 
      : generateAlphanumericPassword(8);

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(plainPassword, salt);

    await db.query(`UPDATE usuarios SET password = ? WHERE id = ?`, [hashedPassword, user.id]);

    const clientUrl = process.env.CLIENT_URL || req.headers.origin || 'https://asambleas.ajaudiovisual.com';
    const adminUrl = `${clientUrl}/admin.html?asamblea=${user.assembly_id || 1}`;
    const fromSender = process.env.RESEND_FROM_EMAIL || 'contacto@ajaudiovisual.com';
    const copropiedadNombre = user.nombre_copropiedad || 'Asamblea Virtual';
    const rolNombre = user.rol === 'administrador' ? 'Administrador' : user.rol === 'moderador' ? 'Moderador' : 'Soporte Técnico';

    const emailResult = await resend.emails.send({
      from: `Plataforma Asambleas <${fromSender}>`,
      to: [user.email],
      subject: `Acceso Panel de Control (${rolNombre}) - ${copropiedadNombre}`,
      text: `Estimado(a) ${user.nombre_completo}, se te han asignado permisos de ${rolNombre} para ${copropiedadNombre}. URL: ${adminUrl} | Usuario: ${user.email} | Contraseña: ${plainPassword}`,
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 25px; border-radius: 12px; max-width: 600px; margin: auto;">
          <h2 style="color: #6366f1; text-align: center; margin-bottom: 20px;">Acceso a Consola de Control</h2>
          <p style="font-size: 14px; line-height: 1.6;">Estimado(a) <strong>${user.nombre_completo}</strong>,</p>
          <p style="font-size: 14px; line-height: 1.6;">Se le han otorgado credenciales de acceso como <strong>${rolNombre}</strong> para la gestión de <strong>${copropiedadNombre}</strong>.</p>
          
          <div style="background-color: #1e293b; padding: 18px; border-radius: 8px; border-left: 4px solid #6366f1; margin: 20px 0;">
            <p style="margin: 6px 0; font-size: 14px;"><strong>Enlace de Control:</strong> <a href="${adminUrl}" style="color: #38bdf8; word-break: break-all;">${adminUrl}</a></p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Usuario (Correo):</strong> <span style="color: #f1f5f9; font-weight: bold;">${user.email}</span></p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Contraseña Asignada:</strong> <span style="background-color: #334155; padding: 3px 8px; border-radius: 4px; font-family: monospace; font-size: 16px; color: #facc15;">${plainPassword}</span></p>
          </div>

          <p style="font-size: 12px; color: #64748b; text-align: center; margin-top: 30px; border-top: 1px solid #334155; padding-top: 15px;">
            Mensaje automático del Sistema de Asambleas Virtuales.
          </p>
        </div>
      `
    });

    if (emailResult.error) {
      return res.status(500).json({ ok: false, error: emailResult.error.message });
    }

    return res.json({
      ok: true,
      message: `Credenciales de control enviadas a ${user.email}.`,
      plainPassword: plainPassword
    });

  } catch (err) {
    console.error('Error enviando credencial de control:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/superadmin/admin-users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query(`DELETE FROM usuarios WHERE id = ? AND rol IN ('administrador', 'soporte', 'moderador', 'representante_legal')`, [id]);
    res.json({ ok: true, message: 'Usuario de gestión eliminado.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: ASAMBLEAS ACTIVAS
app.get(['/api/assemblies', '/api/assemblies/active'], async (req, res) => {
  try {
    try {
      const [rows] = await db.query(`SELECT * FROM asambleas ORDER BY id DESC`);
      return res.json({ ok: true, asambleas: rows, assemblies: rows });
    } catch (e) {
      return res.json({ ok: true, asambleas: memoryAssemblies, assemblies: memoryAssemblies });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/assemblies/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date();
    try {
      await db.query(`UPDATE asambleas SET estado = 'en_curso', hora_inicio = NOW() WHERE id = ?`, [id]);
    } catch (e) {
      await db.query(`UPDATE asambleas SET estado = 'en_curso' WHERE id = ?`, [id]);
    }

    const roomName = `assembly_${id}`;
    io.to(roomName).emit('assembly:started', {
      message: '¡La Asamblea ha iniciado oficialmente!',
      horaInicio: now.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    });
    io.emit('assemblies:updated');

    res.json({ ok: true, message: 'Asamblea iniciada oficialmente.', horaInicio: now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/assemblies/:id/close', async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date();
    try {
      await db.query(`UPDATE asambleas SET estado = 'finalizada', hora_cierre = NOW() WHERE id = ?`, [id]);
    } catch (e) {
      await db.query(`UPDATE asambleas SET estado = 'finalizada' WHERE id = ?`, [id]);
    }

    const roomName = `assembly_${id}`;
    io.to(roomName).emit('assembly:closed', {
      message: 'La Asamblea ha sido cerrada de manera oficial.',
      horaCierre: now.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    });
    io.emit('assemblies:updated');

    res.json({ ok: true, message: 'Asamblea finalizada y cerrada oficialmente.', horaCierre: now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/superadmin/assemblies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const targetAssembly = parseInt(id);

    if (activeQuestions.has(targetAssembly)) {
      if (timerIntervals.has(targetAssembly)) {
        clearInterval(timerIntervals.get(targetAssembly));
        timerIntervals.delete(targetAssembly);
      }
      activeQuestions.delete(targetAssembly);
    }

    const cleanupSteps = [
      { name: 'votos', query: `DELETE FROM votos WHERE assembly_id = ?`, params: [targetAssembly] },
      { name: 'opciones_pregunta', query: `DELETE FROM opciones_pregunta WHERE pregunta_id IN (SELECT id FROM preguntas WHERE assembly_id = ?)`, params: [targetAssembly] },
      { name: 'preguntas', query: `DELETE FROM preguntas WHERE assembly_id = ?`, params: [targetAssembly] },
      { name: 'poderes', query: `DELETE FROM poderes WHERE assembly_id = ?`, params: [targetAssembly] },
      { name: 'documentos', query: `DELETE FROM documentos WHERE assembly_id = ?`, params: [targetAssembly] },
      { name: 'usuarios', query: `DELETE FROM usuarios WHERE assembly_id = ?`, params: [targetAssembly] },
      { name: 'asambleas', query: `DELETE FROM asambleas WHERE id = ?`, params: [targetAssembly] }
    ];

    for (const step of cleanupSteps) {
      try {
        await db.query(step.query, step.params);
      } catch (errStep) {
        console.warn(`Aviso durante limpieza de [${step.name}]:`, errStep.message);
      }
    }

    const roomName = `assembly_${targetAssembly}`;
    io.to(roomName).emit('assembly:deleted', { message: 'Esta asamblea ha sido eliminada por la administración general.' });
    io.emit('assemblies:updated');

    res.json({ ok: true, message: `Asamblea #${targetAssembly} y todos sus datos relacionados fueron eliminados permanentemente.` });
  } catch (err) {
    console.error('Error al eliminar asamblea:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/superadmin/assemblies/:id/reset', async (req, res) => {
  try {
    const { id } = req.params;
    const targetAssembly = parseInt(id);

    await db.query(`DELETE FROM votos WHERE assembly_id = ?`, [targetAssembly]);
    await db.query(`UPDATE preguntas SET estado = 'borrador' WHERE assembly_id = ?`, [targetAssembly]);

    try {
      await db.query(`UPDATE asambleas SET estado = 'programada', hora_inicio = NULL, hora_cierre = NULL WHERE id = ?`, [targetAssembly]);
    } catch (e) {
      await db.query(`UPDATE asambleas SET estado = 'programada' WHERE id = ?`, [targetAssembly]);
    }

    if (activeQuestions.has(targetAssembly)) {
      if (timerIntervals.has(targetAssembly)) {
        clearInterval(timerIntervals.get(targetAssembly));
        timerIntervals.delete(targetAssembly);
      }
      activeQuestions.delete(targetAssembly);
    }

    const roomName = `assembly_${targetAssembly}`;
    io.to(roomName).emit('assembly:reset', { message: 'La asamblea ha sido depurada y reiniciada.' });
    io.to(roomName).emit('questions:updated');
    io.emit('assemblies:updated');

    res.json({ ok: true, message: 'Asamblea depurada exitosamente. Se borraron los votos y las preguntas volvieron a estado inicial.' });
  } catch (err) {
    console.error('Error al depurar asamblea:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

app.get('/api/support/active-sessions/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    const targetAssembly = parseInt(assemblyId);

    const activeList = [];
    for (const [sessionKey, session] of activeSessions.entries()) {
      if (session.assemblyId === targetAssembly) {
        activeList.push(session);
      }
    }

    res.json({ ok: true, totalConectados: activeList.length, sesiones: activeList });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/support/kick-user', async (req, res) => {
  try {
    const { assemblyId, userId } = req.body;
    const sessionKey = `${assemblyId}_${userId}`;

    if (activeSessions.has(sessionKey)) {
      const sessionData = activeSessions.get(sessionKey);
      io.to(sessionData.socketId).emit('auth:kicked', { message: 'El Asesor Técnico ha reiniciado tu sesión para corregir un inconveniente de conexión.' });
      activeSessions.delete(sessionKey);
      socketUserMap.delete(sessionData.socketId);
      await updateAndBroadcastQuorum(assemblyId);
      return res.json({ ok: true, message: 'Sesión liberada correctamente.' });
    }

    res.json({ ok: true, message: 'El usuario no tenía sesión activa registrada.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

    const [result] = await db.query(
      `INSERT INTO asambleas (nombre_copropiedad, logo_url, estado, zoom_embed_url, zoom_meeting_id, zoom_passcode, zoom_password) 
       VALUES (?, ?, 'programada', ?, ?, ?, ?)`,
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
    console.error('Error al crear asamblea:', err);
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

app.post('/api/superadmin/users/bulk', async (req, res) => {
  try {
    const { assemblyId, users } = req.body;
    if (!assemblyId || !Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ ok: false, error: 'Asamblea inválida o lista de usuarios vacía.' });
    }

    let count = 0;
    for (const u of users) {
      const email = (u.email || u.Email || u.Correo || u.correo || '').toString().trim().toLowerCase();
      const idUnico = (u.identificadorUnico || u.identificador_unico || u.ID || u.id || u.Identificador || email).toString().trim().toUpperCase();
      const nombre = (u.nombreCompleto || u.nombre_completo || u.Nombre || u.nombre || '').toString().trim();
      const unidad = (u.unidad || u.Unidad || u.apto || u.Apto || u.Torre || '---').toString().trim();
      
      let coefRaw = u.coeficiente !== undefined ? u.coeficiente : u.Coeficiente;
      let coef = parseFloat(coefRaw);
      if (isNaN(coef)) coef = 0.00000;

      if (!idUnico && !email) continue;

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

app.post('/api/superadmin/send-credentials', async (req, res) => {
  try {
    const { assemblyId } = req.body;
    if (!assemblyId) return res.status(400).json({ ok: false, error: 'Asamblea requerida.' });

    const [asamblea] = await db.query(`SELECT nombre_copropiedad FROM asambleas WHERE id = ?`, [assemblyId]);
    const nombreCopropiedad = asamblea.length > 0 ? asamblea[0].nombre_copropiedad : 'Asamblea Virtual';

    const [usuarios] = await db.query(
      `SELECT id, identificador_unico, nombre_completo, email, unidad FROM usuarios WHERE assembly_id = ? AND email IS NOT NULL AND email != '' AND rol = 'asistente'`,
      [assemblyId]
    );

    if (usuarios.length === 0) {
      return res.status(400).json({ ok: false, error: 'No se encontraron usuarios con correo electrónico registrado.' });
    }

    const clientUrl = process.env.CLIENT_URL || req.headers.origin || 'https://asambleas.ajaudiovisual.com';
    const fromSender = process.env.RESEND_FROM_EMAIL || 'contacto@ajaudiovisual.com';
    let sentCount = 0;
    let errorCount = 0;

    for (const user of usuarios) {
      const plainPassword = generateAlphanumericPassword(8);
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(plainPassword, salt);

      await db.query(`UPDATE usuarios SET password = ? WHERE id = ?`, [hashedPassword, user.id]);

      try {
        const emailResult = await resend.emails.send({
          from: `${nombreCopropiedad} <${fromSender}>`,
          to: [user.email],
          subject: `Credenciales de Acceso - ${nombreCopropiedad}`,
          text: `Estimado(a) ${user.nombre_completo} (${user.unidad}), tus credenciales de acceso para la ${nombreCopropiedad} son: URL: ${clientUrl}?asamblea=${assemblyId} | Usuario: ${user.email} | Contraseña: ${plainPassword}`,
          html: `
            <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 25px; border-radius: 12px; max-width: 600px; margin: auto;">
              <h2 style="color: #6366f1; text-align: center; margin-bottom: 20px;">Acceso a la Asamblea Virtual</h2>
              <p style="font-size: 14px; line-height: 1.6;">Estimado(a) <strong>${user.nombre_completo}</strong> (${user.unidad}),</p>
              <p style="font-size: 14px; line-height: 1.6;">Le compartimos sus credenciales individuales para ingresar a la <strong>${nombreCopropiedad}</strong>.</p>
              
              <div style="background-color: #1e293b; padding: 18px; border-radius: 8px; border-left: 4px solid #6366f1; margin: 20px 0;">
                <p style="margin: 6px 0; font-size: 14px;"><strong>URL de Ingreso:</strong> <a href="${clientUrl}?asamblea=${assemblyId}" style="color: #38bdf8; word-break: break-all;">${clientUrl}?asamblea=${assemblyId}</a></p>
                <p style="margin: 6px 0; font-size: 14px;"><strong>Usuario (Correo):</strong> <span style="color: #f1f5f9; font-weight: bold;">${user.email}</span></p>
                <p style="margin: 6px 0; font-size: 14px;"><strong>Contraseña Asignada:</strong> <span style="background-color: #334155; padding: 3px 8px; border-radius: 4px; font-family: monospace; font-size: 16px; color: #facc15;">${plainPassword}</span></p>
              </div>

              <h3 style="color: #cbd5e1; font-size: 15px; margin-top: 20px;">Instrucciones Básicas de Ingreso:</h3>
              <ol style="font-size: 13px; color: #94a3b8; line-height: 1.8; padding-left: 20px;">
                <li>Haga clic en el enlace provisto o abra la dirección desde su navegador preferido (Google Chrome o Safari).</li>
                <li>Ingrese su correo electrónico y la contraseña alfanumérica indicada en este correo.</li>
                <li>Mantenga activa su sesión desde un único dispositivo a la vez.</li>
                <li>Si representa a otros inmuebles mediante poder autorizado, el sistema sumará automáticamente sus coeficientes.</li>
              </ol>

              <p style="font-size: 12px; color: #64748b; text-align: center; margin-top: 30px; border-top: 1px solid #334155; padding-top: 15px;">
                Mensaje automático del Sistema de Asambleas Virtuales.
              </p>
            </div>
          `
        });

        if (emailResult.error) {
          console.error(`Error Resend al enviar a ${user.email}:`, emailResult.error);
          errorCount++;
        } else {
          sentCount++;
        }
      } catch (sendErr) {
        console.error(`Error enviando correo a ${user.email}:`, sendErr);
        errorCount++;
      }

      await sleep(600);
    }

    return res.json({
      ok: true,
      message: `Proceso completado. Enviados: ${sentCount}, Fallidos: ${errorCount}.`,
      sentCount,
      errorCount
    });

  } catch (err) {
    console.error('Error general enviando credenciales:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/superadmin/users/send-single-credential', async (req, res) => {
  try {
    const { userId, customPassword } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'ID de usuario requerido.' });

    const [usuarios] = await db.query(
      `SELECT u.id, u.identificador_unico, u.nombre_completo, u.email, u.unidad, u.assembly_id, a.nombre_copropiedad 
       FROM usuarios u 
       JOIN asambleas a ON u.assembly_id = a.id 
       WHERE u.id = ?`,
      [userId]
    );

    if (usuarios.length === 0) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
    }

    const user = usuarios[0];

    if (!user.email || user.email.trim() === '') {
      return res.status(400).json({ ok: false, error: 'El usuario no tiene un correo electrónico registrado.' });
    }

    const plainPassword = (customPassword && customPassword.trim() !== '') 
      ? customPassword.trim() 
      : generateAlphanumericPassword(8);

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(plainPassword, salt);

    await db.query(`UPDATE usuarios SET password = ? WHERE id = ?`, [hashedPassword, user.id]);

    const clientUrl = process.env.CLIENT_URL || req.headers.origin || 'https://asambleas.ajaudiovisual.com';
    const fromSender = process.env.RESEND_FROM_EMAIL || 'contacto@ajaudiovisual.com';

    const emailResult = await resend.emails.send({
      from: `${user.nombre_copropiedad} <${fromSender}>`,
      to: [user.email],
      subject: `Credenciales de Acceso - ${user.nombre_copropiedad}`,
      text: `Estimado(a) ${user.nombre_completo} (${user.unidad}), tus credenciales de acceso para la ${user.nombre_copropiedad} son: URL: ${clientUrl}?asamblea=${user.assembly_id} | Usuario: ${user.email} | Contraseña: ${plainPassword}`,
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 25px; border-radius: 12px; max-width: 600px; margin: auto;">
          <h2 style="color: #6366f1; text-align: center; margin-bottom: 20px;">Acceso a la Asamblea Virtual</h2>
          <p style="font-size: 14px; line-height: 1.6;">Estimado(a) <strong>${user.nombre_completo}</strong> (${user.unidad}),</p>
          <p style="font-size: 14px; line-height: 1.6;">Le compartimos sus credenciales individuales para ingresar a la <strong>${user.nombre_copropiedad}</strong>.</p>
          
          <div style="background-color: #1e293b; padding: 18px; border-radius: 8px; border-left: 4px solid #6366f1; margin: 20px 0;">
            <p style="margin: 6px 0; font-size: 14px;"><strong>URL de Ingreso:</strong> <a href="${clientUrl}?asamblea=${user.assembly_id}" style="color: #38bdf8; word-break: break-all;">${clientUrl}?asamblea=${user.assembly_id}</a></p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Usuario (Correo):</strong> <span style="color: #f1f5f9; font-weight: bold;">${user.email}</span></p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Contraseña Asignada:</strong> <span style="background-color: #334155; padding: 3px 8px; border-radius: 4px; font-family: monospace; font-size: 16px; color: #facc15;">${plainPassword}</span></p>
          </div>

          <h3 style="color: #cbd5e1; font-size: 15px; margin-top: 20px;">Instrucciones Básicas de Ingreso:</h3>
          <ol style="font-size: 13px; color: #94a3b8; line-height: 1.8; padding-left: 20px;">
            <li>Haga clic en el enlace provisto o abra la dirección desde su navegador preferido (Google Chrome o Safari).</li>
            <li>Ingrese su correo electrónico y la contraseña alfanumérica indicada en este correo.</li>
            <li>Mantenga activa su sesión desde un único dispositivo a la vez.</li>
            <li>Si representa a otros inmuebles mediante poder autorizado, el sistema sumará automáticamente sus coeficientes.</li>
          </ol>

          <p style="font-size: 12px; color: #64748b; text-align: center; margin-top: 30px; border-top: 1px solid #334155; padding-top: 15px;">
            Mensaje automático del Sistema de Asambleas Virtuales.
          </p>
        </div>
      `
    });

    if (emailResult.error) {
      return res.status(500).json({ ok: false, error: emailResult.error.message });
    }

    return res.json({
      ok: true,
      message: `Credenciales enviadas a ${user.email}.`,
      plainPassword: plainPassword
    });

  } catch (err) {
    console.error('Error enviando credencial individual:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/assemblies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(`SELECT * FROM asambleas WHERE id = ?`, [id]);
    if (rows.length === 0) {
      return res.json({
        ok: true,
        assembly: { id: 1, nombre_copropiedad: 'Asamblea General', logo_url: 'https://via.placeholder.com/150x40?text=Copropiedad', estado: 'programada' }
      });
    }
    res.json({ ok: true, assembly: rows[0] });
  } catch (err) {
    res.json({ ok: true, assembly: { id: 1, nombre_copropiedad: 'Asamblea General', logo_url: 'https://via.placeholder.com/150x40?text=Copropiedad', estado: 'programada' } });
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
    let targetAssembly = 1;

    try {
      const [doc] = await db.query(`SELECT assembly_id FROM documentos WHERE id = ?`, [id]);
      if (doc.length > 0) targetAssembly = doc[0].assembly_id;
      await db.query(`DELETE FROM documentos WHERE id = ?`, [id]);
    } catch (e) {
      const idx = memoryDocuments.findIndex(d => d.id == id);
      if (idx !== -1) {
        targetAssembly = memoryDocuments[idx].assemblyId || 1;
        memoryDocuments.splice(idx, 1);
      }
    }

    io.to(`assembly_${targetAssembly}`).emit('documents:updated');
    res.json({ ok: true, message: 'Documento eliminado exitosamente.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// OBTENER PREGUNTAS ORDENADAS POR MÁS RECIENTES PRIMERO (ID DESC)
app.get('/api/questions/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    const [preguntas] = await db.query(`SELECT * FROM preguntas WHERE assembly_id = ? ORDER BY id DESC`, [assemblyId]);
    for (let p of preguntas) {
      const [opciones] = await db.query(`SELECT * FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`, [p.id]);
      p.opciones = opciones;
      if (p.estado === 'cerrada' || p.estado === 'activa') {
        p.resultados = await calculateWeightedResults(assemblyId, p.id);
      }
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

// ELIMINAR PREGUNTA POR PARTE DE MODERADOR/ADMINISTRADOR
app.delete('/api/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { assemblyId } = req.query;

    await db.query(`DELETE FROM votos WHERE pregunta_id = ?`, [id]);
    await db.query(`DELETE FROM opciones_pregunta WHERE pregunta_id = ?`, [id]);
    await db.query(`DELETE FROM preguntas WHERE id = ?`, [id]);

    const targetAssembly = assemblyId || 1;
    io.to(`assembly_${targetAssembly}`).emit('questions:updated');
    res.json({ ok: true, message: 'Pregunta y sus votos fueron eliminados correctamente.' });
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

app.delete('/api/powers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [p] = await db.query(`SELECT assembly_id FROM poderes WHERE id = ?`, [id]);
    if (p.length === 0) return res.status(404).json({ ok: false, error: 'Poder no encontrado' });

    const targetAssembly = p[0].assembly_id;
    await db.query(`DELETE FROM poderes WHERE id = ?`, [id]);

    await updateAndBroadcastQuorum(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('powers:updated');
    res.json({ ok: true, message: 'Poder eliminado correctamente.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/powers/manual', async (req, res) => {
  try {
    const { assemblyId, otorganteId, apoderadoIdentificador, apoderadoNombre } = req.body;
    const targetAssembly = parseInt(assemblyId) || 1;
    const cleanOtorgante = (otorganteId || '').toString().trim().toUpperCase();
    const cleanApoderado = (apoderadoIdentificador || '').toString().trim().toUpperCase();

    if (!cleanOtorgante || !cleanApoderado) {
      return res.status(400).json({ ok: false, error: 'Identificador del otorgante y del apoderado son requeridos.' });
    }

    let [otorganteRows] = await db.query(
      `SELECT id FROM usuarios WHERE assembly_id = ? AND (UPPER(identificador_unico) = ? OR UPPER(unidad) = ? OR id = ?)`,
      [targetAssembly, cleanOtorgante, cleanOtorgante, parseInt(cleanOtorgante) || 0]
    );

    if (otorganteRows.length === 0) {
      return res.status(404).json({ ok: false, error: `El inmueble/otorgante [${cleanOtorgante}] no fue encontrado en la base de datos.` });
    }

    const otorganteNumId = otorganteRows[0].id;

    let [apoderadoRows] = await db.query(
      `SELECT id FROM usuarios WHERE assembly_id = ? AND (UPPER(identificador_unico) = ? OR UPPER(unidad) = ? OR id = ?)`,
      [targetAssembly, cleanApoderado, cleanApoderado, parseInt(cleanApoderado) || 0]
    );

    let apoderadoNumId;
    if (apoderadoRows.length === 0) {
      const [ins] = await db.query(
        `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, coeficiente, rol)
         VALUES (?, ?, ?, 'Apoderado Externo', 0.00000, 'asistente')`,
        [targetAssembly, cleanApoderado, apoderadoNombre || cleanApoderado]
      );
      apoderadoNumId = ins.insertId;
    } else {
      apoderadoNumId = apoderadoRows[0].id;
    }

    if (otorganteNumId === apoderadoNumId) {
      return res.status(400).json({ ok: false, error: 'El otorgante y el apoderado no pueden ser la misma persona.' });
    }

    await db.query(
      `INSERT INTO poderes (assembly_id, otorgante_id, apoderado_id, documento_url, estado, observaciones)
       VALUES (?, ?, ?, 'ASIGNACIÓN DIRECTA ADMIN', 'autorizado', 'Asignado manualmente por Representante/Admin')
       ON DUPLICATE KEY UPDATE apoderado_id = VALUES(apoderado_id), estado = 'autorizado'`,
      [targetAssembly, otorganteNumId, apoderadoNumId]
    );

    await updateAndBroadcastQuorum(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('powers:updated');
    res.json({ ok: true, message: 'Poder asignado y autorizado correctamente.' });
  } catch (err) {
    console.error('Error en asignar poder manual:', err);
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
    const { search, all } = req.query;
    let sql = `SELECT id, identificador_unico, nombre_completo, unidad, email, coeficiente, rol FROM usuarios WHERE assembly_id = ?`;
    let params = [assemblyId];

    if (search) {
      sql += ` AND (UPPER(identificador_unico) LIKE ? OR UPPER(nombre_completo) LIKE ? OR UPPER(unidad) LIKE ? OR UPPER(email) LIKE ?)`;
      const term = `%${search.toUpperCase()}%`;
      params.push(term, term, term, term);
    }
    sql += ` ORDER BY unidad ASC`;
    if (all !== 'true') {
      sql += ` LIMIT 50`;
    }
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
      const coefPct = parseFloat(v.Coeficiente_Efectivo).toFixed(4);
      const fecha = new Date(v.Fecha_Hora_Voto).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
      csvContent += `"${v.Pregunta}";"${v.ID_Votante}";"${v.Nombre}";"${v.Unidad}";"${v.Opcion_Votada}";"${coefPct}%";"${fecha}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=Reporte_Votacion_Asamblea_${id}.csv`);
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/reports/assembly/:id/pdf-data', async (req, res) => {
  try {
    const { id } = req.params;
    const [asambleas] = await db.query(`SELECT * FROM asambleas WHERE id = ?`, [id]);
    if (asambleas.length === 0) return res.status(404).json({ ok: false, error: 'Asamblea no encontrada' });

    const [usuarios] = await db.query(
      `SELECT id, identificador_unico, nombre_completo, unidad, coeficiente, email, rol 
       FROM usuarios 
       WHERE assembly_id = ? AND rol = 'asistente' 
       ORDER BY unidad ASC`,
      [id]
    );

    const [preguntas] = await db.query(
      `SELECT * FROM preguntas WHERE assembly_id = ? ORDER BY id DESC`,
      [id]
    );

    for (let p of preguntas) {
      const [opciones] = await db.query(
        `SELECT * FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`,
        [p.id]
      );
      p.opciones = opciones;
    }

    const [votos] = await db.query(
      `SELECT v.id, v.pregunta_id, v.usuario_id, v.opcion_id, o.texto_opcion, v.coeficiente_aplicado, v.created_at
       FROM votos v
       JOIN opciones_pregunta o ON v.opcion_id = o.id
       WHERE v.assembly_id = ?`,
      [id]
    );

    const activeUserIds = new Set();
    for (const [key, session] of activeSessions.entries()) {
      if (session.assemblyId === parseInt(id)) {
        activeUserIds.add(session.userId);
      }
    }

    const totalCargados = usuarios.length;
    const totalConectados = activeUserIds.size;
    const totalNoConectados = Math.max(0, totalCargados - totalConectados);

    let primerVotoFecha = null;
    if (votos.length > 0) {
      primerVotoFecha = votos[0].created_at;
    }

    const asambleaData = asambleas[0];
    asambleaData.fecha_evento_final = asambleaData.fecha_evento || asambleaData.hora_inicio || primerVotoFecha || asambleaData.created_at || new Date();

    res.json({
      ok: true,
      asamblea: asambleaData,
      usuarios,
      preguntas,
      votos,
      asistencia: {
        totalCargados,
        totalConectados,
        totalNoConectados
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

app.get('/', (req, res) => res.json({ status: 'online', version: '3.1.0-master' }));

// WEBSOCKETS EN TIEMPO REAL
io.on('connection', (socket) => {

  socket.on('auth:join', async ({ assemblyId, identificadorUnico, email, password }) => {
    try {
      const targetAssembly = parseInt(assemblyId) || 1;
      const targetId = (identificadorUnico || '').toString().trim().toUpperCase();
      const targetEmail = (email || '').toString().trim().toLowerCase();
      const targetPassword = (password || '').toString().trim();

      let [rows] = await db.query(
        `SELECT id, identificador_unico, nombre_completo, unidad, email, password, coeficiente, rol 
         FROM usuarios 
         WHERE assembly_id = ? AND (LOWER(email) = ? OR UPPER(identificador_unico) = ?)`,
        [targetAssembly, targetEmail || targetId.toLowerCase(), targetId]
      );

      if (rows.length === 0 && targetId.startsWith('SOPORTE')) {
        const [ins] = await db.query(
          `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, coeficiente, rol)
           VALUES (?, ?, 'Soporte Técnico', 'SOPORTE', 0.00000, 'soporte')`,
          [targetAssembly, targetId]
        );
        rows = [{ id: ins.insertId, identificador_unico: targetId, nombre_completo: 'Soporte Técnico', unidad: 'SOPORTE', coeficiente: 0.00000, rol: 'soporte' }];
      }

      if (rows.length === 0) return socket.emit('auth:error', 'Usuario o correo no registrado.');

      const user = rows[0];

      if (user.password && user.password.trim() !== '' && user.rol === 'asistente') {
        if (!targetPassword) {
          return socket.emit('auth:error', 'Ingresa tu contraseña.');
        }
        const isMatch = await bcrypt.compare(targetPassword, user.password);
        if (!isMatch) {
          return socket.emit('auth:error', 'Contraseña incorrecta.');
        }
      }

      const userId = user.id;
      const sessionKey = `${targetAssembly}_${userId}`;

      if (activeSessions.has(sessionKey)) {
        const existingSession = activeSessions.get(sessionKey);
        if (existingSession.socketId !== socket.id) {
          io.to(existingSession.socketId).emit('auth:kicked', { message: 'Tu sesión ha sido iniciada en otro dispositivo.' });
        }
      }

      activeSessions.set(sessionKey, { userId, assemblyId: targetAssembly, socketId: socket.id, identificadorUnico: user.identificador_unico, nombreCompleto: user.nombre_completo, unidad: user.unidad, rol: user.rol });
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
        const stats = await getVotingStats(targetAssembly, activeQ.id);
        const [votoUsuario] = await db.query(`SELECT opcion_id FROM votos WHERE pregunta_id = ? AND usuario_id = ?`, [activeQ.id, userId]);
        socket.emit('voting:current_state', { ...activeQ, stats, myCurrentVote: votoUsuario.length > 0 ? votoUsuario[0].opcion_id : null });
      }
    } catch (error) {
      console.error('Error al autenticar socket:', error);
      socket.emit('auth:error', 'Error interno al autenticar.');
    }
  });

  socket.on('chat:message', ({ texto, emisor, unidad }) => {
    const targetAssembly = socket.assemblyId || 1;
    const msgData = {
      id: Date.now(),
      texto,
      emisor: emisor || 'Asistente',
      unidad: unidad || '---',
      hora: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' })
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
      const stats = await getVotingStats(assemblyId, preguntaId);
      const activeQData = { id: preguntas[0].id, texto: preguntas[0].texto_pregunta, opciones, duracion, tiempoRestante: duracion, isOpen: true, stats };

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
          const finalStats = await getVotingStats(assemblyId, preguntaId);

          io.to(roomName).emit('voting:closed', { preguntaId, resultados: finalResults, stats: finalStats });
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
      const finalStats = await getVotingStats(assemblyId, preguntaId);

      const roomName = `assembly_${assemblyId}`;
      io.to(roomName).emit('voting:closed', { preguntaId, resultados: finalResults, stats: finalStats });
      io.to(roomName).emit('questions:updated');
    } catch (error) {
      console.error('Error al detener votación:', error);
    }
  });

  // EMISIÓN DE VOTO CON REGISTRO MULTIPLICADO POR PODERES (1 PODER = 2 VOTOS EN RESUMEN)
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

      // 1. Obtener otorgantes representados con poder autorizado
      const [poderesAprobados] = await db.query(
        `SELECT p.otorgante_id, u.coeficiente
         FROM poderes p
         JOIN usuarios u ON p.otorgante_id = u.id
         WHERE p.apoderado_id = ? AND p.assembly_id = ? AND p.estado = 'autorizado'`,
        [userId, assemblyId]
      );

      // 2. Obtener datos del votante actual
      const [u] = await db.query(`SELECT id, coeficiente, rol FROM usuarios WHERE id = ?`, [userId]);
      if (u.length === 0) return;

      const voterList = [];

      // Si el votante no es de soporte y tiene inmueble propio o poderes, se incluye a sí mismo
      if (u[0].rol !== 'soporte') {
        const propioCoef = parseFloat(u[0].coeficiente) || 0;
        if (propioCoef > 0 || poderesAprobados.length === 0) {
          voterList.push({ usuarioId: u[0].id, coef: propioCoef });
        }
      }

      // Agregar a cada otorgante representado para que su voto cuente de forma individual
      for (const pod of poderesAprobados) {
        voterList.push({ usuarioId: pod.otorgante_id, coef: parseFloat(pod.coeficiente) || 0 });
      }

      if (voterList.length === 0) {
        return socket.emit('vote:rejected', { message: 'Tu coeficiente habilitado de voto es 0.0000%.' });
      }

      // Registrar los votos individuales (Inmueble propio + Inmuebles Representados)
      for (const target of voterList) {
        await db.query(
          `INSERT INTO votos (assembly_id, pregunta_id, usuario_id, opcion_id, coeficiente_aplicado)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE opcion_id = VALUES(opcion_id), coeficiente_aplicado = VALUES(coeficiente_aplicado)`,
          [assemblyId, currentQ.id, target.usuarioId, opcionId, target.coef]
        );
      }

      socket.emit('vote:confirmed', { opcionId });
      
      const updatedResults = await calculateWeightedResults(assemblyId, currentQ.id);
      const stats = await getVotingStats(assemblyId, currentQ.id);
      
      io.to(`assembly_${assemblyId}`).emit('voting:results_update', { preguntaId: currentQ.id, resultados: updatedResults, stats });
    } catch (error) {
      console.error('Error al registrar voto:', error);
    }
  });

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
server.listen(PORT, () => console.log(`🚀 Servidor de Asambleas v3.1.0-master corriendo en puerto ${PORT}`));
