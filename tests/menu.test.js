// 「用户管理」子树只对平台账户开放的用例(审查修复 20261021 三轮 P1-1):
// 本系统按库分租户,但 account / contract 这类表在模板库 gm_data_000 里且语句不带任何租户条件,
// 于是“租户只要被勾上该菜单就能读改全平台数据”只剩权限配置这一道人工屏障。接口侧已把口径写进注册表
// (routeRegistry 的 globalScope 条目 + 整前缀 platformOnly,由启动体检钉住),本文件覆盖菜单侧那半边:
// 非平台账户连「用户管理」这一级都不该下发,免得配置手滑时留一个点开即 403 的死菜单,
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bodyParser = require('body-parser');
const database = require('../database');
const rbac = require('../rbac');
const menuRouter = require('../menu');

// 菜单行的 icon 列在库里可为空,建树时只透传不消费,用例里给 null 即可(必须先声明再引用),
const NULL_ICON = null;

// 假设当前身份被授了「用户管理」整棵子树(101100 及其下 101101/101102)加一条无关的「基础设置」,
// 用例只关心过滤是否生效,因此这一份行集对两种身份完全相同,
// 页面菜单名故意不取 operate/park 等系统内一级菜单名,使区域重组分支在未命中根节点时直接跳过,
const grantedMenuRows = [
  { id: '101100', path: '/users', name: 'users', component: 'LAYOUT', redirect: '/users/base', icon: 'user-setting', parent_id: '0', zh_CN: '用户管理', en_US: 'Users' },
  { id: '101101', path: 'account', name: 'account', component: '/account/index', redirect: '', icon: NULL_ICON, parent_id: '101100', zh_CN: '账户信息', en_US: 'Account' },
  { id: '101102', path: 'contract', name: 'contract', component: '/contract/index', redirect: '', icon: NULL_ICON, parent_id: '101100', zh_CN: '合同列表', en_US: 'Contract' },
  { id: '102100', path: '/set', name: 'set', component: 'LAYOUT', redirect: '/set/base', icon: 'setting-1', parent_id: '0', zh_CN: '基础设置', en_US: 'Settings' },
];

// mock 池返回 [rows] 元组(与 mysql2 回调式一致,database.query 会解构首元再交给 normalizeResult),
// 菜单语句给全量授权行;操作员区域语句给空名单(平台账户走 isPlatformAdmin 短路根本不会打这条),
function createMenuPool() {
  return {
    async query(sql) {
      const text = String(sql);
      if (text.includes('gm_data_000.menu')) {
        return [grantedMenuRows];
      }
      if (text.includes('gm_data_000.operator')) {
        return [[{ region: '' }]];
      }
      return [[]];
    },
  };
}

async function fetchMenuTree(dataBase, isAccount) {
  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => {
    req.data = { dataBase, userName: 'tester', phone: '13766891959', userId: isAccount === 1 ? 1000 : 2000, isAccount };
    next();
  });
  app.use('/api/get-menu-list-i18n', menuRouter);

  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/get-menu-list-i18n`);
    assert.strictEqual(response.status, 200, '菜单接口本身不应因过滤而报错');
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

// 核心断言:同一份授权行集下,租户账户拿不到 101100 子树,平台账户照旧拿到完整子树,
test('menu: 「用户管理」子树只对 gm_data_000 平台账户下发', async () => {
  database.setPoolForTesting(createMenuPool());

  const tenantTree = await fetchMenuTree('gm_data_001', 0);
  assert.ok(
    !tenantTree.some((node) => String(node.id) === '101100'),
    `租户账户仍拿到了用户管理:${JSON.stringify(tenantTree.map((node) => node.id))}`,
  );
  assert.ok(
    tenantTree.some((node) => String(node.id) === '102100'),
    '无关菜单(基础设置)被误删,过滤范围过大',
  );

  database.setPoolForTesting(createMenuPool());
  const platformTree = await fetchMenuTree('gm_data_000', 1);
  const usersNode = platformTree.find((node) => String(node.id) === '101100');
  assert.ok(usersNode, '平台账户应能看到用户管理');
  assert.deepStrictEqual(
    (usersNode.children || []).map((child) => String(child.id)).sort(),
    ['101101', '101102'],
    '平台账户下的用户管理子菜单应与授权行一致',
  );
});

// 平台库内 isAccount=0 的普通操作员按 rbac.isPlatformAdmin 判据同样不属于“平台账户”,
// 这里钉住“过滤依据是身份判据而不是库名”,防止有人把条件简写成 dataBase==='gm_data_000' 后
// 与接口侧 platformOnly 的口径分叉(菜单可见但一点就 403),
test('menu: 平台库内非账户身份同样不下发用户管理子树', async () => {
  database.setPoolForTesting(createMenuPool());
  const tree = await fetchMenuTree('gm_data_000', 0);
  assert.ok(
    !tree.some((node) => String(node.id) === '101100'),
    '菜单过滤必须与接口侧 requirePlatformAdmin 用同一个 isPlatformAdmin 判据',
  );
});

// 纯函数口径:剔除只发生在一级根节点,且平台分支原样返回同一引用(调用方后续就地重组依赖这一点),
test('menu: filterPlatformOnlyMenus 只按根菜单 id 过滤且平台分支不复制树', () => {
  const tree = [{ id: '101100', children: [{ id: '101101' }] }, { id: '103100' }];
  assert.strictEqual(menuRouter.filterPlatformOnlyMenus(tree, true), tree, '平台账户应原样返回同一棵树引用');
  assert.deepStrictEqual(
    menuRouter.filterPlatformOnlyMenus(tree, false).map((node) => String(node.id)),
    ['103100'],
  );
  // 数字型 id 也要拦住(菜单表 id 是字符串,但建树前的行数据可能是数字,不能因类型漏放行),
  assert.deepStrictEqual(
    menuRouter.filterPlatformOnlyMenus([{ id: 101100 }, { id: 103100 }], false).map((node) => node.id),
    [103100],
  );
});
