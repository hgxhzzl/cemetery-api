// 登录态会话:持久化到 gm_data_000.login_session,替代内存 Map,支持服务重启与多实例共享 20260917 改造,
const pool = require('./database');

function normalizePhone(phone) {
  return String(phone || '');
}

// 写入/刷新登录态:同一手机号重新登录时 exp 更新,旧 token 随之失效
async function setActiveLogin(phone, exp) {
  await pool.query(
    'INSERT INTO gm_data_000.login_session (phone, exp, updateTime) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE exp = VALUES(exp), updateTime = NOW()',
    [normalizePhone(phone), String(exp)],
  );
}

// 校验登录态:手机号 + token 到期时间戳一致才视为活跃
async function hasActiveLogin(phone, exp) {
  const rows = await pool.query(
    'SELECT COUNT(*) AS cnt FROM gm_data_000.login_session WHERE phone = ? AND exp = ?',
    [normalizePhone(phone), String(exp)],
  );
  return Array.isArray(rows) && rows.length > 0 && Number(rows[0].cnt) > 0;
}

// 登出:移除登录态,供 /api/login/logout 调用,删除后当前 token 立即失效 20260917 接线,
async function deleteActiveLogin(phone) {
  await pool.query('DELETE FROM gm_data_000.login_session WHERE phone = ?', [normalizePhone(phone)]);
}

// 幂等建表:启动时确保 login_session 存在,线上老库缺表时自动补齐,避免登录 500 20260917 修复,
async function ensureTable() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS gm_data_000.login_session (" +
      "phone varchar(20) NOT NULL COMMENT '登录手机号', " +
      "exp varchar(20) DEFAULT NULL COMMENT 'token到期时间戳', " +
      "updateTime datetime DEFAULT NULL COMMENT '更新时间', " +
      'PRIMARY KEY (phone)' +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='登录态会话表'",
  );
}

module.exports = {
  ensureTable,
  setActiveLogin,
  hasActiveLogin,
  deleteActiveLogin,
};