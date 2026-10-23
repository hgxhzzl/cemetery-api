// 园区设置动作键 modify → setting 迁移 20261023:
// 背景:园区设置页的保存按钮由“确认提交”改为“设置提交”,权限动作键从通用 modify 改为专用 setting;
// 模板(menu.powerConfig)与授权(operator_power.powerConfig)必须同步改名,否则已授权操作员会被白名单锁死
// (新模板只认 setting,旧授权里仍是 modify=1,表现为按钮消失/接口 403)。
// 本脚本做两件事:
//   1) menu.powerConfig:把 park 模板写成 {"park":["setting"]};
//   2) operator_power.powerConfig:把 park.actions.modify 改写为 setting(仅显式=1 才继续授权),
//      其余功能键与动作原样保留。
// 幂等:重复执行结果一致;模板已是目标值时不写库,授权行没有 park.modify 时跳过。
// 顺序:先执行本脚本,再重启后端(启动时从 menu.powerConfig 加载模板)。
require('dotenv').config({ quiet: true });

const mysql = require('mysql2/promise');
const config = require('../config');

const DB_NAME = 'gm_data_000';
const MENU_NAME = 'park';
const OLD_ACTION = 'modify';
const NEW_ACTION = 'setting';
const NEW_TEMPLATE = { [MENU_NAME]: [NEW_ACTION] };

// json 列可能回对象或字符串;非法值按空处理(模板由本脚本重写,授权行跳过以免破坏数据),
function parseConfig(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function migrateMenuTemplate(connection) {
  const [rows] = await connection.query(`SELECT powerConfig FROM \`${DB_NAME}\`.menu WHERE name = ?`, [MENU_NAME]);
  if (!rows.length) {
    throw new Error(`未找到 ${DB_NAME}.menu 中 name='${MENU_NAME}' 的菜单行,请先确认菜单表版本`);
  }
  const current = parseConfig(rows[0].powerConfig);
  const actions = current && Array.isArray(current[MENU_NAME]) ? current[MENU_NAME] : [];
  if (actions.length === 1 && actions[0] === NEW_ACTION) {
    console.log(`skip    menu.${MENU_NAME}.powerConfig 已是 ${JSON.stringify(NEW_TEMPLATE)}`);
    return;
  }
  await connection.query(`UPDATE \`${DB_NAME}\`.menu SET powerConfig = ? WHERE name = ?`, [
    JSON.stringify(NEW_TEMPLATE),
    MENU_NAME,
  ]);
  console.log(
    `updated menu.${MENU_NAME}.powerConfig: ${JSON.stringify(rows[0].powerConfig)} -> ${JSON.stringify(NEW_TEMPLATE)}`,
  );
}

async function migrateGrants(connection) {
  const [rows] = await connection.query(
    `SELECT idPower, powerConfig FROM \`${DB_NAME}\`.operator_power WHERE powerConfig IS NOT NULL`,
  );
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const cfg = parseConfig(row.powerConfig);
    const fnConfig = cfg && cfg[MENU_NAME];
    const actions = fnConfig && fnConfig.actions && typeof fnConfig.actions === 'object' ? fnConfig.actions : null;
    if (!actions || !Object.prototype.hasOwnProperty.call(actions, OLD_ACTION)) {
      skipped += 1;
      continue;
    }
    // 只有显式 =1 才代表已授权;0/缺省一律按未授权处理(白名单缺省禁止),旧键删除后不补新键,
    const granted = Number(actions[OLD_ACTION]) === 1;
    delete actions[OLD_ACTION];
    if (granted) {
      actions[NEW_ACTION] = 1;
    }
    await connection.query(`UPDATE \`${DB_NAME}\`.operator_power SET powerConfig = ? WHERE idPower = ?`, [
      JSON.stringify(cfg),
      row.idPower,
    ]);
    updated += 1;
    console.log(`updated operator_power.idPower=${row.idPower} -> ${JSON.stringify(cfg[MENU_NAME])}`);
  }
  console.log(`授权改写完成:更新 ${updated} 行,跳过 ${skipped} 行(不含 ${MENU_NAME}.${OLD_ACTION})`);
}

async function main() {
  const connection = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    charset: 'utf8mb4',
  });

  try {
    console.log(`目标:${DB_NAME}.menu / operator_power(${MENU_NAME}.${OLD_ACTION} -> ${NEW_ACTION})`);
    await migrateMenuTemplate(connection);
    await migrateGrants(connection);
    console.log('\n迁移完成(下一步:重启后端使启动缓存加载新模板)。');
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
