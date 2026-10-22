const mysql = require('mysql2/promise');
const config = require('./config');
const requestContext = require('./requestContext');
// 分页总数短 TTL 缓存的作废入口(审查修复 20261021 二轮 P2-14):
// 写语句一律在本统一执行面作废缓存,不依赖各业务文件自觉,本模块与 countCache 不成环(它只依 config),
const countCache = require('./lib/countCache');

// 连接池参数(审查修复 20261021 P2 性能):原写法 connectionLimit=20 写死且 queueLimit 缺省(=不限等待队列),
// 数据库抖动时上游请求无界堆积、整站表现为“卡住”,现改为环境变量可调(config.database.pool),
const poolOptions = (config.database && config.database.pool) || {};
const mysqlPool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  database: config.database.database,
  waitForConnections: true,
  connectionLimit: poolOptions.connectionLimit || 20,
  // queueLimit 允许显式配 0(不限),故不能用 || 默认值,
  queueLimit: Number.isFinite(poolOptions.queueLimit) ? poolOptions.queueLimit : 200,
  connectTimeout: poolOptions.connectTimeout || 10000,
  namedPlaceholders: false,
  charset: 'utf8mb4',
  // 日期列不做 JS Date 转换(审查修复 20261021 P1-6):驱动默认把 DATE/DATETIME 构造成本机时区的 Date 对象,
  // JSON 序列化时又转成 UTC ISO(带 Z),浏览器按自身时区回解→服务端与浏览器时区不一致时整个日期列偏移甚至少一天;
  // 现按驱动原始字符串 'YYYY-MM-DD HH:mm:ss' 回传,与已用 DATE_FORMAT 输出的列口径统一(全链路字符串往返),
  dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'],
});

// 当前生效的连接池:默认真实池,测试可注入 mock 池 20260917 新增,
let activePool = mysqlPool;

function normalizeSql(sql) {
  // PG风格 $N 占位符转 ?:$N 后必须是非标识符字符(逗号/空格/括号等),
  // 避免误伤bcrypt哈希字面量中的 $2a/$2b/$2y 与 $10$ 20260916 修复,
  return String(sql).replace(/\$\d+(?![A-Za-z0-9_$])/g, '?');
}

// 慢查询告警(审查修复 20261021 P2 性能):超过阈值(默认 500ms)打一条 warn,便于线上定位缺索引的语句,
// 只记语句本身与耗时,不打参数值(可能含个人信息);阈值 SLOW_QUERY_MS 可调 20261021 新增,
const SLOW_QUERY_MS = poolOptions.slowQueryMs || 500;

function markSlowQuery(sql, startedAt, tag) {
  const cost = Date.now() - startedAt;
  if (cost < SLOW_QUERY_MS) {
    return;
  }
  // 行首带请求关联号(审查修复 20261021 二轮 P2-16):否则慢语句只能看到时间戳与耗时,
  // 无法与同一次操作的 access log / 错误堆栈对到同一请求上,
  console.warn(`[slow-query][${requestContext.getRequestId()}] ${tag} ${cost}ms ${String(sql).replace(/\s+/g, ' ').slice(0, 200)}`);
}

function normalizeResult(result) {
  if (Array.isArray(result)) {
    return result;
  }

  // 非数组结果(如写操作 OkPacket)不携带行数据,避免把结果元数据塞进 rows 20260915 修复,
  return {
    affectedRows: result.affectedRows,
    rows: [],
  };
}

// 取写语句影响行数:mysql2 Promise 连接返回 [result, fields] 元组,查询类首元是行数组不带 affectedRows 故计 0 20261021 审查修复 低,
function countAffected(result) {
  const packet = Array.isArray(result) ? result[0] : result;
  const rows = Number(packet && packet.affectedRows);
  return Number.isFinite(rows) ? rows : 0;
}

function resolveQueryArgs(paramsOrCallback, maybeCallback) {
  if (typeof paramsOrCallback === 'function') {
    return { params: [], callback: paramsOrCallback };
  }

  return {
    params: Array.isArray(paramsOrCallback) ? paramsOrCallback : [],
    callback: maybeCallback,
  };
}

