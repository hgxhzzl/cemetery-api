// 分页总数/聚合值的短 TTL 复用(审查修复 20261021 二轮 P2-14)。
// 列表类接口(墓位/销售/收款/联系人/下葬查询)每一页都要跑一次 COUNT(*),销售与收款那条还附带 SUM,
// 而同一筛选条件下翻页时总数根本不会变——这条聚合在大表上是整片扫描,是翻页延迟的主要来源之一。
// 现按「库名 + 语句 + 参数」把结果缓存 COUNT_CACHE_MS(默认 10s),并在任何写语句发出时整体作废,
// 因此不存在“删完数据总数还带着已删行”的长时间偏差;写失败/回滚时多作废一次只会退化为回源重算,
// 作废采取“整体清空”而不是按库过滤:语句里的 db.table 与 r.x 列引用在文本层面无法可靠区分,
// 误判成“没写到这个库”比多算一次总数危险得多,而本系统的写请求频次远低于分页读,
const config = require('../config');

// 0 是“关闭缓存”的合法配置,不能用 || 取默认值,
const COUNT_CACHE_MS = (() => {
  const value = Number(config.database && config.database.pool && config.database.pool.countCacheMs);
  return Number.isFinite(value) && value >= 0 ? value : 10_000;
})();
// 条目上限:键里带着完整语句与参数,不设上限会变成又一处内存无界增长(筛选组合多的页面尤甚),
const MAX_ENTRIES = 500;

// 缓存键 -> { at, value }
const entries = new Map();

const writeStatementPattern = /^\s*(insert|update|delete|replace|alter|truncate|drop|create|rename|load)\b/i;

function isWriteStatement(sql) {
  return writeStatementPattern.test(String(sql || ''));
}

/**
 * 写语句作废:由 database.js 在统一执行面调用(query / 事务项 / 事务连接包装都走这里),
 * 不依赖各业务文件自觉;关闭缓存时直接返回,
 */
exports.invalidateForStatement = function (sql) {
  if (!COUNT_CACHE_MS || !isWriteStatement(sql) || entries.size === 0) {
    return 0;
  }
  const dropped = entries.size;
  entries.clear();
  return dropped;
};

/**
 * 取聚合值(COUNT/SUM 这类只用于展示总数与合计的语句)
 * @param {Function} queryFn 执行函数,通常传 pool.query
 * @param {Object} options { database: 库名(必填,缺失时不缓存), sql, params, columns: 需读回的数值列 }
 * @returns {Promise<Object>} { 列名: 数值 } 形状;列缺失或 NULL 时补 0
 */
exports.queryAggregate = async function (queryFn, options = {}) {
  const columns = options.columns || ['total'];
  const readRow = async () => {
    const rows = await queryFn(options.sql, options.params || []);
    const row = (Array.isArray(rows) && rows.length > 0 && rows[0]) || {};
    const value = {};
    columns.forEach((column) => {
      value[column] = Number(row[column]) || 0;
    });
    return value;
  };

  const database = String(options.database || '');
  if (!COUNT_CACHE_MS || !database || !options.sql) {
    return readRow();
  }

  const key = `${database}|${columns.join(',')}|${options.sql}|${JSON.stringify(options.params || [])}`;
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < COUNT_CACHE_MS) {
    // 命中后把时间戳推后(滑动过期):连续翻页期间不会到点失效,停手后自然过期,
    hit.at = Date.now();
    return hit.value;
  }

  const value = await readRow();
  if (entries.size >= MAX_ENTRIES) {
    entries.clear();
  }
  entries.set(key, { at: Date.now(), value });
  return value;
};

/**
 * 缓存任意只读查询的整片结果行(首页 /summary 这类多行聚合/明细:单次请求十几条,
 * 年度合计是 sale/adminfee/buried 三表全年 SUM/COUNT、按区域/按月又是各自带 GROUP BY 的整片扫描,
 * 而看板对几十秒级延迟完全不敏感)。与 queryAggregate 共用同一张 entries 表/键构成/写语句作废/TTL/上限,
 * 区别只是原样缓存行数组、不做数值归一,由调用方自行读取列,因此对现有 Number(rows[0].v) 口径零改动
 * (审查修复 20261021 三轮 P2-12),
 * @param {Function} queryFn 执行函数,通常传 pool.query
 * @param {Object} options { database: 库名(必填,缺失时不缓存), sql, params }
 * @returns {Promise<Array>} 原始行数组(缓存命中时返回同一引用)
 */
exports.queryCachedRows = async function (queryFn, options = {}) {
  const readRows = async () => {
    const rows = await queryFn(options.sql, options.params || []);
    return Array.isArray(rows) ? rows : [];
  };

  const database = String(options.database || '');
  if (!COUNT_CACHE_MS || !database || !options.sql) {
    return readRows();
  }

  // 键首段用字面量 rows 与 queryAggregate 的列名段天然区隔,同库同语句也不会互相命中,
  const key = `${database}|rows|${options.sql}|${JSON.stringify(options.params || [])}`;
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < COUNT_CACHE_MS) {
    // 命中后把时间戳推后(滑动过期):连续刷新看板期间不会到点失效,停手后自然过期,
    hit.at = Date.now();
    return hit.value;
  }

  const value = await readRows();
  if (entries.size >= MAX_ENTRIES) {
    entries.clear();
  }
  entries.set(key, { at: Date.now(), value });
  return value;
};

// 仅测试用:清空缓存,避免用例之间互相污染,
exports.resetForTesting = function () {
  entries.clear();
};

// 仅测试用:当前缓存条目数与生效 TTL,
exports.statsForTesting = function () {
  return { size: entries.size, ttlMs: COUNT_CACHE_MS };
};
