// operator_power.powerConfig 列幂等补齐脚本 20261023 功能级权限改造新增:
// gm_data_000.sql 的列定义只对新库生效,已上线老库执行本脚本补上同一列;
// 先查 information_schema.COLUMNS,不存在才 ALTER TABLE ADD COLUMN,重复运行安全。
// 存量行一律留 NULL = "不限功能/兼容旧行为",脚本不改任何已有权限数据。
require('dotenv').config({ quiet: true });

const mysql = require('mysql2/promise');
const config = require('../config');

const COLUMN_NAME = 'powerConfig';
const TABLE_NAME = 'operator_power';

async function tableExists(connection, table) {
  const rows = await connection.query(
    'SELECT COUNT(*) AS cnt FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = ?',
    [table],
  );
  return Number(rows[0][0].cnt) > 0;
}

async function columnExists(connection, table, column) {
  const rows = await connection.query(
    'SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS ' +
      'WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column],
  );
  return Number(rows[0][0].cnt) > 0;
}

async function listTenantDatabases(connection) {
  const rows = await connection.query(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME REGEXP '^gm_data_[0-9]+$' ORDER BY SCHEMA_NAME",
  );
  return (rows[0] || []).map((row) => String(row.SCHEMA_NAME));
}

// 单库处理:operator_power 为全局表(仅 gm_data_000 有),其余库自动跳过
async function runOnDatabase(connection, dbName) {
  await connection.changeUser({ database: dbName });
  console.log(`\n=== 目标库 ${dbName} ===`);
  if (!(await tableExists(connection, TABLE_NAME))) {
    console.log(`skip    ${dbName}.${TABLE_NAME} (本库无此表)`);
    return;
  }
  if (await columnExists(connection, TABLE_NAME, COLUMN_NAME)) {
    console.log(`skip    ${TABLE_NAME}.${COLUMN_NAME} (已存在)`);
    return;
  }
  await connection.query(
    'ALTER TABLE `operator_power` ADD COLUMN `powerConfig` json NULL ' +
      "COMMENT '功能权限白名单(NULL=不限/兼容旧行为;非NULL=仅列出的1放行)' AFTER `useMenu`",
  );
  console.log(`created ${TABLE_NAME}.${COLUMN_NAME} (json)`);
}

async function main() {
  const allTenants = process.argv.includes('--all-tenants');
  const connection = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    charset: 'utf8mb4',
  });

  try {
    let targets = [config.database.database];
    if (allTenants) {
      const found = await listTenantDatabases(connection);
      if (found.length > 0) {
        targets = found;
        console.log(`--all-tenants: 匹配到 ${targets.length} 个 gm_data_* 库 -> ${targets.join(', ')}`);
      } else {
        console.warn('--all-tenants: 未匹配到任何 gm_data_* 库,回退为仅处理模板库');
      }
    } else {
      console.log(`单库模式(仅 .env 指定库): ${config.database.database}  |  跨全部 gm_data_* 库请加 --all-tenants`);
    }

    for (const dbName of targets) {
      await runOnDatabase(connection, dbName);
    }
    console.log('\npowerConfig 列补齐完成(存量行仍为 NULL,不改动任何已有权限)。');
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