function query(sql, paramsOrCallback, maybeCallback) {
  const { params, callback } = resolveQueryArgs(paramsOrCallback, maybeCallback);
  const normalizedSql = normalizeSql(sql);
  countCache.invalidateForStatement(normalizedSql);
  const startedAt = Date.now();
  const promise = activePool
    .query(normalizedSql, params)
    .then(([rows]) => {
      markSlowQuery(normalizedSql, startedAt, 'query');
      return normalizeResult(rows);
    });

  if (typeof callback === 'function') {
    const invokeCallback = (error, result) => {
      try {
        callback(error, result);
      } catch (callbackError) {
        const res = requestContext.getResponse();
        console.error('Unhandled route callback error:', callbackError);

        if (res && !res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    };

    promise.then((result) => invokeCallback(null, result)).catch((error) => invokeCallback(error));
    return;
  }

  return promise;
}

// 事务连接包装(审查修复 20261021 P2 性能 + 占位符修正):函数型事务项内部经 public.execWith/queryWith
// 直接调用 connection.query,既不走下方语句循环(拿不到慢查询告警),也不做 $N→? 归一,
// 而语句构造器统一输出 $N 占位符,namedPlaceholders=false 下原样发给 MySQL 会报 Unknown column '$1',
// 因此在连接层统一收口归一 + 计时,覆盖事务项内部的全部读写 20261021 新增,
function traceTransactionConnection(connection) {
  return new Proxy(connection, {
    get(target, property) {
      if (property === 'query') {
        return async (sql, params) => {
          const normalized = normalizeSql(sql);
          countCache.invalidateForStatement(normalized);
          const startedAt = Date.now();
          try {
            return await target.query(normalized, params);
          } finally {
            markSlowQuery(normalized, startedAt, 'tx');
          }
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function withTransaction(sqlList) {
  const connection = await activePool.getConnection();
  let affectedRows = 0;

  try {
    await connection.beginTransaction();
    for (const item of sqlList) {
      if (typeof item === 'string') {
        countCache.invalidateForStatement(normalizeSql(item));
        affectedRows += countAffected(await connection.query(normalizeSql(item)));
        continue;
      }

      // 函数型事务项:(connection) => Promise,用于“先读后写”的链式计算(如管理期限重排),
      // 读与写共用同一连接且均在事务内,避免事务外读快照导致的并发丢失更新（审查修复 20261021 中C）,
      // 返回值若为数字则计入影响行数:项内自行用 connection 执行的语句不经过本循环,原写法一律计 0,
      // 使批量建位这类“一次事务写 N 行”的成功应答 affectedRows 恒为 0(审查修复 20261021 P1-3),
      if (typeof item === 'function') {
        const itemResult = await item(traceTransactionConnection(connection));
        const itemAffected = Number(itemResult);
        if (Number.isFinite(itemAffected)) {
          affectedRows += itemAffected;
        }
        continue;
      }

      if (item && typeof item.sql === 'string') {
        const params = Array.isArray(item.params) ? item.params : [];
        countCache.invalidateForStatement(normalizeSql(item.sql));
        affectedRows += countAffected(await connection.query(normalizeSql(item.sql), params));
        continue;
      }

      throw new Error('Invalid transaction item');
    }
    await connection.commit();
    // 返回写语句真实累计的影响行数(原写法直接拿 sqlList.length 充数,语句条数不等于生效行数) 20261021 审查修复 低,
    return { affectedRows };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  query,
  withTransaction,
  end: () => activePool.end(),
  // 连接池占用快照(审查修复 20261021 三轮 P2-6):供 /health 探活读取,取自 mysql2 连接池内部计数
  // (无官方统计 API),任一环节取不到都安全回 null(测试注入的 mock 池没有这些字段),不抛错,
  poolStats: () => {
    const raw = activePool && activePool.pool;
    if (!raw || !Array.isArray(raw._allConnections)) {
      return null;
    }
    const total = raw._allConnections.length;
    const idle = Array.isArray(raw._freeConnections) ? raw._freeConnections.length : 0;
    const waiting = Array.isArray(raw._connectionQueue) ? raw._connectionQueue.length : 0;
    return { total, idle, borrowed: total - idle, waiting };
  },
  // 测试专用:注入 mock 连接池并恢复真实池,生产路径不受影响 20260917 新增,
  setPoolForTesting: (pool) => {
    activePool = pool;
  },
  resetPoolForTesting: () => {
    activePool = mysqlPool;
  },
};

