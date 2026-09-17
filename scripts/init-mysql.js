require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');

async function main() {
  const sqlPath = path.resolve(__dirname, '..', 'gm_data_000.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const connection = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    multipleStatements: true,
    charset: 'utf8mb4',
  });

  try {
    await connection.query(sql);
    console.log(`Initialized MySQL database ${config.database.database} from ${path.basename(sqlPath)}`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.code || error.message || error);
  if (error.sqlMessage) {
    console.error(error.sqlMessage);
  }
  process.exit(1);
});
