// 租户库名闸门(审查修复 20261021 二轮 P0-1)。
// 背景:全站 97 个 handler 里有 246 处 `${req.data.dataBase}.表名` 拼接,而拼接前只有 3 处做过
// assertIdentifier,也就是说"库名绝不可能是注入载体"这件事完全依赖 JWT 密钥不外泄;一旦密钥泄露
// 或被手工签发一个 payload,攻击者拿到的就不只是某个租户,而是能在连接账号权限范围内指到任意库。
// 本模块把校验上收到两个唯一切面:签票前(login.js)与验票后(index.js 鉴权中间件),
// 业务层不再需要为库名做任何纪律,新增拼接点自动被覆盖。
// 依赖方向:tenant → public(断言/脱敏) → lib,本模块不被 lib 引用,不成环。

const pool = require('./database');
const config = require('./config');
const public = require('./public');

// 平台库(全局表所在库)与 MYSQL_DATABASE 配置的默认库,始终视为合法,不依赖 account 表数据,
const PLATFORM_DATABASE = 'gm_data_000';

// 形态白名单:在 assertIdentifier 之上再收一层业务命名口径(本系统租户库统一为 gm_data_XXX 一族),
// 目的是即使已知名单为空(首轮刷新未完成),拼进 SQL 的字符串也不可能是注入载体,
const tenantNamePattern = /^[a-z][a-z0-9_]{2,31}$/;

// 已知租户库名单:来自 gm_data_000.account.dataBaseName(登录时 operator/account 已按此关联),
// 每次刷新整体替换(Set 引用不换),刷新失败沿用上一次名单,避免数据库抖动把全站打成 401,
let knownDatabases = new Set();
let loadedAt = 0;
let refreshPromise = null;
let refreshTimer = null;

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function platformNames() {
  const names = new Set([PLATFORM_DATABASE]);
  if (config.database && config.database.database) {
    names.add(String(config.database.database));
  }
  return names;
}

// 拉取全部已登记租户库名;失败时返回 -1 表示"沿用旧名单",
async function refresh() {
  if (refreshPromise) {
    return refreshPromise;
  }
  refreshPromise = pool
    .query('SELECT DISTINCT dataBaseName AS name FROM gm_data_000.account WHERE dataBaseName IS NOT NULL AND dataBaseName <> ""')
    .then((rows) => {
      const next = platformNames();
      (rows || []).forEach((row) => {
        const name = String((row && row.name) || '').trim();
        if (name) {
          next.add(name);
        }
      });
      knownDatabases = next;
      loadedAt = Date.now();
      return next.size;
    })
    .catch((error) => {
      // 只影响名单是否收紧,不影响形态校验;首次就失败时 knownDatabases 仍为空,isAllowed 走降级口径,
      console.warn('[tenant] 租户库名单刷新失败，沿用上一次名单:', error.sqlMessage || error.message);
      return -1;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

// 名单是否已就绪(供启动检查与测试使用),
function isLoaded() {
  return knownDatabases.size > 0;
}

/**
 * 仅校验库名形态(标识符 + 白名单正则),不查已登记名单
 * 供 account/save 的 createDataBase 等“名字还没入库”的入口复用同一口径,避免建出一个登录不了的库,
 * 20261021 审查修复二轮 P0-1,
 */
function isValidNameShape(dataBase) {
  const name = String(dataBase || '').trim();
  if (!name) {
    return false;
  }
  try {
    public.assertIdentifier(name, 'database');
  } catch (error) {
    return false;
  }
  return tenantNamePattern.test(name);
}

/**
 * 判定一个库名能否作为 SQL 里的库前缀使用
 * 三级口径:① 标识符断言 + 形态白名单(永远生效,不可降级)② 已知租户名单(未就绪时降级为仅①),
 * @param {string} dataBase JWT 载荷或登录结果里的库名
 * @returns {boolean}
 */
function isAllowed(dataBase) {
  if (!isValidNameShape(dataBase)) {
    return false;
  }
  const name = String(dataBase).trim();
  if (knownDatabases.size === 0) {
    console.warn('[tenant] 租户库名单未就绪，本次仅按形态白名单放行:', name);
    return true;
  }
  return knownDatabases.has(name);
}

// 启动时首轮拉取 + 周期刷新;定时器 unref,不阻止进程退出(优雅停机时不必手工清理),
async function ensureLoaded() {
  await refresh();
  return knownDatabases.size;
}

function startAutoRefresh() {
  if (refreshTimer) {
    return refreshTimer;
  }
  refreshTimer = setInterval(() => {
    refresh();
  }, REFRESH_INTERVAL_MS);
  if (refreshTimer.unref) {
    refreshTimer.unref();
  }
  return refreshTimer;
}

exports.PLATFORM_DATABASE = PLATFORM_DATABASE;
exports.refresh = refresh;
exports.ensureLoaded = ensureLoaded;
exports.startAutoRefresh = startAutoRefresh;
exports.isAllowed = isAllowed;
exports.isValidNameShape = isValidNameShape;
exports.isLoaded = isLoaded;

// 仅测试使用:重置进程内名单,避免用例之间互相污染,
exports.resetForTesting = function () {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  knownDatabases = new Set();
  loadedAt = 0;
  refreshPromise = null;
};
exports.getLoadedAtForTesting = function () {
  return loadedAt;
};
