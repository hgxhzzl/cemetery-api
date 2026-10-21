// 活跃登录态缓存用例(审查修复 20261021 二轮 P1-5)。
// 这条缓存换掉的是全站唯一的“每个带 token 的请求都查一次库”,
// 因此要守住的口径是:① 命中期间不再发 SQL ② 只缓存“活跃”的肯定结论
// (缓存否定结果会让重新登录后的新 token 被拖到 TTL 结束才生效)③ 登出/改密路径立即作废本实例缓存,
const test = require('node:test');
const assert = require('node:assert');
const database = require('../database');
const loginState = require('../loginState');

// mock 池按 mysql2 Promise 层返回 [rows] 元组,cnt 决定“是否活跃”,
function createMockPool(cnt) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return [[{ cnt }]];
    },
  };
}

test.beforeEach(() => {
  loginState.clearSessionCacheForTesting();
});

test.afterEach(() => {
  loginState.clearSessionCacheForTesting();
  database.resetPoolForTesting();
});

test('loginState: TTL 内的活跃结论走缓存,不再重复查库', async () => {
  const mockPool = createMockPool(1);
  database.setPoolForTesting(mockPool);

  assert.strictEqual(await loginState.hasActiveLogin('13800138000', '1789000000'), true);
  assert.strictEqual(await loginState.hasActiveLogin('13800138000', '1789000000'), true);
  assert.strictEqual(await loginState.hasActiveLogin('13800138000', '1789000000'), true);

  const selects = mockPool.calls.filter((call) => call.sql.includes('SELECT COUNT(*)'));
  assert.strictEqual(selects.length, 1, '三次校验应只查库一次');
  assert.ok(selects[0].sql.includes('gm_data_000.login_session'));
  assert.deepStrictEqual(selects[0].params, ['13800138000', '1789000000'], '缓存键必须同时含手机号与到期时间戳');
});

test('loginState: 不活跃(查无记录)的否定结论不入缓存', async () => {
  const mockPool = createMockPool(0);
  database.setPoolForTesting(mockPool);

  assert.strictEqual(await loginState.hasActiveLogin('13800138001', '1789000000'), false);
  assert.strictEqual(await loginState.hasActiveLogin('13800138001', '1789000000'), false);

  const selects = mockPool.calls.filter((call) => call.sql.includes('SELECT COUNT(*)'));
  assert.strictEqual(selects.length, 2, '否定结论每次都须回源,否则重新登录的新 token 会被拖到 TTL 结束');
});

test('loginState: 同一手机号换 token(exp 变化)不会被旧缓存放行', async () => {
  const mockPool = createMockPool(1);
  database.setPoolForTesting(mockPool);

  await loginState.hasActiveLogin('13800138002', '1789000000');
  await loginState.hasActiveLogin('13800138002', '1789000999');

  assert.strictEqual(mockPool.calls.filter((call) => call.sql.includes('SELECT COUNT(*)')).length, 2, '不同 exp 属于不同缓存键');
});

test('loginState: 登录写入与登出删除都会作废本实例缓存', async () => {
  const mockPool = createMockPool(1);
  // 按手机号分段计数,避免同一用例内多个手机号的查询量互相干扰,
  const selectsFor = (phone) =>
    mockPool.calls.filter((call) => call.sql.includes('SELECT COUNT(*)') && call.params[0] === phone).length;
  database.setPoolForTesting(mockPool);

  await loginState.hasActiveLogin('13800138003', '1789000000');
  assert.strictEqual(selectsFor('13800138003'), 1);
  await loginState.hasActiveLogin('13800138003', '1789000000');
  assert.strictEqual(selectsFor('13800138003'), 1, '第二次应命中缓存');

  await loginState.deleteActiveLogin('13800138003');
  assert.ok(mockPool.calls.some((call) => call.sql.includes('DELETE FROM gm_data_000.login_session')));
  await loginState.hasActiveLogin('13800138003', '1789000000');
  assert.strictEqual(selectsFor('13800138003'), 2, '登出后须回源,旧 token 不得靠缓存续命');

  await loginState.hasActiveLogin('13800138004', '1789000000');
  assert.strictEqual(selectsFor('13800138004'), 1);
  await loginState.setActiveLogin('13800138004', '1789000000');
  assert.ok(mockPool.calls.some((call) => call.sql.includes('INSERT INTO gm_data_000.login_session')));
  await loginState.hasActiveLogin('13800138004', '1789000000');
  assert.strictEqual(selectsFor('13800138004'), 2, '重新登录写入后同样要作废旧缓存');
});
