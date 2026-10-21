// 租户库名闸门用例(审查修复 20261021 二轮 P0-1)。
// 这里守的是两条口径:① 形态白名单永远生效(不可被降级绕开)② 名单未就绪/刷新失败时的降级面足够窄,
// 以及刷新失败时必须沿用上一次名单而不是退化成"全放行",
const test = require('node:test');
const assert = require('node:assert');
const database = require('../database');
const tenant = require('../tenant');

// mock 池返回 [rows] 元组,与 mysql2 Promise 层一致,
function setMockRows(rows) {
  database.setPoolForTesting({
    query: async () => [rows],
  });
}

function setMockFailure(message) {
  database.setPoolForTesting({
    query: async () => {
      throw new Error(message);
    },
  });
}

test.beforeEach(() => {
  tenant.resetForTesting();
});

test.after(() => {
  tenant.resetForTesting();
  database.resetPoolForTesting();
});

test('tenant: 非法形态的库名一律拒绝(注入载体/空值/越界长度)', () => {
  setMockRows([]);
  ['gm_data_000; drop database x', '`gm_data_000`', 'gm data', 'gm_data--', '../gm_data_000', 'gm_data_000"', '', null, undefined, 'GM_DATA_000', 'a'.repeat(40)].forEach(
    (name) => {
      assert.strictEqual(tenant.isAllowed(name), false, `${String(name)} 不应被放行`);
    },
  );
});

test('tenant: 名单未就绪时降级为仅形态白名单(不把全站打成 401)', () => {
  setMockFailure('连接不可用');
  // 首轮刷新失败:knownDatabases 仍为空,合法形态放行但非法形态照旧拒绝,
  assert.strictEqual(tenant.isLoaded(), false);
  assert.strictEqual(tenant.isAllowed('gm_data_007'), true);
  assert.strictEqual(tenant.isAllowed('information_schema'), true);
  assert.strictEqual(tenant.isAllowed('gm_data_007 union select'), false);
});

test('tenant: 名单就绪后未登记的库名被拒绝,平台库始终放行', async () => {
  setMockRows([{ name: 'gm_data_001' }, { name: 'gm_data_002' }, { name: '  ' }]);
  const count = await tenant.ensureLoaded();
  // 空串被丢弃,平台库 gm_data_000 与配置库始终在名单内(不写死个数,避免跟 .env 配置库强耦合),
  assert.ok(count >= 3, `名单应至少包含 2 个租户 + 平台库,实际 ${count}`);
  assert.strictEqual(tenant.isLoaded(), true);
  assert.strictEqual(tenant.isAllowed('gm_data_001'), true);
  assert.strictEqual(tenant.isAllowed('gm_data_000'), true);
  assert.strictEqual(tenant.isAllowed('gm_data_003'), false);
});

test('tenant: 刷新失败沿用上一次名单,不退化为全放行', async () => {
  setMockRows([{ name: 'gm_data_001' }]);
  await tenant.ensureLoaded();

  setMockFailure('临时故障');
  assert.strictEqual(await tenant.refresh(), -1);
  assert.strictEqual(tenant.isAllowed('gm_data_001'), true);
  assert.strictEqual(tenant.isAllowed('gm_data_009'), false, '刷新失败不应把已收紧的名单重新放开');
});

test('tenant: 新建租户在下一次刷新后自动可用', async () => {
  setMockRows([{ name: 'gm_data_001' }]);
  await tenant.ensureLoaded();
  assert.strictEqual(tenant.isAllowed('gm_data_030'), false);

  setMockRows([{ name: 'gm_data_001' }, { name: 'gm_data_030' }]);
  await tenant.refresh();
  assert.strictEqual(tenant.isAllowed('gm_data_030'), true);
});
