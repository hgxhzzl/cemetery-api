// 墓位业务-默认业务形态(business)功能键下线 20261023:
// 背景:权限页的「墓位业务」功能行来自 gm_data_000.menu.powerConfig 的 business 键,
// 但该形态(默认落 graveplotbusiness 表)在前端没有入口,也没有任何可配置的按钮,
// 矩阵里留一行全勾/全不勾都没有实际作用,故从模板移除,权限页不再渲染该行。
// 本脚本做两件事(幂等,重复执行结果一致):
//   1) menu.powerConfig:从 gravePlotBusiness 模板中删除 business 功能键(其余功能原样保留);
//   2) operator_power.powerConfig:删除已授权行里的 business 键(其余功能原样保留;
//      删空后保留 {}(全禁),与权限页“未勾选=禁止”的语义一致,不回退成 NULL 全放行)。
// 顺序:先执行本脚本,再重启后端(启动时从 menu.powerConfig 加载模板)。
require('dotenv').config({ quiet: true });

const mysql = require('mysql2/promise');
const config = require('../config');

const DB_NAME = 'gm_data_000';
const MENU_NAME = 'gravePlotBusiness';
const FN_NAME = 'business';

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
  if (!Object.prototype.hasOwnProperty.call(current, FN_NAME)) {
    console.log(`skip    menu.${MENU_NAME}.powerConfig 已无 ${FN_NAME} 功能键`);
    return;
  }
  delete current[FN_NAME];
  if (Object.keys(current).length === 0) {
    // 模板清空会被后端解析为“不做功能级管控”,与本次目的(只删一个功能行)不符,直接报错人工确认,
    throw new Error(`删除 ${FN_NAME} 后 ${MENU_NAME} 模板为空,请人工确认后处理`);
  }
  await connection.query(`UPDATE \`${DB_NAME}\`.menu SET powerConfig = ? WHERE name = ?`, [
    JSON.stringify(current),
    MENU_NAME,
  ]);
  console.log(`updated menu.${MENU_NAME}.powerConfig: 已删除 ${FN_NAME} 功能键`);
}

async function removeFromGrants(connection) {
  const [rows] = await connection.query(
    `SELECT idPower, powerConfig FROM \`${DB_NAME}\`.operator_power WHERE powerConfig IS NOT NULL`,
  );
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const cfg = parseConfig(row.powerConfig);
    if (!cfg || !Object.prototype.hasOwnProperty.call(cfg, FN_NAME)) {
      skipped += 1;
      continue;
    }
    delete cfg[FN_NAME];
    await connection.query(`UPDATE \`${DB_NAME}\`.operator_power SET powerConfig = ? WHERE idPower = ?`, [
      JSON.stringify(cfg),
      row.idPower,
    ]);
    updated += 1;
    console.log(`updated operator_power.idPower=${row.idPower}: 已删除 ${FN_NAME} 授权`);
  }
  console.log(`授权清理完成:更新 ${updated} 行,跳过 ${skipped} 行(不含 ${FN_NAME})`);
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
    console.log(`目标:${DB_NAME}.menu / operator_power(移除 ${MENU_NAME}.${FN_NAME})`);
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
