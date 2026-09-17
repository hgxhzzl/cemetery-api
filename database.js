const mysql = require('mysql2/promise');
const config = require('./config');
const requestContext = require('./requestContext');

const mysqlPool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  database: config.database.database,
  waitForConnections: true,
  connectionLimit: 20,
  namedPlaceholders: false,
  charset: 'utf8mb4',
});

// 当前生效的连接池:默认真实池,测试可注入 mock 池 20260917 新增,
let activePool = mysqlPool;

function normalizeSql(sql) {
  // PG风格 $N 占位符转 ?:$N 后必须是非标识符字符(逗号/空格/括号等),
  // 避免误伤bcrypt哈希字面量中的 $2a/$2b/$2y 与 $10$ 20260916 修复,
  return String(sql).replace(/\$\d+(?![A-Za-z0-9_$])/g, '?');
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
  const promise = activePool.query(normalizedSql, params).then(([rows]) => normalizeResult(rows));

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

async function withTransaction(sqlList) {
  const connection = await activePool.getConnection();

  try {
    await connection.beginTransaction();
    for (const item of sqlList) {
      if (typeof item === 'string') {
        await connection.query(normalizeSql(item));
        continue;
      }

      if (item && typeof item.sql === 'string') {
        const params = Array.isArray(item.params) ? item.params : [];
        await connection.query(normalizeSql(item.sql), params);
        continue;
      }

      throw new Error('Invalid transaction item');
    }
    await connection.commit();
    return { affectedRows: sqlList.length };
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
  connect: () => activePool.getConnection(),
  end: () => activePool.end(),
  // 测试专用:注入 mock 连接池并恢复真实池,生产路径不受影响 20260917 新增,
  setPoolForTesting: (pool) => {
    activePool = pool;
  },
  resetPoolForTesting: () => {
    activePool = mysqlPool;
  },
};

