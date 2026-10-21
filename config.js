require('dotenv').config();

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// 敏感配置检测:必须通过环境变量提供,不允许内置默认值;缺失即拒绝启动,避免误连远端真实数据库 20260917 凭据收口,
// warnings 为软告警(不阻断启动,由 index.js 启动时输出):原实现恒为空数组,消费方的告警形同虚设,
// 这里把实际可降级的安全开关挂上去使其真正生效 20261021 审查修复 低,
function buildSecurityWarnings() {
  const warnings = [];
  const fatal = [];
  if (!process.env.JWT_SECRET) {
    fatal.push('JWT_SECRET 未配置,必须通过环境变量提供,不允许内置默认密钥');
  }
  if (!process.env.MYSQL_PASSWORD && !process.env.DB_PASSWORD) {
    fatal.push('MYSQL_PASSWORD 未配置,必须通过环境变量提供,不允许内置默认密码');
  }
  if (!process.env.MYSQL_HOST && !process.env.DB_HOST) {
    fatal.push('MYSQL_HOST 未配置,必须通过环境变量提供');
  }
  if (!process.env.MYSQL_USER && !process.env.DB_USER) {
    fatal.push('MYSQL_USER 未配置,必须通过环境变量提供');
  }
  if (!process.env.MYSQL_DATABASE && !process.env.DB_NAME) {
    fatal.push('MYSQL_DATABASE 未配置,必须通过环境变量提供');
  }
  if (process.env.DEVICE_CHECK_ENABLED === 'false') {
    warnings.push('设备白名单校验已整体关闭(DEVICE_CHECK_ENABLED=false)，操作员可在任意电脑登录');
  }
  if (process.env.LOGIN_RATE_LIMIT_ENABLED === 'false') {
    warnings.push('登录爆破防护已关闭(LOGIN_RATE_LIMIT_ENABLED=false)，登录接口可被持续穷举');
  }
  const corsOrigin = process.env.CORS_ORIGIN || '';
  if (corsOrigin === '*' || corsOrigin.split(',').some((item) => item.trim() === 'null')) {
    warnings.push('CORS_ORIGIN 过于宽松: ' + corsOrigin);
  }
  return { warnings, fatal };
}

const security = buildSecurityWarnings();

const config = {
  app: {
    port: toNumber(process.env.PORT, 3000),
    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3002',
    // 请求体上限(审查修复 20261021 P2):原写法 bodyParser.json() 未设 limit,单个请求可塞入任意大 JSON,
    // 解析阶段即打满内存且绕过所有业务校验;本系统最大批量建位请求为千级条目,100kb 足够富余,
    // 可环境变量 BODY_LIMIT 覆盖,批量建位上限另由 ROOM_BATCH_MAX 控制,
    bodyLimit: process.env.BODY_LIMIT || '100kb',
    // 优雅停机等待在途请求的超时(毫秒),超时后强制退出,避免连接被长期占满导致进程杀不掉,
    shutdownTimeoutMs: toNumber(process.env.SHUTDOWN_TIMEOUT_MS, 10_000),
  },
  // 登录设备白名单总开关:默认开启,环境变量 DEVICE_CHECK_ENABLED=false 时整体关闭回退 20260924 新增,
  deviceCheck: {
    enabled: process.env.DEVICE_CHECK_ENABLED !== 'false',
  },
  // 登录爆破防护(审查修复 20261021 中A):滑动窗口内失败达 maxAttempts 即临时锁定 lockMs;默认开启,
  // LOGIN_RATE_LIMIT_ENABLED=false 可整体关闭(如内网压测场景),阈值均可环境变量覆盖,
  loginRateLimit: {
    enabled: process.env.LOGIN_RATE_LIMIT_ENABLED !== 'false',
    maxAttempts: toNumber(process.env.LOGIN_MAX_ATTEMPTS, 5),
    windowMs: toNumber(process.env.LOGIN_WINDOW_MS, 10 * 60 * 1000),
    lockMs: toNumber(process.env.LOGIN_LOCK_MS, 15 * 60 * 1000),
  },
  // 墓位批量新建上限(审查修复 20261021 P1-3):排×号的跨度乘积就是待建行数,原写法无任何上限,
  // 一次提交 300×300=9 万条语句会把事务内未提交行/内存全部打满,超限直接 400 拒绝分批登记;
  // 可环境变量 ROOM_BATCH_MAX 覆盖(如大型墓区一次性建档时临时调高),
  roomBatch: {
    maxCreate: toNumber(process.env.ROOM_BATCH_MAX, 1000),
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET,
    tokenExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },
  database: {
    host: process.env.MYSQL_HOST || process.env.DB_HOST,
    port: toNumber(process.env.MYSQL_PORT || process.env.DB_PORT, 3306),
    user: process.env.MYSQL_USER || process.env.DB_USER,
    password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD,
    database: process.env.MYSQL_DATABASE || process.env.DB_NAME,
    // 连接池参数(审查修复 20261021 P2 性能):原写法 connectionLimit=20 写死且无等待队列上限,
    // 数据库抖动时上游请求全部无界排队、整站表现为“卡住”,现按环境变量可调:
    // DB_POOL_LIMIT 连接上限,DB_POOL_QUEUE_LIMIT 等待队列上限(0=不限),DB_CONNECT_TIMEOUT_MS 获连超时,SLOW_QUERY_MS 慢查询告警阈值,
    pool: {
      connectionLimit: toNumber(process.env.DB_POOL_LIMIT, 20),
      queueLimit: toNumber(process.env.DB_POOL_QUEUE_LIMIT, 200),
      connectTimeout: toNumber(process.env.DB_CONNECT_TIMEOUT_MS, 10_000),
      slowQueryMs: toNumber(process.env.SLOW_QUERY_MS, 500),
    },
  },
  securityWarnings: security.warnings,
  // 敏感配置缺失项:非空时启动必须拒绝(process.exit) 20260917 凭据收口,
  securityFatal: security.fatal,
};

module.exports = config;