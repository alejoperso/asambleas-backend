// =========================================================================
// INICIO SECCION 01: IMPORTACIONES, CONFIGURACION EXPRESS Y VARIABLES DE ENTORNO
// =========================================================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
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

// CONFIGURACIÓN DE CREDENCIALES MAESTRAS DE SUPERADMIN Y CLAVE SECRETA
const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'contacto@ajaudiovisual.com';
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || 'Alfaleon2030';
const SECRET_KEY = process.env.JWT_SECRET || 'AsambleasPH_Secret_Token_2026';

// INICIALIZACIÓN DE RESEND CON API KEY
const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy_key');
// =========================================================================
// FIN SECCION 01: IMPORTACIONES, CONFIGURACION EXPRESS Y VARIABLES DE ENTORNO
// =========================================================================

// =========================================================================
// INICIO SECCION 02: ESTRUCTURAS EN MEMORIA Y HELPERS AUXILIARES
// =========================================================================
const activeQuestions = new Map();
const timerIntervals = new Map();
const activeSessions = new Map();
const socketUserMap = new Map();

// ESTRUCTURAS EN MEMORIA PARA MODERACIÓN AVANZADA DEL CHAT, MANOS LEVANTADAS, COMPUERTA ZOOM Y PERMISOS DE AUDIO/VIDEO
const assemblyChatActive = new Map(); // Pausa global del chat por asamblea
const assemblyPinnedMessage = new Map(); // Mensaje anclado actual por asamblea
const assemblyMutedUsers = new Map(); // Set de userId/identificador bloqueados en chat por asamblea
const assemblyDraftPreview = new Map(); // Estado actual de pregunta en redacción por asamblea
const assemblyRaisedHands = new Map(); // Cola FIFO en vivo de manos levantadas por asamblea
const assemblyZoomOpen = new Map(); // Compuerta para habilitar/ocultar el acceso a Zoom a los asistentes
const assemblyMediaPermissions = new Map(); // Mapa de permisos individuales de { mic: boolean, cam: boolean } por asamblea

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getMutedSetForAssembly(assemblyId) {
  const target = parseInt(assemblyId) || 1;
  if (!assemblyMutedUsers.has(target)) {
    assemblyMutedUsers.set(target, new Set());
  }
  return assemblyMutedUsers.get(target);
}

function getRaisedHandsForAssembly(assemblyId) {
  const target = parseInt(assemblyId) || 1;
  if (!assemblyRaisedHands.has(target)) {
    assemblyRaisedHands.set(target, []);
  }
  return assemblyRaisedHands.get(target);
}

function getMediaPermissionsMapForAssembly(assemblyId) {
  const target = parseInt(assemblyId) || 1;
  if (!assemblyMediaPermissions.has(target)) {
    assemblyMediaPermissions.set(target, new Map());
  }
  return assemblyMediaPermissions.get(target);
}

function serializeMediaPermissions(assemblyId) {
  const map = getMediaPermissionsMapForAssembly(assemblyId);
  const obj = {};
  for (const [k, v] of map.entries()) {
    obj[k] = { mic: !!v.mic, cam: !!v.cam };
  }
  return obj;
}

function isZoomGateOpenForAssembly(assemblyId) {
  const target = parseInt(assemblyId) || 1;
  return assemblyZoomOpen.get(target) === true;
}
// =========================================================================
// FIN SECCION 02: ESTRUCTURAS EN MEMORIA Y HELPERS AUXILIARES
// =========================================================================

// =========================================================================
// INICIO SECCION 03: HELPERS DE INTEGRACION ZOOM (OAUTH Y ZAK TOKEN)
// =========================================================================
// HELPER PARA OBTENER EL TIMESTAMP UNIX REAL DIRECTAMENTE DEL SERVIDOR DE ZOOM
function getZoomServerUnixTime() {
  return new Promise((resolve) => {
    const req = https.request('https://zoom.us', { method: 'HEAD', timeout: 3000 }, (res) => {
      if (res.headers && res.headers.date) {
        const parsedTime = Math.floor(new Date(res.headers.date).getTime() / 1000);
        if (!isNaN(parsedTime) && parsedTime > 0) {
          return resolve(parsedTime);
        }
      }
      resolve(Math.floor(Date.now() / 1000));
    });
    req.on('error', () => {
      resolve(Math.floor(Date.now() / 1000));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(Math.floor(Date.now() / 1000));
    });
    req.end();
  });
}

// HELPER PARA OBTENER TOKEN OAUTH Y ZAK TOKEN DE ANFITRIÓN
async function getZoomHostZakToken() {
  const accountId = (process.env.ZOOM_ACCOUNT_ID || '').trim();
  const clientId = (process.env.ZOOM_CLIENT_ID || '').trim();
  const clientSecret = (process.env.ZOOM_CLIENT_SECRET || '').trim();

  if (!accountId || !clientId || !clientSecret) {
    return null;
  }

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenData = await new Promise((resolve, reject) => {
      const req = https.request(
        `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Content-Length': 0
          },
          timeout: 5000
        },
        (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { resolve({}); }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout OAuth Zoom')); });
      req.end();
    });

    if (!tokenData || !tokenData.access_token) {
      return null;
    }

    const zakData = await new Promise((resolve, reject) => {
      const req = https.request(
        'https://api.zoom.us/v2/users/me/token?type=zak',
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${tokenData.access_token}`
          },
          timeout: 5000
        },
        (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { resolve({}); }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout ZAK Zoom')); });
      req.end();
    });

    return zakData && zakData.token ? zakData.token : null;
  } catch (err) {
    console.warn('Aviso obteniendo ZAK Token de Zoom:', err.message);
    return null;
  }
}
// =========================================================================
// FIN SECCION 03: HELPERS DE INTEGRACION ZOOM (OAUTH Y ZAK TOKEN)
// =========================================================================

// =========================================================================
// INICIO SECCION 04: HELPERS DE SEGURIDAD DE PODERES Y RESPUESTA HTML
// =========================================================================
// HELPER PARA GENERAR TOKENS SEGUROS DE ACCIÓN EN PODERES
function generatePowerActionToken(powerId, action) {
  return crypto
    .createHmac('sha256', SECRET_KEY)
    .update(`${powerId}_${action}`)
    .digest('hex');
}

