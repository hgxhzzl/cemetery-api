// 登录态会话:持久化到 gm_data_000.login_session,替代内存 Map,支持服务重启与多实例共享 20260917 改造,
const pool = require('./database');
const config = require('./config');

function normalizePhone(phone) {
  return String(phone || '');
}

// 活跃登录态短 TTL 缓存(审查修复 20261021 二轮 P1-5):
// 原口径下每一个带 token 的请求都要多打一次 login_session 查库(前端一进页面就是十几个接口),
// 这是一条 PK 查询、平时不可见,但它是全站唯一的“每请求必查”项,缓存命中后每个请求少一次往返,
// 代价是“登出/改密后本实例内最多 SESSION_CHECK_CACHE_MS 毫秒旧 token 仍可用”(默认 5s,
// 多实例下其他实例也要等到 TTL 过期),登出与改密路径会主动失效本实例缓存,实际接近即时,
const SESSION_CHECK_CACHE_MS = (() => {
  const value = Number(config.auth && config.auth.sessionCheckCacheMs);
  // 0 是“关闭缓存”的合法配置,不能用 || 当默认值,
  return Number.isFinite(value) && value >= 0 ? value : 5000;
})();
const SESSION_CHECK_CACHE_MAX = 5000;
const sessionCache = new Map();

function cacheKey(phone, exp) {
  return `${normalizePhone(phone)}$${String(exp || '')}`;
}

function rememberActive(phone, exp) {
  if (sessionCache.size >= SESSION_CHECK_CACHE_MAX) {
    // 简单粗粒度淘汰:避免单实例缓存无界增长(正常活跃用户量远小于上限),
    sessionCache.clear();
  }
  sessionCache.set(cacheKey(phone, exp), Date.now());
}

function forgetPhone(phone) {
  const prefix = `${normalizePhone(phone)}$`;
  for (const key of sessionCache.keys()) {
    if (key.startsWith(prefix)) {
      sessionCache.delete(key);
    }
  }
}

// 写入/刷新登录态:同一手机号重新登录时 exp 更新,旧 token 随之失效
async function setActiveLogin(phone, exp) {
  forgetPhone(phone);
  await pool.query(
    'INSERT INTO gm_data_000.login_session (phone, exp, updateTime) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE exp = VALUES(exp), updateTime = NOW()',
    [normalizePhone(phone), String(exp)],
  );
}

// 校验登录态:手机号 + token 到期时间戳一致才视为活跃
async function hasActiveLogin(phone, exp) {
  const key = cacheKey(phone, exp);
  const at = sessionCache.get(key);
  if (at !== undefined && Date.now() - at < SESSION_CHECK_CACHE_MS) {
    return true;
  }
  const rows = await pool.query(
    'SELECT COUNT(*) AS cnt FROM gm_data_000.login_session WHERE phone = ? AND exp = ?',
    [normalizePhone(phone), String(exp)],
  );
  const active = Array.isArray(rows) && rows.length > 0 && Number(rows[0].cnt) > 0;
  // 只缓存“活跃”结论:未命中时不缓存否定结果,否则重新登录后的新 token 会被拖到 TTL 结束才生效,
  if (active) {
    rememberActive(phone, exp);
  } else {
    sessionCache.delete(key);
  }
  return active;
}

// 登出:移除登录态,供 /api/login/logout 调用,删除后当前 token 立即失效 20260917 接线,
async function deleteActiveLogin(phone) {
  forgetPhone(phone);
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
  // 仅测试用:清空进程内缓存,避免用例之间互相污染,
  clearSessionCacheForTesting: () => sessionCache.clear(),
};