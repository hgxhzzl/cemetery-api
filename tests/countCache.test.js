// 分页总数短 TTL 复用用例(审查修复 20261021 二轮 P2-14):
// 列表接口同一筛选条件下翻页时总数根本不会变,而这条 COUNT(*) 在大表上是整片扫描,是翻页延迟的主要来源之一;
// 缓存的正确性完全建在「写语句即作废」与「键含租户库名」两点上,因此这两条必须有独立断言钉住,
const test = require('node:test');
const assert = require('node:assert');
const countCache = require('../lib/countCache');

test('countCache: TTL 内复用结果,参数/语句/库名任一变化都重新回源', async () => {
  countCache.resetForTesting();
  let calls = 0;
  const queryFn = async () => {
    calls += 1;
    return [{ total: 42 }];
  };
  const options = { database: 'gm_data_001', sql: 'SELECT COUNT(*) AS total FROM room r WHERE region = ?', params: ['福东'] };

  assert.deepStrictEqual(await countCache.queryAggregate(queryFn, options), { total: 42 });
  assert.deepStrictEqual(await countCache.queryAggregate(queryFn, options), { total: 42 });
  assert.strictEqual(calls, 1, '同库同语句同参数在 TTL 内只应回源一次');

  // 筛选条件变了就是另一个总数,绝不能复用上一条缓存,
  await countCache.queryAggregate(queryFn, { ...options, params: ['福西'] });
  assert.strictEqual(calls, 2, '参数变化应重新回源');

  // 库名参与缓存键:多租户按库隔离,否则 A 租户的总数会被 B 租户直接命中,
  await countCache.queryAggregate(queryFn, { ...options, database: 'gm_data_002' });
  assert.strictEqual(calls, 3, '库名变化应重新回源');
  assert.strictEqual(countCache.statsForTesting().size, 3, '三条不同键各占一个条目');
});

test('countCache: 缺库名时不缓存(宁可多查也不冒跨租户串数据的风险)', async () => {
  countCache.resetForTesting();
  let calls = 0;
  const queryFn = async () => {
    calls += 1;
    return [{ total: 9 }];
  };
  const options = { sql: 'SELECT COUNT(*) AS total FROM room r', params: [] };

  await countCache.queryAggregate(queryFn, options);
  await countCache.queryAggregate(queryFn, options);
  assert.strictEqual(calls, 2, '未显式传库名的调用一律回源');
  assert.strictEqual(countCache.statsForTesting().size, 0, '未传库名不应留下任何缓存条目');
});

test('countCache: 多列聚合取数并把 DECIMAL 字符串与空值归一为 Number', async () => {
  countCache.resetForTesting();
  // 销售/收款查询的合计列由 SUM 产出,驱动回的是 DECIMAL 字符串,原写法在业务文件里 Number() 转换,现收进缓存层,
  const sumRows = async () => [{ total: 5, totalAmount: '1234.50' }];
  const value = await countCache.queryAggregate(sumRows, {
    database: 'gm_data_001',
    sql: 'SELECT COUNT(*) AS total, COALESCE(SUM(realPrice), 0) AS totalAmount FROM sale s',
    columns: ['total', 'totalAmount'],
  });
  assert.deepStrictEqual(value, { total: 5, totalAmount: 1234.5 }, '合计列应转成数值供前端千分位格式化');

  // 空行集(表不存在/事务隔离下的意外空结果)不能把 undefined 原样带到响应体里,
  const emptyRows = async () => [];
  const fallback = await countCache.queryAggregate(emptyRows, { database: 'gm_data_001', sql: 'SELECT COUNT(*) AS total FROM x', columns: ['total'] });
  assert.deepStrictEqual(fallback, { total: 0 }, '缺失列应补 0');
});

