// 墓区预定菜单(103104)下线 20261023:
// 背景:预定的新建/修改/删除已并入墓位业务页(103101)的「预定期」卡片入口,独立预定页与
// 其写接口(/api/reserve-save、/api/reserve-delete)已从代码中删除;存活库里残留的菜单行与
// 授权行必须一并清掉,否则:
//   1) 已开通 103104 的租户仍会在侧边栏看到入口,点进去指向已删除的前端页面;
//   2) operator_power / account_power 里指向 103104 的授权行变成永不命中的死数据。
// 本脚本做四件事(全部幂等,重复执行结果一致):
//   1) 删除 gm_data_000.account_power 中 idMenu='103104' 的租户菜单授权;
//   2) 删除 gm_data_000.operator_power 中 idMenu='103104' 的操作员菜单授权;
//   3) 删除 gm_data_000.menu 中 id='103104' 的菜单行;
//   4) 兜底:若 gravePlotBusiness 的菜单模板存在且缺 reserve 动作,补齐 create/modify/delete
//      (新入口的功能级鉴权依赖该模板;powerConfig 为 NULL 表示不做功能级管控,保持原样)。
// 顺序:先执行本脚本,再重启后端(菜单与模板在启动时加载)。
require('dotenv').config({ quiet: true });

const mysql = require('mysql2/promise');
const config = require('../config');

const DB_NAME = 'gm_data_000';
const MENU_ID = '103104';
const MENU_NAME = 'reserve';
const BUSINESS_MENU = 'gravePlotBusiness';
const RESERVE_ACTIONS = ['create', 'modify', 'delete'];

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

async function deleteAccountPower(connection) {
  const [result] = await connection.query(`DELETE FROM \`${DB_NAME}\`.account_power WHERE idMenu = ?`, [MENU_ID]);
  console.log(`account_power: 删除 ${result.affectedRows} 行(idMenu=${MENU_ID})`);
}

async function deleteOperatorPower(connection) {
  const [result] = await connection.query(`DELETE FROM \`${DB_NAME}\`.operator_power WHERE idMenu = ?`, [MENU_ID]);
  console.log(`operator_power: 删除 ${result.affectedRows} 行(idMenu=${MENU_ID})`);
}

async function deleteMenu(connection) {
  const [result] = await connection.query(`DELETE FROM \`${DB_NAME}\`.menu WHERE id = ?`, [MENU_ID]);
  console.log(`menu: 删除 ${result.affectedRows} 行(id=${MENU_ID})`);
  if (result.affectedRows === 0) {
    console.log(`skip    menu 无 id=${MENU_ID}(已下线或本库版本较旧)`);
  }
  // 只按 id 删除:若仍有同 name 的其它行,说明菜单表被手工改过,留一行提示人工确认,
  const [others] = await connection.query(`SELECT id FROM \`${DB_NAME}\`.menu WHERE name = ?`, [MENU_NAME]);
  if (others.length > 0) {
    console.warn(`warn    仍有 name='${MENU_NAME}' 的菜单行:${others.map((row) => row.id).join(', ')},请人工确认`);
  }
}

// 新入口的功能级鉴权依赖 gravePlotBusiness 模板中的 reserve 键;老库若模板合法但缺该键,
// 所有「预定期」按钮会因“动作不在模板内”被判无权限,故在这里补齐而非覆盖已有动作,
async function ensureBusinessReserveTemplate(connection) {
  const [rows] = await connection.query(`SELECT powerConfig FROM \`${DB_NAME}\`.menu WHERE name = ?`, [BUSINESS_MENU]);
  if (rows.length === 0) {
    console.warn(`skip    未找到 menu.name='${BUSINESS_MENU}',无法校验预定期模板`);
    return;
  }
  const current = parseConfig(rows[0].powerConfig);
  if (current === null) {
    console.log(`skip    menu.${BUSINESS_MENU}.powerConfig 为空(NULL=不做功能级管控),保持原样`);
    return;
  }
  const existing = Array.isArray(current.reserve) ? current.reserve : [];
  const missing = RESERVE_ACTIONS.filter((action) => !existing.includes(action));
  if (missing.length === 0 && Array.isArray(current.reserve)) {
    console.log(`skip    menu.${BUSINESS_MENU}.powerConfig.reserve 已完整`);
    return;
  }
  const nextActions = Array.from(new Set([...existing, ...RESERVE_ACTIONS]));
  const nextTemplate = { ...current, reserve: nextActions };
  await connection.query(`UPDATE \`${DB_NAME}\`.menu SET powerConfig = ? WHERE name = ?`, [
    JSON.stringify(nextTemplate),
    BUSINESS_MENU,
  ]);
  console.log(
    `updated menu.${BUSINESS_MENU}.powerConfig.reserve: ${JSON.stringify(existing)} -> ${JSON.stringify(nextActions)}`,
  );
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
    console.log(`目标:${DB_NAME}.menu / account_power / operator_power(下线 ${MENU_ID} ${MENU_NAME})`);
    await connection.beginTransaction();
    await deleteAccountPower(connection);
    await deleteOperatorPower(connection);
    await deleteMenu(connection);
    await ensureBusinessReserveTemplate(connection);
    await connection.commit();
    console.log('\n下线完成(下一步:重启后端使菜单/模板缓存生效)。');
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