// HELPER PARA RENDERIZAR RESPUESTA HTML AL REPRESENTANTE LEGAL
function renderResponseHTML(title, message, isSuccess, headerColor = '#6366f1') {
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        body { font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
        .card { background-color: #1e293b; border-radius: 16px; padding: 32px; max-width: 480px; width: 100%; text-align: center; border: 1px solid #334155; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
        .badge { display: inline-block; padding: 8px 16px; border-radius: 9999px; font-weight: bold; font-size: 14px; margin-bottom: 16px; color: #fff; background-color: ${headerColor}; }
        h1 { font-size: 20px; margin-bottom: 12px; color: #ffffff; }
        p { font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px; }
        .btn { display: inline-block; background-color: #334155; color: #f1f5f9; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: bold; }
        .btn:hover { background-color: #475569; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge">${isSuccess ? '✓ OPERACIÓN EXITOSA' : '✕ ALERTA DE SISTEMA'}</div>
        <h1>${title}</h1>
        <p>${message}</p>
        <a href="javascript:window.close();" class="btn">Cerrar esta ventana</a>
      </div>
    </body>
    </html>
  `;
}
// =========================================================================
// FIN SECCION 04: HELPERS DE SEGURIDAD DE PODERES Y RESPUESTA HTML
// =========================================================================

// =========================================================================
// INICIO SECCION 05: MIGRACION AUTOMATICA DE BASE DE DATOS (ESQUEMA SQL)
// =========================================================================
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
        zoom_habilitado TINYINT(1) DEFAULT 0,
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
      `ALTER TABLE asambleas MODIFY COLUMN logo_url LONGTEXT NULL`,
      `ALTER TABLE asambleas MODIFY COLUMN estado VARCHAR(50) DEFAULT 'programada'`,
      `ALTER TABLE asambleas MODIFY COLUMN zoom_embed_url LONGTEXT NULL`,
      `ALTER TABLE asambleas ADD COLUMN zoom_habilitado TINYINT(1) DEFAULT 0`,
      `ALTER TABLE asambleas ADD COLUMN fecha_evento DATE NULL`,
      `ALTER TABLE asambleas ADD COLUMN hora_inicio DATETIME NULL`,
      `ALTER TABLE asambleas ADD COLUMN hora_cierre DATETIME NULL`
    ];
    for (const q of alterQueries) {
      try {
        await db.query(q);
      } catch (e) {}
    }
    try {
      const [asmRows] = await db.query(`SELECT id, zoom_habilitado FROM asambleas`);
      asmRows.forEach(r => {
        assemblyZoomOpen.set(parseInt(r.id), r.zoom_habilitado === 1);
      });
    } catch (e) {}

    console.log('✅ Verificación y migración completa de las 7 tablas de base de datos.');
  } catch (err) {
    console.warn('Advertencia en verificación de esquema:', err.message);
  }
}
initDbSchema();

function generateAlphanumericPassword(length = 6) {
  const firstDigits = '123456789';
  const allDigits = '0123456789';
  let password = firstDigits.charAt(Math.floor(Math.random() * firstDigits.length));
  for (let i = 1; i < length; i++) {
    password += allDigits.charAt(Math.floor(Math.random() * allDigits.length));
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
// =========================================================================
// FIN SECCION 05: MIGRACION AUTOMATICA DE BASE DE DATOS (ESQUEMA SQL)
// =========================================================================

// =========================================================================
// INICIO SECCION 06: LOGICA DE NEGOCIO (ZOOM, PODERES, QUORUM Y COEFICIENTES)
// =========================================================================
async function getAssemblyZoomStreamInfo(assemblyId) {
  const target = parseInt(assemblyId) || 1;
  try {
    const [rows] = await db.query(`SELECT zoom_embed_url, zoom_meeting_id, zoom_passcode, zoom_habilitado FROM asambleas WHERE id = ?`, [target]);
    if (rows.length === 0) {
      return { rawUrl: '', meetingId: '', passcode: '', zoomHabilitado: false };
    }
    const parsed = parseZoomCredentials(rows[0].zoom_embed_url, rows[0].zoom_passcode);
    const isEnabled = assemblyZoomOpen.has(target) ? assemblyZoomOpen.get(target) : (rows[0].zoom_habilitado === 1);
    assemblyZoomOpen.set(target, !!isEnabled);
    return {
      rawUrl: rows[0].zoom_embed_url || '',
      meetingId: rows[0].zoom_meeting_id || parsed.meetingId,
      passcode: rows[0].zoom_passcode || parsed.passcode,
      zoomHabilitado: !!isEnabled
    };
  } catch (err) {
    return { rawUrl: '', meetingId: '', passcode: '', zoomHabilitado: isZoomGateOpenForAssembly(target) };
  }
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
  if (!userId || userId <= 0) return 0;
  const { isRepresented } = await checkUserRepresentedStatus(userId, assemblyId);
  if (isRepresented) return 0;

  const [u] = await db.query(`SELECT coeficiente, rol FROM usuarios WHERE id = ?`, [userId]);
  if (u.length === 0) return 0;
  const rolLower = (u[0].rol || '').toLowerCase();
  if (['soporte', 'superadmin', 'moderador', 'administrador', 'representante_legal'].includes(rolLower) && (parseFloat(u[0].coeficiente) || 0) === 0) {
    return 0;
  }

  const propio = parseFloat(u[0].coeficiente) || 0;
  const { coefPoderes } = await getUserPowerDetails(userId, assemblyId);
  return propio + coefPoderes;
}

async function computeQuorumAndConnected(assemblyId) {
  const targetAssembly = parseInt(assemblyId) || 1;
  const activeList = [];
  const activeUserIds = new Set();

  for (const [key, session] of activeSessions.entries()) {
    if (parseInt(session.assemblyId) === targetAssembly) {
      if (session.userId > 0) {
        activeUserIds.add(session.userId);
      }

      const coefEfectivo = session.userId > 0
        ? await getUserEffectiveCoefficient(session.userId, targetAssembly)
        : 0;

      activeList.push({
        userId: session.userId,
        identificadorUnico: session.identificador_unico || session.identificadorUnico,
        nombreCompleto: session.nombreCompleto,
        unidad: session.unidad,
        rol: session.rol,
        coeficiente: coefEfectivo
      });
    }
  }

  let totalQuorum = 0;
  let totalPropiedades = 0;

  if (activeUserIds.size > 0) {
    for (let uId of activeUserIds) {
      totalQuorum += await getUserEffectiveCoefficient(uId, targetAssembly);

      const { isRepresented } = await checkUserRepresentedStatus(uId, targetAssembly);
      if (isRepresented) continue;

      const [u] = await db.query(`SELECT coeficiente, rol FROM usuarios WHERE id = ?`, [uId]);
      if (u.length === 0) continue;

      const rolLower = (u[0].rol || '').toLowerCase();
      const propioCoef = parseFloat(u[0].coeficiente) || 0;
      const isControlRole = ['soporte', 'superadmin', 'moderador', 'administrador', 'representante_legal'].includes(rolLower);

      if (!isControlRole && propioCoef > 0) {
        totalPropiedades += 1;
      }

      const { representadosAprobados } = await getUserPowerDetails(uId, targetAssembly);
      if (Array.isArray(representadosAprobados) && representadosAprobados.length > 0) {
        for (const rep of representadosAprobados) {
          if ((parseFloat(rep.coeficiente) || 0) > 0) {
            totalPropiedades += 1;
          }
        }
      }
    }
  }
// =========================================================================
// FIN SECCION 06: LOGICA DE NEGOCIO (ZOOM, PODERES, QUORUM Y COEFICIENTES)
// =========================================================================
// =========================================================================
// INICIO SECCION 07: ESTADISTICAS Y CALCULO DE RESULTADOS DE VOTACION
// =========================================================================
  const quorumPercentage = totalQuorum.toFixed(4);
  return { quorumPercentage, totalPropiedades, total: activeList.length, usuarios: activeList };
}

async function updateAndBroadcastQuorum(assemblyId) {
  try {
    const targetAssembly = parseInt(assemblyId) || 1;
    const { quorumPercentage, totalPropiedades, total, usuarios } = await computeQuorumAndConnected(targetAssembly);

    io.to(`assembly_${targetAssembly}`).emit('quorum:update', { quorumPercentage, totalPropiedades });
    io.to(`assembly_${targetAssembly}`).emit('users:connected_update', { total, totalPropiedades, usuarios });
  } catch (err) {
    console.error('Error calculando quórum:', err);
  }
}

async function getVotingStats(assemblyId, preguntaId) {
  try {
    const rawActiveUserIds = new Set();
    for (const [key, session] of activeSessions.entries()) {
      if (parseInt(session.assemblyId) === parseInt(assemblyId) && session.userId > 0) {
        rawActiveUserIds.add(session.userId);
      }
    }

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
// =========================================================================
// FIN SECCION 07: ESTADISTICAS Y CALCULO DE RESULTADOS DE VOTACION
// =========================================================================

// =========================================================================
// INICIO SECCION 08: API REST - QUORUM, AUTENTICACION ADMIN Y GESTION SUPERADMIN
// =========================================================================
// REST API: CONSULTA DIRECTA DE QUÓRUM Y CONECTADOS EN VIVO
app.get('/api/quorum/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    const data = await computeQuorumAndConnected(assemblyId);
    res.json({ ok: true, ...data, mediaPermissions: serializeMediaPermissions(assemblyId) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// REST API: LOGIN DE ADMINISTRACIÓN Y SUPERADMIN
app.post('/api/auth/admin-login', async (req, res) => {
  try {
    const { email, password, assemblyId } = req.body;
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
       WHERE LOWER(email) = ? AND rol IN ('administrador', 'soporte', 'moderador', 'representante_legal')
       ORDER BY id DESC`,
      [cleanEmail]
    );

    if (rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Credenciales inválidas o sin permisos de gestión.' });
    }

    let matchedUser = null;
    if (assemblyId) {
      matchedUser = rows.find(r => parseInt(r.assembly_id) === parseInt(assemblyId) && r.password && r.password.trim() !== '');
    }
    if (!matchedUser) {
      matchedUser = rows.find(r => r.password && r.password.trim() !== '') || rows[0];
    }

    if (!matchedUser.password || matchedUser.password.trim() === '') {
      return res.status(401).json({ ok: false, error: 'El usuario no tiene una contraseña configurada.' });
    }

    let isMatch = await bcrypt.compare(cleanPass, matchedUser.password);
    if (!isMatch) {
      for (const candidate of rows) {
        if (candidate.password && await bcrypt.compare(cleanPass, candidate.password)) {
          matchedUser = candidate;
          isMatch = true;
          break;
        }
      }
    }

    if (!isMatch) {
      return res.status(401).json({ ok: false, error: 'Contraseña incorrecta.' });
    }

    if (assemblyId) {
      const sameAssemblyRecord = rows.find(r => parseInt(r.assembly_id) === parseInt(assemblyId));
      if (sameAssemblyRecord) {
        matchedUser = sameAssemblyRecord;
      }
    }

    const token = Buffer.from(`${matchedUser.rol}_${matchedUser.id}_${Date.now()}`).toString('base64');
    return res.json({
      ok: true,
      user: {
        id: matchedUser.id,
        nombre_completo: matchedUser.nombre_completo,
        email: matchedUser.email,
        rol: matchedUser.rol,
        assembly_id: matchedUser.assembly_id,
        identificador_unico: matchedUser.identificador_unico
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
    } else {
      const [existing] = await db.query(
        `SELECT password FROM usuarios WHERE LOWER(email) = ? AND password IS NOT NULL AND password != '' ORDER BY id DESC LIMIT 1`,
        [cleanEmail]
      );
      if (existing.length > 0) {
        hashedPassword = existing[0].password;
      }
    }
// =========================================================================
// FIN SECCION 08: API REST - QUORUM, AUTENTICACION ADMIN Y GESTION SUPERADMIN
// =========================================================================
  // =========================================================================
// INICIO SECCION 09: API REST - CICLO DE VIDA Y ADMINISTRACION DE ASAMBLEAS
// =========================================================================
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
    const targetAssembly = parseInt(id) || 1;
    const now = new Date();
    assemblyZoomOpen.set(targetAssembly, true);
    try {
      await db.query(`UPDATE asambleas SET estado = 'en_curso', zoom_habilitado = 1, hora_inicio = NOW() WHERE id = ?`, [targetAssembly]);
    } catch (e) {
      await db.query(`UPDATE asambleas SET estado = 'en_curso' WHERE id = ?`, [targetAssembly]);
    }

    const streamInfo = await getAssemblyZoomStreamInfo(targetAssembly);
    const roomName = `assembly_${targetAssembly}`;
    io.to(roomName).emit('zoom:updated', { streamInfo });
    io.emit('assemblies:updated');

    res.json({ ok: true, message: 'Asamblea iniciada oficialmente y sala de Zoom abierta.', horaInicio: now, streamInfo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/assemblies/:id/close', async (req, res) => {
  try {
    const { id } = req.params;
    const targetAssembly = parseInt(id) || 1;
    const now = new Date();
    assemblyZoomOpen.set(targetAssembly, false);
    try {
      await db.query(`UPDATE asambleas SET estado = 'finalizada', zoom_habilitado = 0, hora_cierre = NOW() WHERE id = ?`, [targetAssembly]);
    } catch (e) {
      await db.query(`UPDATE asambleas SET estado = 'finalizada' WHERE id = ?`, [targetAssembly]);
    }

    const streamInfo = await getAssemblyZoomStreamInfo(targetAssembly);
    const roomName = `assembly_${targetAssembly}`;
    io.to(roomName).emit('zoom:updated', { streamInfo });
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

    assemblyDraftPreview.delete(targetAssembly);
    assemblyRaisedHands.delete(targetAssembly);
    assemblyZoomOpen.delete(targetAssembly);
    assemblyMediaPermissions.delete(targetAssembly);

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

    assemblyZoomOpen.set(targetAssembly, false);
    try {
      await db.query(`UPDATE asambleas SET estado = 'programada', zoom_habilitado = 0, hora_inicio = NULL, hora_cierre = NULL WHERE id = ?`, [targetAssembly]);
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

    assemblyPinnedMessage.delete(targetAssembly);
    assemblyMutedUsers.delete(targetAssembly);
    assemblyDraftPreview.delete(targetAssembly);
    assemblyRaisedHands.delete(targetAssembly);
    assemblyMediaPermissions.delete(targetAssembly);
    for (let i = memoryChat.length - 1; i >= 0; i--) {
      if (parseInt(memoryChat[i].assemblyId) === targetAssembly) {
        memoryChat.splice(i, 1);
      }
    }

    const roomName = `assembly_${targetAssembly}`;
    io.to(roomName).emit('assembly:reset', { message: 'La asamblea ha sido depurada y reiniciada.' });
    io.to(roomName).emit('questions:updated');
    io.emit('assemblies:updated');

    res.json({ ok: true, message: 'Asamblea depurada exitosamente. Se borraron los votos, se cerró la compuerta de Zoom y las preguntas volvieron a estado inicial.' });
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
      `INSERT INTO asambleas (nombre_copropiedad, logo_url, estado, zoom_embed_url, zoom_meeting_id, zoom_passcode, zoom_password, zoom_habilitado) 
       VALUES (?, ?, 'programada', ?, ?, ?, ?, 0)`,
      [nombreCopropiedad, logoUrl, zoomEmbedUrl || '', parsed.meetingId, parsed.passcode, parsed.passcode]
    );
    const assemblyId = result.insertId;
    assemblyZoomOpen.set(assemblyId, false);

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
// =========================================================================
// FIN SECCION 09: API REST - CICLO DE VIDA Y ADMINISTRACION DE ASAMBLEAS
// =========================================================================

// =========================================================================
// INICIO SECCION 10: API REST - PADRON ELECTORAL, EDICION Y CREDENCIALES (RESEND)
// =========================================================================
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

app.put('/api/superadmin/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { assemblyId, identificadorUnico, nombreCompleto, email, unidad, coeficiente } = req.body;

    if (!identificadorUnico || identificadorUnico.toString().trim() === '') {
      return res.status(400).json({ ok: false, error: 'El identificador único es obligatorio.' });
    }

    const cleanIdUnico = identificadorUnico.toString().trim().toUpperCase();
    const cleanNombre = (nombreCompleto || cleanIdUnico).toString().trim();
    const cleanEmail = (email || '').toString().trim().toLowerCase();
    const cleanUnidad = (unidad || '---').toString().trim();
    const cleanCoef = isNaN(parseFloat(coeficiente)) ? 0.00000 : parseFloat(coeficiente);

    await db.query(
      `UPDATE usuarios 
       SET identificador_unico = ?, nombre_completo = ?, email = ?, unidad = ?, coeficiente = ? 
       WHERE id = ?`,
      [cleanIdUnico, cleanNombre, cleanEmail, cleanUnidad, cleanCoef, id]
    );

    if (assemblyId) {
      await updateAndBroadcastQuorum(assemblyId);
      io.to(`assembly_${assemblyId}`).emit('users:updated');
    }

    res.json({ ok: true, message: 'Usuario actualizado correctamente.' });
  } catch (err) {
    console.error('Error actualizando usuario del padrón:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ENVÍO MASIVO DE CREDENCIALES CON CONTRASEÑA NUMÉRICA
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
      const plainPassword = generateAlphanumericPassword(6);
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(plainPassword, salt);

      await db.query(`UPDATE usuarios SET password = ? WHERE id = ?`, [hashedPassword, user.id]);

      try {
        const emailResult = await resend.emails.send({
          from: `${nombreCopropiedad} <${fromSender}>`,
          to: [user.email],
          subject: `Credenciales de Acceso - ${nombreCopropiedad}`,
          text: `Estimado(a) ${user.nombre_completo} (${user.unidad}), tus credenciales de acceso para la ${nombreCopropiedad} son: URL: ${clientUrl}?asamblea=${assemblyId} | Usuario: ${user.email} | Contraseña Numérica: ${plainPassword}`,
          html: `
            <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 25px; border-radius: 12px; max-width: 600px; margin: auto;">
              <h2 style="color: #6366f1; text-align: center; margin-bottom: 20px;">Acceso a la Asamblea Virtual</h2>
              <p style="font-size: 14px; line-height: 1.6;">Estimado(a) <strong>${user.nombre_completo}</strong> (${user.unidad}),</p>
              <p style="font-size: 14px; line-height: 1.6;">Le compartimos sus credenciales individuales para ingresar a la <strong>${nombreCopropiedad}</strong>.</p>
              
              <div style="background-color: #1e293b; padding: 18px; border-radius: 8px; border-left: 4px solid #6366f1; margin: 20px 0;">
                <p style="margin: 6px 0; font-size: 14px;"><strong>URL de Ingreso:</strong> <a href="${clientUrl}?asamblea=${assemblyId}" style="color: #38bdf8; word-break: break-all;">${clientUrl}?asamblea=${assemblyId}</a></p>
                <p style="margin: 6px 0; font-size: 14px;"><strong>Usuario (Correo):</strong> <span style="color: #f1f5f9; font-weight: bold;">${user.email}</span></p>
                <p style="margin: 6px 0; font-size: 14px;"><strong>Contraseña Numérica Asignada:</strong> <span style="background-color: #334155; padding: 3px 10px; border-radius: 4px; font-family: monospace; font-size: 18px; letter-spacing: 2px; font-weight: bold; color: #facc15;">${plainPassword}</span></p>
              </div>

              <h3 style="color: #cbd5e1; font-size: 15px; margin-top: 20px;">Instrucciones Básicas de Ingreso:</h3>
              <ol style="font-size: 13px; color: #94a3b8; line-height: 1.8; padding-left: 20px;">
                <li>Haga clic en el enlace provisto o abra la dirección desde su navegador preferido (Google Chrome o Safari).</li>
                <li>Ingrese su correo electrónico y la contraseña numérica de 6 dígitos indicada en este correo.</li>
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

// ENVÍO INDIVIDUAL DE CREDENCIAL CON CONTRASEÑA NUMÉRICA
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
      : generateAlphanumericPassword(6);

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(plainPassword, salt);

    await db.query(`UPDATE usuarios SET password = ? WHERE id = ?`, [hashedPassword, user.id]);

    const clientUrl = process.env.CLIENT_URL || req.headers.origin || 'https://asambleas.ajaudiovisual.com';
    const fromSender = process.env.RESEND_FROM_EMAIL || 'contacto@ajaudiovisual.com';

    const emailResult = await resend.emails.send({
      from: `${user.nombre_copropiedad} <${fromSender}>`,
      to: [user.email],
      subject: `Credenciales de Acceso - ${user.nombre_copropiedad}`,
      text: `Estimado(a) ${user.nombre_completo} (${user.unidad}), tus credenciales de acceso para la ${user.nombre_copropiedad} son: URL: ${clientUrl}?asamblea=${user.assembly_id} | Usuario: ${user.email} | Contraseña Numérica: ${plainPassword}`,
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 25px; border-radius: 12px; max-width: 600px; margin: auto;">
          <h2 style="color: #6366f1; text-align: center; margin-bottom: 20px;">Acceso a la Asamblea Virtual</h2>
          <p style="font-size: 14px; line-height: 1.6;">Estimado(a) <strong>${user.nombre_completo}</strong> (${user.unidad}),</p>
          <p style="font-size: 14px; line-height: 1.6;">Le compartimos sus credenciales individuales para ingresar a la <strong>${user.nombre_copropiedad}</strong>.</p>
          
          <div style="background-color: #1e293b; padding: 18px; border-radius: 8px; border-left: 4px solid #6366f1; margin: 20px 0;">
            <p style="margin: 6px 0; font-size: 14px;"><strong>URL de Ingreso:</strong> <a href="${clientUrl}?asamblea=${user.assembly_id}" style="color: #38bdf8; word-break: break-all;">${clientUrl}?asamblea=${user.assembly_id}</a></p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Usuario (Correo):</strong> <span style="color: #f1f5f9; font-weight: bold;">${user.email}</span></p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Contraseña Numérica Asignada:</strong> <span style="background-color: #334155; padding: 3px 10px; border-radius: 4px; font-family: monospace; font-size: 18px; letter-spacing: 2px; font-weight: bold; color: #facc15;">${plainPassword}</span></p>
          </div>

          <h3 style="color: #cbd5e1; font-size: 15px; margin-top: 20px;">Instrucciones Básicas de Ingreso:</h3>
          <ol style="font-size: 13px; color: #94a3b8; line-height: 1.8; padding-left: 20px;">
            <li>Haga clic en el enlace provisto o abra la dirección desde su navegador preferido (Google Chrome o Safari).</li>
            <li>Ingrese su correo electrónico y la contraseña numérica de 6 dígitos indicada en este correo.</li>
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
// =========================================================================
// FIN SECCION 10: API REST - PADRON ELECTORAL, EDICION Y CREDENCIALES (RESEND)
// =========================================================================

// =========================================================================
// INICIO SECCION 11: API REST - DETALLES DE ASAMBLEAS Y DOCUMENTOS
// =========================================================================
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

    if (logoBase64 && logoBase64.trim() !== '') {
      await db.query(`UPDATE asambleas SET nombre_copropiedad = ?, logo_url = ? WHERE id = ?`, [nombreCopropiedad, logoBase64, id]);
      io.to(`assembly_${id}`).emit('assembly:updated', { nombreCopropiedad, logoUrl: logoBase64 });
    } else {
      await db.query(`UPDATE asambleas SET nombre_copropiedad = ? WHERE id = ?`, [nombreCopropiedad, id]);
      const [rows] = await db.query(`SELECT logo_url FROM asambleas WHERE id = ?`, [id]);
      const currentLogo = rows.length > 0 ? rows[0].logo_url : null;
      io.to(`assembly_${id}`).emit('assembly:updated', { nombreCopropiedad, logoUrl: currentLogo });
    }

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
    // =========================================================================
// INICIO SECCION 12: API REST - GESTION DE DOCUMENTOS DE ASAMBLEA
// =========================================================================
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
// =========================================================================
// FIN SECCION 12: API REST - GESTION DE DOCUMENTOS DE ASAMBLEA
// =========================================================================

// =========================================================================
// INICIO SECCION 13: API REST - PREGUNTAS Y OPCIONES DE VOTACION
// =========================================================================
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
    const targetAssembly = parseInt(assemblyId) || 1;
    const [result] = await db.query(
      `INSERT INTO preguntas (assembly_id, texto_pregunta, duracion_segundos, estado) VALUES (?, ?, ?, 'borrador')`,
      [targetAssembly, textoPregunta, parseInt(duracionSegundos) || 60]
    );
    const preguntaId = result.insertId;
    for (let i = 0; i < opciones.length; i++) {
      await db.query(`INSERT INTO opciones_pregunta (pregunta_id, texto_opcion, orden) VALUES (?, ?, ?)`, [preguntaId, opciones[i], i + 1]);
    }
    assemblyDraftPreview.delete(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('question:draft_preview', { isTyping: false });
    io.to(`assembly_${targetAssembly}`).emit('questions:updated');
    res.json({ ok: true, preguntaId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { textoPregunta, duracionSegundos, opciones, assemblyId } = req.body;
    const targetAssembly = parseInt(assemblyId) || 1;
    await db.query(`UPDATE preguntas SET texto_pregunta = ?, duracion_segundos = ? WHERE id = ?`, [textoPregunta, parseInt(duracionSegundos) || 60, id]);
    
    if (opciones && opciones.length >= 2) {
      await db.query(`DELETE FROM opciones_pregunta WHERE pregunta_id = ?`, [id]);
      for (let i = 0; i < opciones.length; i++) {
        await db.query(`INSERT INTO opciones_pregunta (pregunta_id, texto_opcion, orden) VALUES (?, ?, ?)`, [id, opciones[i], i + 1]);
      }
    }
    assemblyDraftPreview.delete(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('question:draft_preview', { isTyping: false });
    io.to(`assembly_${targetAssembly}`).emit('questions:updated');
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

    const targetAssembly = parseInt(assemblyId) || 1;
    io.to(`assembly_${targetAssembly}`).emit('questions:updated');
    res.json({ ok: true, message: 'Pregunta y sus votos fueron eliminados correctamente.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
// =========================================================================
// FIN SECCION 13: API REST - PREGUNTAS Y OPCIONES DE VOTACION
// =========================================================================

// =========================================================================
// INICIO SECCION 14: API REST - GESTION DE PODERES Y ACCIONES DIRECTAS EMAIL
// =========================================================================
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

    for (let pod of poderes) {
      pod.apoderado_coef_efectivo = await getUserEffectiveCoefficient(pod.apoderado_num_id, assemblyId);
    }

    res.json({ ok: true, poderes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/powers/:id/quick-action', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, token } = req.query;

    if (!id || !status || !token) {
      return res.status(400).send(renderResponseHTML('Error de Solicitud', 'Parámetros incompletos en el enlace.', false));
    }

    const expectedToken = generatePowerActionToken(id, status);
    if (token !== expectedToken) {
      return res.status(403).send(renderResponseHTML('Enlace Inválido', 'El token de seguridad no es válido o ha expirado.', false));
    }

    const [podRows] = await db.query(
      `SELECT p.id, p.assembly_id, p.estado, u_ot.nombre_completo AS otorgante, u_ap.nombre_completo AS apoderado 
       FROM poderes p
       JOIN usuarios u_ot ON p.otorgante_id = u_ot.id
       JOIN usuarios u_ap ON p.apoderado_id = u_ap.id
       WHERE p.id = ?`,
      [id]
    );

    if (podRows.length === 0) {
      return res.status(404).send(renderResponseHTML('No Encontrado', 'El poder especificado no existe.', false));
    }

    const poder = podRows[0];
    const nuevoEstado = status === 'autorizado' ? 'autorizado' : 'rechazado';
    const observacion = `Procesado mediante acción directa desde correo electrónico el ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`;

    await db.query(`UPDATE poderes SET estado = ?, observaciones = ? WHERE id = ?`, [nuevoEstado, observacion, id]);

    await updateAndBroadcastQuorum(poder.assembly_id);
    io.to(`assembly_${poder.assembly_id}`).emit('powers:updated');

    const colorHeader = nuevoEstado === 'autorizado' ? '#10b981' : '#ef4444';
    const tituloResultado = nuevoEstado === 'autorizado' ? 'Poder Aprobado y Autorizado' : 'Poder Rechazado';
    const mensajeDetalle = `El poder otorgado por <strong>${poder.otorgante}</strong> a favor de <strong>${poder.apoderado}</strong> ha sido marcado como <strong>${nuevoEstado.toUpperCase()}</strong> correctamente.`;

    return res.send(renderResponseHTML(tituloResultado, mensajeDetalle, true, colorHeader));

  } catch (err) {
    console.error('Error en quick-action poder:', err);
    return res.status(500).send(renderResponseHTML('Error Interno', 'No se pudo procesar la solicitud.', false));
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
    const targetAssembly = parseInt(assemblyId) || 1;
    const cleanOtorgante = (otorganteUnico || '').toString().trim().toUpperCase();
    const cleanApoderado = (apoderadoUnico || '').toString().trim().toUpperCase();

    const [otorgantes] = await db.query(
      `SELECT id, nombre_completo, unidad FROM usuarios WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`,
      [targetAssembly, cleanOtorgante]
    );
    const [apoderados] = await db.query(
      `SELECT id, nombre_completo, unidad FROM usuarios WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`,
      [targetAssembly, cleanApoderado]
    );

    if (otorgantes.length === 0) return res.status(400).json({ ok: false, error: 'El otorgante no existe.' });
    if (apoderados.length === 0) return res.status(400).json({ ok: false, error: 'El apoderado no existe.' });

    const otorganteUser = otorgantes[0];
    const apoderadoUser = apoderados[0];

    const [resultPoder] = await db.query(
      `INSERT INTO poderes (assembly_id, otorgante_id, apoderado_id, documento_url, estado) VALUES (?, ?, ?, ?, 'pendiente')`,
      [targetAssembly, otorganteUser.id, apoderadoUser.id, documentoUrl]
    );

    const powerId = resultPoder.insertId;
    io.to(`assembly_${targetAssembly}`).emit('powers:updated');

    try {
      const [reps] = await db.query(
        `SELECT email, nombre_completo FROM usuarios 
         WHERE assembly_id = ? AND rol IN ('representante_legal', 'administrador') AND email IS NOT NULL AND email != ''`,
        [targetAssembly]
      );

      const [asamblea] = await db.query(`SELECT nombre_copropiedad FROM asambleas WHERE id = ?`, [targetAssembly]);
      const nombreCopropiedad = asamblea.length > 0 ? asamblea[0].nombre_copropiedad : 'Asamblea Virtual';

      if (reps.length > 0) {
        const emailsDestino = reps.map(r => r.email);
        const fromSender = process.env.RESEND_FROM_EMAIL || 'contacto@ajaudiovisual.com';
        const serverBaseUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;

        const tokenApprove = generatePowerActionToken(powerId, 'autorizado');
        const tokenReject = generatePowerActionToken(powerId, 'rechazado');

        const approveLink = `${serverBaseUrl}/api/powers/${powerId}/quick-action?status=autorizado&token=${tokenApprove}`;
        const rejectLink = `${serverBaseUrl}/api/powers/${powerId}/quick-action?status=rechazado&token=${tokenReject}`;

        let attachments = [];
        if (documentoUrl && documentoUrl.startsWith('data:')) {
          const matches = documentoUrl.match(/^data:(.+);base64,(.+)$/);
          if (matches) {
            const mimeType = matches[1];
            const base64Content = matches[2];
            let ext = 'pdf';
            if (mimeType.includes('png')) ext = 'png';
            else if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = 'jpg';

            attachments.push({
              filename: `Poder_${cleanOtorgante}_a_${cleanApoderado}.${ext}`,
              content: Buffer.from(base64Content, 'base64')
            });
          }
        }

        await resend.emails.send({
          from: `${nombreCopropiedad} <${fromSender}>`,
          to: emailsDestino,
          subject: `🚨 Alerta: Nuevo Poder Pendiente por Autorizar - ${nombreCopropiedad}`,
          text: `Atención Representante Legal, se ha recibido un nuevo poder pendiente por aprobación.\nOtorgante: ${otorganteUser.nombre_completo} (${otorganteUser.unidad})\nApoderado: ${apoderadoUser.nombre_completo} (${apoderadoUser.unidad})\nAprobar: ${approveLink}\nRechazar: ${rejectLink}`,
          html: `
            <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 25px; border-radius: 12px; max-width: 600px; margin: auto;">
              <h2 style="color: #f59e0b; text-align: center; margin-bottom: 20px;">⚠️ Nuevo Poder Pendiente de Autorización</h2>
              <p style="font-size: 14px; line-height: 1.6;">Estimado(a) Representante Legal / Administrador,</p>
              <p style="font-size: 14px; line-height: 1.6;">Se ha radicado una solicitud de poder en la plataforma para la copropiedad <strong>${nombreCopropiedad}</strong>.</p>
              
              <div style="background-color: #1e293b; padding: 18px; border-radius: 8px; border-left: 4px solid #f59e0b; margin: 20px 0;">
                <p style="margin: 6px 0; font-size: 14px;"><strong>Otorgante:</strong> ${otorganteUser.nombre_completo} (Unidad: ${otorganteUser.unidad})</p>
                <p style="margin: 6px 0; font-size: 14px;"><strong>Apoderado:</strong> ${apoderadoUser.nombre_completo} (Unidad: ${apoderadoUser.unidad})</p>
                <p style="margin: 6px 0; font-size: 14px;"><strong>Estado:</strong> <span style="color: #f59e0b; font-weight: bold;">PENDIENTE DE REVISIÓN</span></p>
              </div>

              <div style="text-align: center; margin: 25px 0;">
                <a href="${approveLink}" target="_blank" style="background-color: #10b981; color: #ffffff; padding: 12px 24px; border-radius: 8px; font-weight: bold; text-decoration: none; display: inline-block; margin-right: 10px; font-size: 14px;">
                  ✓ APROBAR PODER
                </a>
                <a href="${rejectLink}" target="_blank" style="background-color: #ef4444; color: #ffffff; padding: 12px 24px; border-radius: 8px; font-weight: bold; text-decoration: none; display: inline-block; font-size: 14px;">
                  ✕ RECHAZAR PODER
                </a>
              </div>

              <p style="font-size: 12px; color: #cbd5e1; line-height: 1.6; text-align: center;">
                El documento adjunto se encuentra disponible en este correo. Puede hacer clic en cualquiera de los botones superiores para autorizar o rechazar este poder de manera inmediata.
              </p>

              <p style="font-size: 11px; color: #64748b; text-align: center; margin-top: 30px; border-top: 1px solid #334155; padding-top: 15px;">
                Notificación automática del Sistema de Asambleas Virtuales.
              </p>
            </div>
          `,
          attachments: attachments
        });
      }
    } catch (emailErr) {
      console.error('Error al enviar correo de alerta de poder al representante:', emailErr);
    }

    res.json({ ok: true, message: 'Poder registrado exitosamente y notificación enviada al representante legal.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
// =========================================================================
// FIN SECCION 14: API REST - GESTION DE PODERES Y ACCIONES DIRECTAS EMAIL
// =========================================================================
  // =========================================================================
// INICIO SECCION 15: API REST - CONSULTA DE USUARIOS Y REPORTES (EXCEL Y PDF)
// =========================================================================
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

    for (let u of usuarios) {
      u.coeficiente_efectivo = await getUserEffectiveCoefficient(u.id, assemblyId);
    }

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
      if (parseInt(session.assemblyId) === parseInt(id) && session.userId > 0) {
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
// =========================================================================
// FIN SECCION 15: API REST - CONSULTA DE USUARIOS Y REPORTES (EXCEL Y PDF)
// =========================================================================

// =========================================================================
// INICIO SECCION 16: API REST - FIRMAS JWT ZOOM SDK Y COMPUERTA DE SALA
// =========================================================================
// GENERADOR DE FIRMAS OFICIALES DEL SDK DE ZOOM
app.post('/api/zoom/signature', async (req, res) => {
  try {
    const { meetingNumber, role } = req.body;
    const sdkKey = (process.env.ZOOM_SDK_KEY || 'dPDveYuySJKLhCdur6gOiQ').trim();
    const sdkSecret = (process.env.ZOOM_SDK_SECRET || 'eunmyWxjZ36p17tn2mTPzLvV2hRXFLwc').trim();

    const cleanMn = parseInt((meetingNumber || '').toString().replace(/\D/g, ''), 10);
    if (!cleanMn || isNaN(cleanMn)) return res.status(400).json({ ok: false, error: 'ID Zoom Inválido.' });

    const requestedRole = parseInt(role || 0, 10) === 1 ? 1 : 0;

    const zoomNow = await getZoomServerUnixTime();
    const iat = zoomNow - 30;
    const exp = iat + 60 * 60 * 2;

    const oHeader = { alg: 'HS256', typ: 'JWT' };
    const oPayload = {
      sdkKey,
      appKey: sdkKey,
      mn: cleanMn,
      role: requestedRole,
      iat,
      exp,
      tokenExp: exp
    };

    const sHeader = toBase64Url(JSON.stringify(oHeader));
    const sPayload = toBase64Url(JSON.stringify(oPayload));
    const dataToSign = `${sHeader}.${sPayload}`;
    const hmac = crypto.createHmac('sha256', sdkSecret).update(dataToSign).digest();
    const signature = toBase64Url(hmac);

    let zakToken = null;
    if (requestedRole === 1) {
      zakToken = await getZoomHostZakToken();
    }

    res.json({ ok: true, signature: `${dataToSign}.${signature}`, sdkKey, zakToken, role: requestedRole });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// CONSULTA DE PARÁMETROS DE ZOOM CON COMPUERTA DE BLOQUEO PARA ASISTENTES
app.get('/api/assemblies/:id/zoom', async (req, res) => {
  try {
    const { id } = req.params;
    const isAdminQuery = req.query.admin === 'true';
    const streamInfo = await getAssemblyZoomStreamInfo(id);

    if (!isAdminQuery && !streamInfo.zoomHabilitado) {
      return res.json({
        ok: true,
        zoom: {
          rawUrl: '',
          meetingId: '',
          passcode: '',
          zoomHabilitado: false
        }
      });
    }

    res.json({ ok: true, zoom: streamInfo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/assemblies/:id/zoom', async (req, res) => {
  try {
    const { id } = req.params;
    const targetAssembly = parseInt(id) || 1;
    const { zoomEmbedUrl, zoomPasscode } = req.body;
    const parsed = parseZoomCredentials(zoomEmbedUrl, zoomPasscode);
    await db.query(`UPDATE asambleas SET zoom_embed_url = ?, zoom_meeting_id = ?, zoom_passcode = ? WHERE id = ?`, [zoomEmbedUrl, parsed.meetingId, parsed.passcode, targetAssembly]);
    const streamData = await getAssemblyZoomStreamInfo(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('zoom:updated', { streamInfo: streamData });
    res.json({ ok: true, message: 'Zoom actualizado.', streamInfo: streamData });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// INTERRUPTOR EN ADMIN PARA ABRIR O CERRAR EL ACCESO A LA SALA DE ZOOM A LOS PARTICIPANTES
app.put('/api/assemblies/:id/zoom-gate', async (req, res) => {
  try {
    const { id } = req.params;
    const targetAssembly = parseInt(id) || 1;
    const { habilitado } = req.body;
    const isOpen = !!habilitado;

    assemblyZoomOpen.set(targetAssembly, isOpen);
    try {
      await db.query(`UPDATE asambleas SET zoom_habilitado = ? WHERE id = ?`, [isOpen ? 1 : 0, targetAssembly]);
    } catch (e) {}

    const streamData = await getAssemblyZoomStreamInfo(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('zoom:updated', { streamInfo: streamData });

    res.json({
      ok: true,
      zoomHabilitado: isOpen,
      streamInfo: streamData,
      message: isOpen
        ? '🔓 Sala de Zoom HABILITADA: Todos los participantes pueden ver e ingresar a la reunión.'
        : '🔒 Sala de Zoom EN ESPERA: Los participantes no pueden iniciar ni entrar a la reunión hasta que la habilites.'
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'online', version: '3.5.0-media-permissions' }));
// =========================================================================
// FIN SECCION 16: API REST - FIRMAS JWT ZOOM SDK Y COMPUERTA DE SALA
// =========================================================================

// =========================================================================
// INICIO SECCION 17: SOCKET.IO - CONEXION, AUTENTICACION Y QUORUM EN VIVO
// =========================================================================
// WEBSOCKETS EN TIEMPO REAL
io.on('connection', (socket) => {

  socket.on('auth:join', async ({ assemblyId, identificadorUnico, email, password, isConsoleAdmin, rolConsola, nombreConsola }) => {
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

      if (rows.length === 0 && (targetEmail || targetId)) {
        const [controlRows] = await db.query(
          `SELECT id, identificador_unico, nombre_completo, unidad, email, password, coeficiente, rol 
           FROM usuarios 
           WHERE (LOWER(email) = ? OR UPPER(identificador_unico) = ?) 
             AND rol IN ('administrador', 'soporte', 'moderador', 'representante_legal')
           ORDER BY id DESC LIMIT 1`,
          [targetEmail || targetId.toLowerCase(), targetId]
        );
        if (controlRows.length > 0) {
          rows = [{
            ...controlRows[0],
            coeficiente: 0.00000
          }];
        }
      }

      if (
        rows.length === 0 &&
        (
          targetId === 'SUPERADMIN' ||
          targetId.startsWith('ADMIN-') ||
          targetId.startsWith('MODERADOR-') ||
          targetId.startsWith('REPRESENTANTE_LEGAL-') ||
          targetEmail === SUPERADMIN_EMAIL.toLowerCase() ||
          isConsoleAdmin
        )
      ) {
        rows = [{
          id: 0,
          identificador_unico: targetId || 'SUPERADMIN',
          nombre_completo: nombreConsola || 'Consola de Control',
          unidad: 'CONTROL',
          coeficiente: 0.00000,
          rol: rolConsola || 'superadmin'
        }];
      }

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

      if (!isConsoleAdmin && user.password && user.password.trim() !== '' && user.rol === 'asistente') {
        if (!targetPassword) {
          return socket.emit('auth:error', 'Ingresa tu contraseña.');
        }
        const isMatch = await bcrypt.compare(targetPassword, user.password);
        if (!isMatch) {
          return socket.emit('auth:error', 'Contraseña incorrecta.');
        }
      }

      const userId = user.id;
      const isControlRole = ['superadmin', 'administrador', 'moderador', 'representante_legal', 'soporte'].includes((user.rol || '').toLowerCase());
      const sessionKey = (isConsoleAdmin || userId === 0)
        ? `${targetAssembly}_CONSOLE_${userId}_${socket.id}`
        : `${targetAssembly}_${userId}`;

      if (!isConsoleAdmin && userId > 0 && !isControlRole && activeSessions.has(sessionKey)) {
        const existingSession = activeSessions.get(sessionKey);
        if (existingSession.socketId !== socket.id) {
          io.to(existingSession.socketId).emit('auth:kicked', { message: 'Tu sesión ha sido iniciada en otro dispositivo.' });
        }
      }

      if (!isConsoleAdmin) {
        activeSessions.set(sessionKey, {
          userId,
          assemblyId: targetAssembly,
          socketId: socket.id,
          identificadorUnico: user.identificador_unico,
          nombreCompleto: user.nombre_completo,
          unidad: user.unidad,
          rol: user.rol
        });
        socketUserMap.set(socket.id, sessionKey);
        socket.sessionKey = sessionKey;
      }

      socket.assemblyId = targetAssembly;
      socket.userId = userId;
      socket.identificadorUnico = user.identificador_unico;
      socket.nombreCompleto = user.nombre_completo;
      socket.unidad = user.unidad;

      const roomName = `assembly_${targetAssembly}`;
      socket.join(roomName);

      const { coefPoderes, representadosAprobados, representadosPendientes, isRepresented } = await getUserPowerDetails(userId, targetAssembly);
      user.coeficientePropio = parseFloat(user.coeficiente) || 0;
      user.coeficientePoderes = coefPoderes;
      user.coeficienteEfectivo = (isRepresented || user.rol === 'soporte' || userId === 0) ? 0 : (user.coeficientePropio + coefPoderes);
      user.isRepresented = isRepresented;
      user.poderesAprobados = representadosAprobados;
      user.poderesPendientes = representadosPendientes;

      socket.emit('auth:success', { user, room: roomName });

      const chatHistoryAssembly = memoryChat.filter(m => parseInt(m.assemblyId) === targetAssembly && !m.esManoLevantada);
      const isPausedNow = assemblyChatActive.get(targetAssembly) === false;
      const pinnedNow = assemblyPinnedMessage.get(targetAssembly) || null;
      const mutedSet = getMutedSetForAssembly(targetAssembly);
      const mutedArray = Array.from(mutedSet);
      const raisedHandsNow = getRaisedHandsForAssembly(targetAssembly);
      const mediaPermsObj = serializeMediaPermissions(targetAssembly);

      socket.emit('chat:history', {
        messages: chatHistoryAssembly,
        paused: isPausedNow,
        pinnedMessage: pinnedNow,
        mutedUsers: mutedArray,
        raisedHands: raisedHandsNow,
        mediaPermissions: mediaPermsObj
      });

      socket.emit('media:permissions_updated', {
        mediaPermissions: mediaPermsObj
      });

      if (assemblyDraftPreview.has(targetAssembly)) {
        socket.emit('question:draft_preview', assemblyDraftPreview.get(targetAssembly));
      }

      await updateAndBroadcastQuorum(targetAssembly);

      if (activeQuestions.has(targetAssembly)) {
        const activeQ = activeQuestions.get(targetAssembly);
        const stats = await getVotingStats(targetAssembly, activeQ.id);
        const resultados = await calculateWeightedResults(targetAssembly, activeQ.id);
        const [votoUsuario] = await db.query(`SELECT opcion_id FROM votos WHERE pregunta_id = ? AND usuario_id = ?`, [activeQ.id, userId]);
        socket.emit('voting:current_state', { ...activeQ, stats, resultados, myCurrentVote: votoUsuario.length > 0 ? votoUsuario[0].opcion_id : null });
      }
    } catch (error) {
      console.error('Error al autenticar socket:', error);
      socket.emit('auth:error', 'Error interno al autenticar.');
    }
  });

  socket.on('auth:refresh_user', async () => {
    try {
      const { assemblyId, userId } = socket;
      if (!assemblyId || !userId) return;

      const [rows] = await db.query(
        `SELECT id, identificador_unico, nombre_completo, unidad, email, coeficiente, rol FROM usuarios WHERE id = ?`,
        [userId]
      );
      if (rows.length === 0) return;

      const user = rows[0];
      const { coefPoderes, representadosAprobados, representadosPendientes, isRepresented } = await getUserPowerDetails(userId, assemblyId);
      user.coeficientePropio = parseFloat(user.coeficiente) || 0;
      user.coeficientePoderes = coefPoderes;
      user.coeficienteEfectivo = (isRepresented || user.rol === 'soporte') ? 0 : (user.coeficientePropio + coefPoderes);
      user.isRepresented = isRepresented;
      user.poderesAprobados = representadosAprobados;
      user.poderesPendientes = representadosPendientes;

      socket.emit('user:coef_updated', { user });
    } catch (err) {
      console.error('Error en auth:refresh_user:', err);
    }
  });
// =========================================================================
// FIN SECCION 17: SOCKET.IO - CONEXION, AUTENTICACION Y QUORUM EN VIVO
// =========================================================================
      // =========================================================================
// INICIO SECCION 18: SOCKET.IO - PERMISOS MEDIA, MANOS LEVANTADAS Y CHAT
// =========================================================================
  // CONTROL DE PERMISOS DE MICRÓFONO Y CÁMARA POR COPROPIETARIO DESDE ADMIN
  socket.on('admin:toggle_user_media', ({ assemblyId, targetKey, mediaType, allow }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    if (!targetKey || !['mic', 'cam'].includes(mediaType)) return;

    const cleanKey = String(targetKey).trim().toUpperCase();
    const map = getMediaPermissionsMapForAssembly(targetAssembly);
    const current = map.get(cleanKey) || { mic: false, cam: false };

    current[mediaType] = !!allow;
    map.set(cleanKey, current);

    io.to(`assembly_${targetAssembly}`).emit('media:permissions_updated', {
      mediaPermissions: serializeMediaPermissions(targetAssembly),
      changedKey: cleanKey,
      changedType: mediaType,
      allowed: !!allow
    });
  });

  // Revocar micrófono y cámara a todos los copropietarios de un solo clic
  socket.on('admin:revoke_all_media', ({ assemblyId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    assemblyMediaPermissions.set(targetAssembly, new Map());

    io.to(`assembly_${targetAssembly}`).emit('media:permissions_updated', {
      mediaPermissions: {},
      revokedAll: true
    });
  });

  socket.on('admin:zoom_host_started', async ({ assemblyId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    assemblyZoomOpen.set(targetAssembly, true);
    try {
      await db.query(`UPDATE asambleas SET zoom_habilitado = 1 WHERE id = ?`, [targetAssembly]);
    } catch (e) {}
    const streamData = await getAssemblyZoomStreamInfo(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('zoom:updated', { streamInfo: streamData });
  });

  socket.on('admin:typing_question', ({ assemblyId, isTyping, textoPregunta, duracionSegundos, opciones }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    if (!isTyping || !textoPregunta || textoPregunta.toString().trim() === '') {
      assemblyDraftPreview.delete(targetAssembly);
      io.to(`assembly_${targetAssembly}`).emit('question:draft_preview', { isTyping: false });
      return;
    }

    const draftPayload = {
      isTyping: true,
      textoPregunta: textoPregunta.toString().trim(),
      duracionSegundos: parseInt(duracionSegundos) || 60,
      opciones: Array.isArray(opciones) ? opciones : []
    };

    assemblyDraftPreview.set(targetAssembly, draftPayload);
    io.to(`assembly_${targetAssembly}`).emit('question:draft_preview', draftPayload);
  });

  // COLA ENUMERADA DE LEVANTAR / BAJAR LA MANO
  socket.on('chat:toggle_hand', ({ assemblyId, userId, identificadorUnico, nombreCompleto, unidad, raise }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    const effectiveUserId = userId !== undefined ? userId : (socket.userId || 0);
    const effectiveIdentificador = (identificadorUnico || socket.identificadorUnico || String(effectiveUserId)).toString().trim().toUpperCase();
    const effectiveNombre = (nombreCompleto || socket.nombreCompleto || 'Asistente').toString().trim();
    const effectiveUnidad = (unidad || socket.unidad || '---').toString().trim();

    if (!effectiveIdentificador) return;

    const handsQueue = getRaisedHandsForAssembly(targetAssembly);
    const existingIdx = handsQueue.findIndex(h => h.key === effectiveIdentificador);

    if (raise) {
      if (existingIdx === -1) {
        const horaStr = new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });
        handsQueue.push({
          key: effectiveIdentificador,
          userId: effectiveUserId,
          identificadorUnico: effectiveIdentificador,
          nombreCompleto: effectiveNombre,
          unidad: effectiveUnidad,
          hora: horaStr,
          timestamp: Date.now()
        });
      }
    } else {
      if (existingIdx !== -1) {
        handsQueue.splice(existingIdx, 1);
      }
    }

    io.to(`assembly_${targetAssembly}`).emit('chat:hands_updated', {
      raisedHands: handsQueue
    });
  });

  socket.on('admin:lower_hand', ({ assemblyId, targetKey }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    if (!targetKey) return;
    const cleanKey = String(targetKey).trim().toUpperCase();
    const handsQueue = getRaisedHandsForAssembly(targetAssembly);
    const idx = handsQueue.findIndex(h => h.key === cleanKey || String(h.userId).toUpperCase() === cleanKey);

    if (idx !== -1) {
      handsQueue.splice(idx, 1);
      io.to(`assembly_${targetAssembly}`).emit('chat:hands_updated', {
        raisedHands: handsQueue
      });
    }
  });

  socket.on('admin:clear_hands', ({ assemblyId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    assemblyRaisedHands.set(targetAssembly, []);
    io.to(`assembly_${targetAssembly}`).emit('chat:hands_updated', {
      raisedHands: []
    });
  });

  socket.on('chat:message', ({ assemblyId, texto, emisor, unidad, esOficial, senderId, senderIdentificador }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    const isPaused = assemblyChatActive.get(targetAssembly) === false;

    if (isPaused && !esOficial) {
      return;
    }

    const effectiveUserId = senderId !== undefined ? senderId : (socket.userId || 0);
    const effectiveIdentificador = (senderIdentificador || socket.identificadorUnico || '').toString().trim().toUpperCase();

    const mutedSet = getMutedSetForAssembly(targetAssembly);
    if (
      !esOficial &&
      (
        (effectiveUserId && mutedSet.has(String(effectiveUserId))) ||
        (effectiveIdentificador && mutedSet.has(effectiveIdentificador))
      )
    ) {
      socket.emit('chat:error_muted', { message: 'Has sido silenciado en el chat por el moderador.' });
      return;
    }

    const msgData = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      assemblyId: targetAssembly,
      userId: effectiveUserId,
      identificadorUnico: effectiveIdentificador,
      texto: (texto || '').toString().trim().slice(0, 300),
      emisor: emisor || 'Asistente',
      unidad: unidad || '---',
      esOficial: !!esOficial,
      hora: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' })
    };
    memoryChat.push(msgData);
    if (memoryChat.length > 1000) memoryChat.shift();
    io.to(`assembly_${targetAssembly}`).emit('chat:broadcast', msgData);
  });

  socket.on('admin:toggle_chat', ({ assemblyId, paused }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    assemblyChatActive.set(targetAssembly, !paused);
    io.to(`assembly_${targetAssembly}`).emit('chat:status', { paused: !!paused });
  });

  socket.on('admin:clear_chat', ({ assemblyId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    for (let i = memoryChat.length - 1; i >= 0; i--) {
      if (parseInt(memoryChat[i].assemblyId) === targetAssembly) {
        memoryChat.splice(i, 1);
      }
    }
    assemblyPinnedMessage.delete(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('chat:cleared');
    io.to(`assembly_${targetAssembly}`).emit('chat:pinned_updated', { pinnedMessage: null });
  });

  socket.on('admin:delete_chat_message', ({ assemblyId, messageId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    const index = memoryChat.findIndex(m => parseInt(m.assemblyId) === targetAssembly && String(m.id) === String(messageId));
    if (index !== -1) {
      memoryChat.splice(index, 1);
    }

    const currentPinned = assemblyPinnedMessage.get(targetAssembly);
    if (currentPinned && String(currentPinned.id) === String(messageId)) {
      assemblyPinnedMessage.delete(targetAssembly);
      io.to(`assembly_${targetAssembly}`).emit('chat:pinned_updated', { pinnedMessage: null });
    }

    io.to(`assembly_${targetAssembly}`).emit('chat:message_deleted', { messageId });
  });

  socket.on('admin:pin_chat_message', ({ assemblyId, messageId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    if (!messageId) {
      assemblyPinnedMessage.delete(targetAssembly);
      io.to(`assembly_${targetAssembly}`).emit('chat:pinned_updated', { pinnedMessage: null });
      return;
    }

    const foundMsg = memoryChat.find(m => parseInt(m.assemblyId) === targetAssembly && String(m.id) === String(messageId));
    if (foundMsg) {
      assemblyPinnedMessage.set(targetAssembly, foundMsg);
      io.to(`assembly_${targetAssembly}`).emit('chat:pinned_updated', { pinnedMessage: foundMsg });
    }
  });

  socket.on('admin:toggle_mute_user', ({ assemblyId, targetKey, mute }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    if (!targetKey) return;
    const cleanKey = String(targetKey).trim().toUpperCase();
    const mutedSet = getMutedSetForAssembly(targetAssembly);

    if (mute) {
      mutedSet.add(cleanKey);
    } else {
      mutedSet.delete(cleanKey);
    }

    io.to(`assembly_${targetAssembly}`).emit('chat:muted_users_updated', {
      mutedUsers: Array.from(mutedSet)
    });
  });
// =========================================================================
// FIN SECCION 18: SOCKET.IO - PERMISOS MEDIA, MANOS LEVANTADAS Y CHAT
// =========================================================================

// =========================================================================
// INICIO SECCION 19: SOCKET.IO - VOTACIONES EN TIEMPO REAL Y CRONOMETRO
// =========================================================================
  socket.on('admin:start_voting', async ({ assemblyId, preguntaId, duracionSegundos }) => {
    try {
      const targetAssembly = parseInt(assemblyId) || 1;
      if (timerIntervals.has(targetAssembly)) clearInterval(timerIntervals.get(targetAssembly));
      await db.query(`UPDATE preguntas SET estado = 'activa' WHERE id = ? AND assembly_id = ?`, [preguntaId, targetAssembly]);

      const [preguntas] = await db.query(`SELECT id, texto_pregunta FROM preguntas WHERE id = ?`, [preguntaId]);
      const [opciones] = await db.query(`SELECT id, texto_opcion FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`, [preguntaId]);
      if (preguntas.length === 0) return;

      const duracion = parseInt(duracionSegundos) || 60;
      const stats = await getVotingStats(targetAssembly, preguntaId);
      const resultados = await calculateWeightedResults(targetAssembly, preguntaId);
      const activeQData = { id: preguntas[0].id, texto: preguntas[0].texto_pregunta, opciones, duracion, tiempoRestante: duracion, isOpen: true, stats, resultados };

      activeQuestions.set(targetAssembly, activeQData);
      assemblyDraftPreview.delete(targetAssembly);
      const roomName = `assembly_${targetAssembly}`;

      io.to(roomName).emit('question:draft_preview', { isTyping: false });
      io.to(roomName).emit('voting:started', activeQData);
      io.to(roomName).emit('questions:updated');

      const interval = setInterval(async () => {
        const currentQ = activeQuestions.get(targetAssembly);
        if (!currentQ) { clearInterval(interval); return; }

        currentQ.tiempoRestante -= 1;
        io.to(roomName).emit('timer:tick', { tiempoRestante: currentQ.tiempoRestante });

        if (currentQ.tiempoRestante <= 0) {
          clearInterval(interval);
          timerIntervals.delete(targetAssembly);
          currentQ.isOpen = false;

          await db.query(`UPDATE preguntas SET estado = 'cerrada' WHERE id = ?`, [preguntaId]);
          const finalResults = await calculateWeightedResults(targetAssembly, preguntaId);
          const finalStats = await getVotingStats(targetAssembly, preguntaId);

          io.to(roomName).emit('voting:closed', { preguntaId, resultados: finalResults, stats: finalStats });
          io.to(roomName).emit('questions:updated');
          activeQuestions.delete(targetAssembly);
        }
      }, 1000);

      timerIntervals.set(targetAssembly, interval);
    } catch (error) {
      console.error('Error al iniciar votación:', error);
    }
  });

  socket.on('admin:stop_voting', async ({ assemblyId, preguntaId }) => {
    try {
      const targetAssembly = parseInt(assemblyId) || 1;
      if (timerIntervals.has(targetAssembly)) {
        clearInterval(timerIntervals.get(targetAssembly));
        timerIntervals.delete(targetAssembly);
      }
      const currentQ = activeQuestions.get(targetAssembly);
      if (currentQ) { currentQ.isOpen = false; activeQuestions.delete(targetAssembly); }

      await db.query(`UPDATE preguntas SET estado = 'cerrada' WHERE id = ? AND assembly_id = ?`, [preguntaId, targetAssembly]);
      const finalResults = await calculateWeightedResults(targetAssembly, preguntaId);
      const finalStats = await getVotingStats(targetAssembly, preguntaId);

      const roomName = `assembly_${targetAssembly}`;
      io.to(roomName).emit('voting:closed', { preguntaId, resultados: finalResults, stats: finalStats });
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
      const { isRepresented, apoderadoNombre } = await checkUserRepresentedStatus(userId, assemblyId);
      if (isRepresented) {
        return socket.emit('vote:rejected', { message: `No puedes votar directamente. Tus derechos de voto están delegados por poder autorizado a ${apoderadoNombre}.` });
      }

      const [poderesAprobados] = await db.query(
        `SELECT p.otorgante_id, u.coeficiente
         FROM poderes p
         JOIN usuarios u ON p.otorgante_id = u.id
         WHERE p.apoderado_id = ? AND p.assembly_id = ? AND p.estado = 'autorizado'`,
        [userId, assemblyId]
      );

      const [u] = await db.query(`SELECT id, coeficiente, rol FROM usuarios WHERE id = ?`, [userId]);
      if (u.length === 0) return;

      const voterList = [];

      if (u[0].rol !== 'soporte') {
        const propioCoef = parseFloat(u[0].coeficiente) || 0;
        if (propioCoef > 0 || poderesAprobados.length === 0) {
          voterList.push({ usuarioId: u[0].id, coef: propioCoef });
        }
      }

      for (const pod of poderesAprobados) {
        voterList.push({ usuarioId: pod.otorgante_id, coef: parseFloat(pod.coeficiente) || 0 });
      }

      if (voterList.length === 0) {
        return socket.emit('vote:rejected', { message: 'Tu coeficiente habilitado de voto es 0.0000%.' });
      }

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
// =========================================================================
// FIN SECCION 19: SOCKET.IO - VOTACIONES EN TIEMPO REAL Y CRONOMETRO
// =========================================================================

// =========================================================================
// INICIO SECCION 20: DESCONEXION DE SOCKET Y ARRANQUE DEL SERVIDOR
// =========================================================================
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
server.listen(PORT, () => console.log(`🚀 Servidor de Asambleas v3.5.0-media-permissions corriendo en puerto ${PORT}`));
// =========================================================================
// FIN SECCION 20: DESCONEXION DE SOCKET Y ARRANQUE DEL SERVIDOR
// =========================================================================
