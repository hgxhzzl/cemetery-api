// 登录爆破防护:按手机号滑动窗口计数失败尝试,窗口内超限即临时锁定(审查修复 20261021 中A),
// 此前 /api/login 无任何频控,可被脚本无限速离线撞库;密码校验虽已 bcrypt/明文兼容,但缺少失败惩罚层。
// 计数键只按手机号、不拼 req.ip:服务在 nginx 反代后未开 trust proxy 时 req.ip 恒为 127.0.0.1,
// 拼 IP 会把所有请求误归同一直连源,导致全局限流(集体误锁),账号维度已足够阻断撞库 20261021 新增,
const store = new Map();

function normalizeKey(phone) {
  return String(phone || '').trim();
}

// 判定该手机号当前是否处于锁定冷却期(不计数,登录入口先调本函数)
function isLocked(phone) {
  if (!phone) {
    return false;
  }
  const record = store.get(phone);
  if (!record) {
    return false;
  }
  if (Date.now() >= record.lockUntil) {
    store.delete(phone);
    return false;
  }
  return true;
}

// 记录一次失败:窗口滑动重开计数,达到上限即锁定 lockMs;返回剩余可尝试次数供提示 20261021 新增,
function recordFailure(phone) {
  const { maxAttempts, windowMs, lockMs } = require('./config').loginRateLimit;
  const now = Date.now();
  let record = store.get(phone);
  if (!record || now - record.firstAt > windowMs) {
    record = { firstAt: now, count: 0, lockUntil: 0 };
    store.set(phone, record);
  }
  record.count += 1;
  if (record.count >= maxAttempts) {
    record.lockUntil = now + lockMs;
  }
  return Math.max(maxAttempts - record.count, 0);
}

// 登录成功清零计数(仅限本人成功,不构成攻击者复位通道)
function clearFailures(phone) {
  store.delete(phone);
}

// 锁定剩余秒数(未锁定返回 0),供 429 提示文案 20261021 新增,
function getLockRemainingSeconds(phone) {
  const record = store.get(phone);
  if (!record || Date.now() >= record.lockUntil) {
    return 0;
  }
  return Math.ceil((record.lockUntil - Date.now()) / 1000);
}

// 防 store 无界增长:低频清理已解锁且窗口已过期的记录
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of store) {
    if (now >= record.lockUntil && now - record.firstAt > require('./config').loginRateLimit.windowMs) {
      store.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();

module.exports = { normalizeKey, isLocked, recordFailure, clearFailures, getLockRemainingSeconds };
