// 账户权限页对「用户管理」子树按“目标账户库名”过滤的用例(需求 20261022,口径承接三轮 P1-1 延伸):
// 被配权限的账户库名=gm_data_000 时下发 101100 及其下级(账户信息/合同列表);非 gm_data_000 时整棵子树都不出现在权限列表里,
// 与 menu.js 的菜单侧下发兜底共用 lib/platformMenus 同一份根清单,避免“菜单已隐藏、配置页却留一行点开即 403 的死记录”,
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bodyParser = require('body-parser');
const database = require('../database');
const rbac = require('../rbac');
const accountPowerRouter = require('../accountPower/query');

// 目标账户的 account_power 扁平行:含「用户管理」子树(101100/101101/101102)与一条无关的「基础设置」(102100),
// account_power 不含 parent_id,过滤靠 idMenu 命中菜单父链闭包,故这里给全量行,断言只看是否被剔除,
const powerRows = [
  { idMenu: '101100', dataBaseName: 'gm_data_001', menuName: 'menu.user', level: 1, useMenu: 1 },
  { idMenu: '101101', dataBaseName: 'gm_data_001', menuName: 'menu.account', level: 2, useMenu: 1 },
  { idMenu: '101102', dataBaseName: 'gm_data_001', menuName: 'menu.contract', level: 2, useMenu: 1 },
  { idMenu: '102100', dataBaseName: 'gm_data_001', menuName: 'menu.set', level: 1, useMenu: 1 },
];
// 菜单父链:101100 为根,101101/101102 为其直接下级,102100 为另一棵无关根,
const menuRows = [
  { id: '101100', parent_id: '0' },
  { id: '101101', parent_id: '101100' },
  { id: '101102', parent_id: '101100' },
  { id: '102100', parent_id: '0' },
];

function createPowerPool() {
  return {
    async query(sql) {
      const text = String(sql);
      if (text.includes('account_power a WHERE')) {
        return [powerRows];
      }
      if (text.includes('gm_data_000.menu')) {
        return [menuRows];
      }
      return [[]];
    },
  };
}

// 查看者固定为平台管理员(requirePlatformAdmin 需 gm_data_000 + isAccount=1);被查看的目标账户由 dataBaseName 入参决定,
async function fetchPowerList(targetDb, pool) {
  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => {
    req.data = { dataBase: 'gm_data_000', userName: 'admin', phone: '13766891959', userId: 1000, isAccount: 1 };
    next();
  });
  app.use('/api/accountPower-query', accountPowerRouter);
  database.setPoolForTesting(pool || createPowerPool());

  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/accountPower-query/power?dataBaseName=${targetDb}&account=tester`);
    assert.strictEqual(response.status, 200, '权限查询不应因过滤而报错');
    const body = await response.json();
    return body.data.list;
  } finally {
    server.close();
  }
}

test.beforeEach(() => {
  rbac.invalidateAuthCaches();
});

test.afterEach(() => {
  database.resetPoolForTesting();
});

// 核心断言:同一份 account_power 行集下,非平台目标账户拿不到 101100 子树,无关菜单不受影响,
test('accountPower: 非 gm_data_000 目标账户的权限列表不含「用户管理」子树', async () => {
  const list = await fetchPowerList('gm_data_001');
  const ids = list.map((row) => String(row.idMenu));
  assert.ok(!ids.includes('101100'), '租户目标账户不应出现用户管理根');
  assert.ok(!ids.includes('101101'), '租户目标账户不应出现账户信息子项');
  assert.ok(!ids.includes('101102'), '租户目标账户不应出现合同列表子项');
  assert.ok(ids.includes('102100'), '无关菜单(基础设置)被误删,过滤范围过大');
});

// 平台目标账户保留完整子树,且走短路分支不再查菜单表(过滤只发生在租户分支),
test('accountPower: gm_data_000 目标账户保留完整「用户管理」子树且不额外查菜单表', async () => {
  const executed = [];
  const base = createPowerPool();
  const spy = {
    query(sql, params) {
      executed.push(String(sql));
      return base.query(sql, params);
    },
  };
  const list = await fetchPowerList('gm_data_000', spy);
  const ids = list.map((row) => String(row.idMenu));
  assert.deepStrictEqual(ids.sort(), ['101100', '101101', '101102', '102100'], '平台目标账户应原样拿到全量行');
  assert.ok(!executed.some((sql) => sql.includes('gm_data_000.menu')), '平台分支应短路返回,不应触发菜单闭包查询');
});

// 纯函数口径:剔除按菜单父链闭包(含孙子层),平台分支原样返回同一引用,数字型 idMenu 也要拦住,
test('accountPower: filterPlatformOnlyPowers 按子树闭包剔除且平台分支不复制数组', () => {
  const rows = [{ idMenu: '101100' }, { idMenu: '101101' }, { idMenu: '103100' }];
  assert.strictEqual(
    accountPowerRouter.filterPlatformOnlyPowers(rows, menuRows, true),
    rows,
    '平台分支应原样返回同一数组引用',
  );
  assert.deepStrictEqual(
    accountPowerRouter.filterPlatformOnlyPowers(rows, menuRows, false).map((row) => row.idMenu),
    ['103100'],
  );
  // 数字型 idMenu 也要拦住(不能因类型漏放行),
  assert.deepStrictEqual(
    accountPowerRouter.filterPlatformOnlyPowers([{ idMenu: 101100 }, { idMenu: 103100 }], menuRows, false).map((row) => row.idMenu),
    [103100],
  );
  // 三层子树(孙子层)也要随根一并剔除(证明是闭包而非只取直接子级),
  const deep = [
    { id: '101100', parent_id: '0' },
    { id: '101101', parent_id: '101100' },
    { id: '1011011', parent_id: '101101' },
  ];
  assert.deepStrictEqual(
    accountPowerRouter.filterPlatformOnlyPowers([{ idMenu: '1011011' }, { idMenu: '102100' }], deep, false).map((row) => row.idMenu),
    ['102100'],
  );
});