test('countCache: 任一写语句整体作废,读语句与关闭态不作废', async () => {
  countCache.resetForTesting();
  let calls = 0;
  const queryFn = async () => {
    calls += 1;
    return [{ total: calls }];
  };
  const options = { database: 'gm_data_001', sql: 'SELECT COUNT(*) AS total FROM room r WHERE isDeleted = 0', params: [] };

  assert.strictEqual((await countCache.queryAggregate(queryFn, options)).total, 1);
  // 列表页自身的 count/取页语句都是读,不该把刚建好的条目清掉,
  assert.strictEqual(countCache.invalidateForStatement('SELECT COUNT(*) AS total FROM gm_data_001.room r'), 0, '读语句不应作废缓存');
  assert.strictEqual(countCache.statsForTesting().size, 1);

  // 删掉一个墓位后总数必须立刻反映真实值:写语句(含大小写混排与事务内的 insert)一律整体清空,
  assert.strictEqual(countCache.invalidateForStatement('update gm_data_001.room set isDeleted = 1 where idRoom = ?'), 1, '写语句应清掉缓存条目');
  assert.strictEqual(countCache.statsForTesting().size, 0);
  assert.strictEqual((await countCache.queryAggregate(queryFn, options)).total, 2, '作废后应回源重算');

  assert.strictEqual(countCache.invalidateForStatement('INSERT INTO gm_data_001.room (region) VALUES (?)'), 1);
  assert.strictEqual(countCache.invalidateForStatement(''), 0, '空语句不应算作写');
  assert.strictEqual(countCache.invalidateForStatement('insertXxx y'), 0, '非写关键字开头的语句不应算作写');
});

test('countCache: 条目数触顶时整体清空,不变成又一处无界内存', async () => {
  countCache.resetForTesting();
  const queryFn = async () => [{ total: 1 }];
  // 上限 500 条,逐条造出互不相同的参数把表填满,再插一条应触发整体清空而不是继续增长,
  for (let index = 0; index < 500; index += 1) {
    await countCache.queryAggregate(queryFn, { database: 'gm_data_001', sql: 'SELECT COUNT(*) AS total FROM room r WHERE id = ?', params: [index] });
  }
  assert.strictEqual(countCache.statsForTesting().size, 500);
  await countCache.queryAggregate(queryFn, { database: 'gm_data_001', sql: 'SELECT COUNT(*) AS total FROM room r WHERE id = ?', params: ['overflow'] });
  assert.strictEqual(countCache.statsForTesting().size, 1, '超上限时应先清空再写入当前条目');
});

// 首页 /summary 多行聚合短 TTL 复用(审查修复 20261021 三轮 P2-12):看板一次跑 12 条 SUM/COUNT/GROUP BY,
// 对几十秒延迟不敏感,复用与分页总数同一套缓存;正确性仍靠“键含库名+参数”与“写语句即整体作废”两条,
// 且行数组原样返回(不做数值归一),调用方保留自己的 Number(rows[0].v) 口径,
test('queryCachedRows: TTL 内整片复用,库名/参数变化回源,写语句与 queryAggregate 共用作废', async () => {
  countCache.resetForTesting();
  let calls = 0;
  const rows = async () => {
    calls += 1;
    return [{ region: '福东', v: '12.5' }, { region: '福西', v: '3' }];
  };
  const options = { database: 'gm_data_001', sql: 'SELECT r.region, SUM(a.realPrice) AS v FROM sale a JOIN room r ON a.idRoom=r.idRoom GROUP BY r.region', params: [] };

  const first = await countCache.queryCachedRows(rows, options);
  const second = await countCache.queryCachedRows(rows, options);
  assert.strictEqual(calls, 1, '同库同语句同参数 TTL 内只回源一次');
  assert.strictEqual(first, second, '命中时返回同一行数组引用');
  assert.strictEqual(first[0].v, '12.5', '行数据原样返回,不在缓存层做数值归一');

  // 参数(区域名单)变了即另一次查询,不得复用,否则跨区操作员会命中彼此的结果,
  await countCache.queryCachedRows(rows, { ...options, params: ['福东'] });
  assert.strictEqual(calls, 2, '参数变化应重新回源');
  // 库名参与键:多租户按库隔离,
  await countCache.queryCachedRows(rows, { ...options, database: 'gm_data_002', params: ['福东'] });
  assert.strictEqual(calls, 3, '库名变化应重新回源');

  // 与 queryAggregate 共用作废:任一写语句把整张表清掉(前面已积 3 个不同键的条目),看板行缓存不得残留旧值,
  assert.strictEqual(countCache.invalidateForStatement('update gm_data_001.sale set isDeleted=1 where idSale=?'), 3, '写语句应清掉含行缓存在内的全部条目');
  assert.strictEqual(countCache.statsForTesting().size, 0);
  await countCache.queryCachedRows(rows, options);
  assert.strictEqual(calls, 4, '作废后应回源重算');
});
