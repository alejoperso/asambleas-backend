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

const activeQuestions = new Map();
const timerIntervals = new Map();
const activeSessions = new Map();
const socketUserMap = new Map();
// Estado de chat habilitado/silenciado por asamblea (por defecto true = habilitado)
const chatEnabledMap = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    req.on('error', () => resolve(Math.floor(Date.now() / 1000)));
    req.on('timeout', () => {
      req.destroy();
      resolve(Math.floor(Date.now() / 1000));
    });
    req.end();
  });
}

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
      `ALTER TABLE asambleas MODIFY COLUMN logo_url LONGTEXT NULL`,
      `ALTER TABLE asambleas MODIFY COLUMN estado VARCHAR(50) DEFAULT 'programada'`,
      `ALTER TABLE asambleas MODIFY COLUMN zoom_embed_url LONGTEXT NULL`,
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

function isAssemblyChatEnabled(assemblyId) {
  const target = parseInt(assemblyId) || 1;
  return chatEnabledMap.has(target) ? chatEnabledMap.get(target) : true;
}

function getAssemblyChatHistory(assemblyId) {
  const target = parseInt(assemblyId) || 1;
  return memoryChat.filter(m => parseInt(m.assemblyId) === target).slice(-100);
}

function toBase64Url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function parseZoomCredentials(rawUrl, manualPasscode) {
  if (!rawUrl || typeof rawUrl !== 'string') return { meetingId: '', passcode: '' };
  const url = rawUrl.trim();
  const meetingIdMatch = url.match(/\/(?:j|wc|embed|join)\/(\d+)/) || url.replace(/\s+/g, '').match(/(\d{9,11})/);
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

// HELPER PARA OBTENER EL ESTADO ACTUAL DE QUÓRUM Y CONECTADOS DE UNA ASAMBLEA
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
  if (activeUserIds.size > 0) {
    for (let uId of activeUserIds) {
      totalQuorum += await getUserEffective
