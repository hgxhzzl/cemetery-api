// 墓位业务-销售动作键 cancelSale → delete 迁移 20261023:
// 背景:墓位销售页的按钮由“取消销售”改为“删除”,销售的“删除/取消销售”本就是同一功能,
// 权限动作键随之统一为 delete(与新建/修改/删除的通用动作命名一致);模板(menu.powerConfig)与
// 授权(operator_power.powerConfig)必须同步改名,否则已授权操作员会被白名单锁死(按钮/接口 403)。
// 本脚本做两件事:
//   1) menu.powerConfig:把 gravePlotBusiness.sale 中的 cancelSale 替换为 delete(保留其余动作);
//   2) operator_power.powerConfig:把 sale.actions.cancelSale 显式=1 合并为 delete=1,再删除 cancelSale 键;
//      cancelSale=0/缺省只清键不补授权;delete 已存在时按“任一为 1 即授权”合并,其它功能原样保留。
// 幂等:重复执行结果一致;模板已无 cancelSale、授权行已无该键时跳过。
// 顺序:先执行本脚本,再重启后端(启动时从 menu.powerConfig 加载模板)。
require('dotenv').config({ quiet: true });

const mysql = require('mysql2/promise');
const config = require('../config');

const DB_NAME = 'gm_data_000';
const MENU_NAME = 'gravePlotBusiness';
const FN_NAME = 'sale';
const OLD_ACTION = 'cancelSale';
const NEW_ACTION = 'delete';

// json 列可能回对象或字符串;非法值返回 null 由调用方跳过,避免把脏数据覆写成 {},
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
  const saleActions = current && Array.isArray(current[FN_NAME]) ? current[FN_NAME] : null;
  if (!saleActions) {
    console.warn(`skip    menu.${MENU_NAME}.powerConfig 缺少 ${FN_NAME} 功能模板,请先确认模板版本`);
    return;
  }
  if (!saleActions.includes(OLD_ACTION)) {
    console.log(`skip    menu.${MENU_NAME}.powerConfig 已无 ${FN_NAME}.${OLD_ACTION}`);
    return;
  }
  const nextActions = saleActions.filter((action) => action !== OLD_ACTION);
  if (!nextActions.includes(NEW_ACTION)) {
    nextActions.push(NEW_ACTION);
  }
  const nextTemplate = { ...current, [FN_NAME]: nextActions };
  await connection.query(`UPDATE \`${DB_NAME}\`.menu SET powerConfig = ? WHERE name = ?`, [
    JSON.stringify(nextTemplate),
    MENU_NAME,
  ]);
  console.log(
    `updated menu.${MENU_NAME}.powerConfig.${FN_NAME}: ${JSON.stringify(saleActions)} -> ${JSON.stringify(nextActions)}`,
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
    const fnConfig = cfg && cfg[FN_NAME];
    const actions = fnConfig && fnConfig.actions && typeof fnConfig.actions === 'object' ? fnConfig.actions : null;
    if (!actions || !Object.prototype.hasOwnProperty.call(actions, OLD_ACTION)) {
      skipped += 1;
      continue;
    }
    // 仅显式=1 视为已授权;旧键与已存在的新键任一为 1 都保留授权,再清掉旧键,
    const granted = Number(actions[OLD_ACTION]) === 1 || Number(actions[NEW_ACTION]) === 1;
    delete actions[OLD_ACTION];
    if (granted) {
      actions[NEW_ACTION] = 1;
    } else {
      delete actions[NEW_ACTION];
    }
    // 清键后该功能已无任何动作时整体移除,与 /config 归一口径一致(不留空壳),
    if (Object.keys(actions).length === 0) {
      delete cfg[FN_NAME];
    }
    await connection.query(`UPDATE \`${DB_NAME}\`.operator_power SET powerConfig = ? WHERE idPower = ?`, [
      JSON.stringify(cfg),
      row.idPower,
    ]);
    updated += 1;
    console.log(`updated operator_power.idPower=${row.idPower} -> ${JSON.stringify(cfg[FN_NAME] || null)}`);
  }
  console.log(`授权改写完成:更新 ${updated} 行,跳过 ${skipped} 行(不含 ${FN_NAME}.${OLD_ACTION})`);
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
    console.log(`目标:${DB_NAME}.menu / operator_power(${FN_NAME}.${OLD_ACTION} -> ${NEW_ACTION})`);
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
