// operator_power 动作列(useCreate/useModify/useDelete/usePower)→ powerConfig 功能权限白名单 幂等回填脚本 20261023 动作列迁移新增:
// 删列前先按每个操作员"当前已有的 useXxx=1"回填对应的 powerConfig 白名单,精确保留原有按钮权限(不越权、不误锁);
// 仅处理纳入功能级管控的单功能菜单(transferOut/adminfee/managementPeriod/operator/contract/account/room)且 useMenu=1 的行;
// reserve 菜单已于 20261023 随独立预定页下线,其功能动作已并入 gravePlotBusiness 菜单模板,故不再回填,
// 只写值为 1 且该菜单 menu.powerConfig 模板支持的动作;全 0 → 写 {}(=全禁,与白名单缺省禁止语义一致);
// 仅当 powerConfig IS NULL 时写入(绝不覆盖已配置行),重复运行安全。
// 平台管理员(gm_data_000 且 isAccount=1)行跳过,保留 NULL(rbac 层已短路放行,无需白名单)。
require('dotenv').config({ quiet: true });

const mysql = require('mysql2/promise');
const config = require('../config');
const permissionTemplate = require('../lib/permissionTemplate');

const TABLE_NAME = 'operator_power';

// 由旧布尔列迁移的单功能菜单(功能键 = 菜单名):room 仅 create、managementPeriod 仅 modify,其余含 create/modify/delete,
// 具体取哪些动作由 menu.powerConfig 模板逐菜单过滤,超出模板的动作列(如 room 的 useModify)自然不写入:
const MIGRATE_MENUS = ['transferOut', 'adminfee', 'managementPeriod', 'operator', 'contract', 'account', 'room'];
// ⚠ 配置类菜单(tagInfo/park/receiptConfig/cardColor)故意不在此名单:它们在旧库中 useXxx 全为 0 且页面从不读取,
// 回填只会写成 {}(全禁)把有菜单权限的操作员锁死;其 powerConfig 保持 NULL=全放行,与改造前行为一致 20261023,
// useXxx 列 → 功能动作 的映射(useExamine/useFinish 不在这些菜单的模板内,天然被 isValidAction 过滤):
const FIELD_TO_ACTION = {
  useCreate: 'create',
  useModify: 'modify',
  useDelete: 'delete',
  usePower: 'power',
};

async function tableExists(connection, table) {
  const rows = await connection.query(
    'SELECT COUNT(*) AS cnt FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = ?',
    [table],
  );
  return Number(rows[0][0].cnt) > 0;
}

// 由单行的 useXxx 值构造该菜单的 powerConfig 白名单:仅保留值为 1 且模板支持的动作;全 0 → {}。
function buildPowerConfig(menuName, row) {
  const fn = menuName; // 单功能菜单:功能键 = 菜单名
  const actions = {};
  let hasGrant = false;
  Object.entries(FIELD_TO_ACTION).forEach(([field, action]) => {
    if (Number(row[field]) === 1 && permissionTemplate.isValidAction(menuName, fn, action)) {
      actions[action] = 1;
      hasGrant = true;
    }
  });
  return hasGrant ? JSON.stringify({ [fn]: { actions } }) : JSON.stringify({});
}

async function runOnDatabase(connection, dbName) {
  await connection.changeUser({ database: dbName });
  console.log(`\n=== 目标库 ${dbName} ===`);
  if (!(await tableExists(connection, TABLE_NAME))) {
    console.log(`skip    ${dbName}.${TABLE_NAME} (本库无此表;operator_power 为 gm_data_000 全局表)`);
    return;
  }

  const holes = MIGRATE_MENUS.map(() => '?').join(', ');
  // 仅取待回填行:纳入迁移的菜单 + useMenu=1 + powerConfig 仍为 NULL + 排除平台管理员(gm_data_000/isAccount=1);
  const selectSql =
    `SELECT a.idPower, a.useCreate, a.useModify, a.useDelete, a.usePower, m.name AS menuName ` +
    `FROM operator_power a ` +
    `JOIN menu m ON m.id = a.idMenu ` +
    `JOIN operator o ON o.idOperator = a.idOperator ` +
    `WHERE m.name IN (${holes}) AND a.useMenu = 1 AND a.powerConfig IS NULL ` +
    `AND NOT (o.isAccount = 1 AND o.dataBaseName = 'gm_data_000')`;
  const [rows] = await connection.query(selectSql, MIGRATE_MENUS);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('nothing  没有需要回填的权限行(已全部配置或无需迁移)');
    return;
  }

  let updated = 0;
  for (const row of rows) {
    const menuName = String(row.menuName);
    const powerConfig = buildPowerConfig(menuName, row);
    await connection.query('UPDATE operator_power SET powerConfig = ? WHERE idPower = ? AND powerConfig IS NULL', [
      powerConfig,
      row.idPower,
    ]);
    updated += 1;
    console.log(`backfill idPower=${row.idPower} ${menuName} -> ${powerConfig}`);
  }
  console.log(`回填完成:${updated} 行(仅写 NULL 行,已配置行未改动)`);
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
    // 先加载 menu.powerConfig 模板:回填动作只保留模板里存在的动作;模板缺失会把整行写成 {} 全禁,
    // 故这里先对 MIGRATE_MENUS 做完整性检查,缺一个就直接退出而不是继续迁移 20261023 改造,
    const templateRows = await connection.query('SELECT name, powerConfig FROM gm_data_000.menu WHERE powerConfig IS NOT NULL');
    permissionTemplate.setTemplatesFromRows(templateRows[0] || []);
    const missingTemplates = MIGRATE_MENUS.filter((menuName) => !permissionTemplate.isFunctionMenu(menuName));
    if (missingTemplates.length > 0) {
      throw new Error(
        `gm_data_000.menu.powerConfig 缺少模板:${missingTemplates.join(', ')}(请先执行 scripts/add-menu-power-config.js)`,
      );
    }

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
    console.log('\npowerConfig 动作列回填完成(下一步:发后端/前端,全量测试通过后再执行 drop-power-action-columns.js)。');
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
