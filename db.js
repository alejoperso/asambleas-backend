const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'asambleas.ajaudiovisual.com',
  user: process.env.DB_USER || 'ajaudiov_asambleas',
  password: process.env.DB_PASS || 'Alfaleon2026',
  database: process.env.DB_NAME || 'ajaudiov_asambleas',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

pool.getConnection()
  .then(connection => {
    console.log('✅ Conexión exitosa a la Base de Datos MySQL (ajaudiov_asambleas)');
    connection.release();
  })
  .catch(err => {
    console.error('❌ Error al conectar con la base de datos:', err.message);
  });

module.exports = pool;