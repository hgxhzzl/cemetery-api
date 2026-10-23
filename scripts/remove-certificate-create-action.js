// 墓位业务-安葬证(certificate)去掉“新建”动作 20261023:
// 背景:安葬证设置页只有一个“确认提交”，首次设置与后续修改共用同一次保存；
// 权限页原本同时提供 certificate.create / certificate.modify 两个勾选，实际没有任何独立“新建”入口，
// 故模板只保留 modify，首次保存由后端 update 在 idCert=0 时回落到插入（前端也已统一提交 update）。
// 本脚本做两件事(幂等,重复执行结果一致):
//   1) menu.powerConfig:把 gravePlotBusiness.certificate 的动作数组过滤掉 create;
//   2) operator_power.powerConfig:删除已授权行里 certificate.actions.create;
//      actions 因此变空时删除整个 certificate 功能键(不留 {actions:{}} 死结构)；
//      删空后保留 {}(全禁)，与权限页“未勾选=禁止”的语义一致，不回退成 NULL 全放行。
// 顺序:先执行本脚本,再重启后端(启动时从 menu.powerConfig 加载模板)。
require('dotenv').config({ quiet: true });

const mysql = require('mysql2/promise');
const config = require('../config');

const DB_NAME = 'gm_data_000';
const MENU_NAME = 'gravePlotBusiness';
const FN_NAME = 'certificate';
const REMOVED_ACTION = 'create';

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

async function removeFromMenuTemplate(connection) {
  const [rows] = await connection.query(`SELECT powerConfig FROM \`${DB_NAME}\`.menu WHERE name = ?`, [MENU_NAME]);
  if (!rows.length) {
    throw new Error(`未找到 ${DB_NAME}.menu 中 name='${MENU_NAME}' 的菜单行,请先确认菜单表版本`);
  }
  const current = parseConfig(rows[0].powerConfig);
  if (current === null) {
    console.log(`skip    menu.${MENU_NAME}.powerConfig 为空(NULL=不做功能级管控),保持原样`);
    return;
  }
  const actions = current[FN_NAME];
  if (!Array.isArray(actions)) {
    console.log(`skip    menu.${MENU_NAME}.powerConfig 无 ${FN_NAME} 动作白名单`);
    return;
  }
  if (!actions.includes(REMOVED_ACTION)) {
    console.log(`skip    menu.${MENU_NAME}.${FN_NAME} 已无 ${REMOVED_ACTION} 动作`);
    return;
  }
  const nextActions = actions.filter((action) => action !== REMOVED_ACTION);
  if (nextActions.length === 0) {
    // 模板清空会被后端解析为“不做功能级管控”,与本次目的(只删一个动作)不符,直接报错人工确认,
    throw new Error(`删除 ${FN_NAME}.${REMOVED_ACTION} 后动作列表为空,请人工确认后处理`);
  }
  current[FN_NAME] = nextActions;
  await connection.query(`UPDATE \`${DB_NAME}\`.menu SET powerConfig = ? WHERE name = ?`, [
    JSON.stringify(current),
    MENU_NAME,
  ]);
  console.log(`updated menu.${MENU_NAME}.powerConfig.${FN_NAME}: ${JSON.stringify(actions)} -> ${JSON.stringify(nextActions)}`);
}

async function removeFromGrants(connection) {
  const [rows] = await connection.query(
    `SELECT idPower, powerConfig FROM \`${DB_NAME}\`.operator_power WHERE powerConfig IS NOT NULL`,
  );
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const cfg = parseConfig(row.powerConfig);
    const grant = cfg && cfg[FN_NAME];
    const actions = grant && grant.actions;
    if (!actions || typeof actions !== 'object' || !Object.prototype.hasOwnProperty.call(actions, REMOVED_ACTION)) {
      skipped += 1;
      continue;
    }
    delete actions[REMOVED_ACTION];
    if (Object.keys(actions).length === 0) {
      delete cfg[FN_NAME];
    }
    await connection.query(`UPDATE \`${DB_NAME}\`.operator_power SET powerConfig = ? WHERE idPower = ?`, [
      JSON.stringify(cfg),
      row.idPower,
    ]);
    updated += 1;
    console.log(`updated operator_power.idPower=${row.idPower}: 已删除 ${FN_NAME}.${REMOVED_ACTION} 授权`);
  }
  console.log(`授权清理完成:更新 ${updated} 行,跳过 ${skipped} 行(不含 ${FN_NAME}.${REMOVED_ACTION})`);
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
    console.log(`目标:${DB_NAME}.menu / operator_power(移除 ${MENU_NAME}.${FN_NAME}.${REMOVED_ACTION})`);
    await connection.beginTransaction();
    await removeFromMenuTemplate(connection);
    await removeFromGrants(connection);
    await connection.commit();
    console.log('\n移除完成(下一步:重启后端使模板缓存生效)。');
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
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
