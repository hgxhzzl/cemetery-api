// operator_power 动作列删除脚本 20261023 动作列迁移新增(不可逆,最后一步执行):
// 删除 useCreate/useModify/useDelete/useExamine/useFinish/usePower 六个布尔列。
// 这些列的动作级授权已迁移到 powerConfig 功能权限白名单,后端守卫与前端判权均已切换后,列即为死数据。
// 先查 information_schema.COLUMNS,仅 DROP 当前仍存在的列,重复运行安全(不存在则跳过)。
// ⚠️ 执行前置条件:migrate-power-config.js 已回填 + 后端(catalog/守卫/save/seeding)与前端(判权/权限页矩阵)均已发布,
//    且 check-syntax / 后端 npm test / 前端 vitest+eslint 全量通过。否则在途请求会因列缺失而读不到字段。
require('dotenv').config({ quiet: true });

const mysql = require('mysql2/promise');
const config = require('../config');

const TABLE_NAME = 'operator_power';
const DROP_COLUMNS = ['useCreate', 'useModify', 'useDelete', 'useExamine', 'useFinish', 'usePower'];

async function tableExists(connection, table) {
  const rows = await connection.query(
    'SELECT COUNT(*) AS cnt FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = ?',
    [table],
  );
  return Number(rows[0][0].cnt) > 0;
}

async function existingColumns(connection, table, candidates) {
  const holes = candidates.map(() => '?').join(', ');
  const rows = await connection.query(
    `SELECT column_name AS c FROM information_schema.COLUMNS ` +
      `WHERE table_schema = DATABASE() AND table_name = ? AND column_name IN (${holes})`,
    [table, ...candidates],
  );
  return (rows[0] || []).map((row) => String(row.c));
}

async function runOnDatabase(connection, dbName) {
  await connection.changeUser({ database: dbName });
  console.log(`\n=== 目标库 ${dbName} ===`);
  if (!(await tableExists(connection, TABLE_NAME))) {
    console.log(`skip    ${dbName}.${TABLE_NAME} (本库无此表;operator_power 为 gm_data_000 全局表)`);
    return;
  }
  const present = await existingColumns(connection, TABLE_NAME, DROP_COLUMNS);
  if (present.length === 0) {
    console.log(`skip    ${TABLE_NAME} 六个动作列均已不存在`);
    return;
  }
  // 逐个 DROP,只删当前存在的列;反引号包裹列名(名单为固定常量,非用户输入),
  const dropList = present.map((col) => `\`${col}\``).join(', ');
  await connection.query(`ALTER TABLE \`${TABLE_NAME}\` DROP COLUMN ${dropList}`);
  console.log(`dropped ${TABLE_NAME}: ${present.join(', ')}`);
}

async function listTenantDatabases(connection) {
  const rows = await connection.query(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME REGEXP '^gm_data_[0-9]+$' ORDER BY SCHEMA_NAME",
  );
  return (rows[0] || []).map((row) => String(row.SCHEMA_NAME));
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
    multipleStatements: false,
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
      console.log(`单库模式(仅 .env 指定库): ${config.database.database}  |  operator_power 为全局表,通常只需在 gm_data_000 执行`);
    }

    for (const dbName of targets) {
      await runOnDatabase(connection, dbName);
    }
    console.log('\noperator_power 动作列删除完成(删除后请重跑登录与权限查询验证正常)。');
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
