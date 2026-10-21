// 声明式路由注册表的守卫覆盖断言(审查修复 20261021 P1-4):
// 原 index.js 用两张手工清单维护“守卫挂载表”与“路由挂载表”,唯一的约束是守卫必须先注册,
// 新增接口漏写一行守卫就是无鉴权裸奔且无测试兜底。现权限口径集中在 routeRegistry.ROUTES,
// 本文件做三件事:1) 遍历全表跑注册表体检;2) 逐条向每个已挂载写接口发真实请求,断言无权限时被守卫拦下;
// 3) 反向构造漏登记守卫的注册表,断言体检确实会报错(保证前两条用例有牙齿而不是恒真),
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bodyParser = require('body-parser');
const database = require('../database');
const rbac = require('../rbac');
const routeRegistry = require('../routeRegistry');

// 空行集 mock 池:权限命中查询与菜单存在性检查都返回空,即“当前操作员没有任何菜单权限”,
// 守卫应在业务 handler 之前结束请求,因此本用例不需要各业务表的 mock 数据,
function createNoPowerPool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return [[]];
    },
  };
}

// 把注册表展平成“实际写接口 + 它的权限口径”:口径函数一律复用 routeRegistry 导出,
// 避免测试与实现各写一套路径/方法判定,导致二者判定漂移后测试形同虚设,
function collectMountedEndpoints(routes = routeRegistry.ROUTES) {
  const endpoints = [];
  for (const entry of routes) {
    for (const route of routeRegistry.listRouterRoutes(entry.router)) {
      const fullPath = routeRegistry.normalizePath(entry.path + route.subPath);
      const covered = (entry.guards || []).filter((guard) =>
        routeRegistry.guardCoversRoute(routeRegistry.buildMountPath(entry.path, guard.at), fullPath),
      );
      endpoints.push({
        entry,
        fullPath,
        methods: route.methods,
        isWrite: routeRegistry.isWriteMethod(route.methods),
        hasPermissionGuard: covered.some((guard) => Boolean(guard.menu || guard.anyMenu || guard.platformOnly)),
      });
    }
  }
  return endpoints;
}

test.beforeEach(() => {
  rbac.invalidateAuthCaches();
});

test.afterEach(() => {
  database.resetPoolForTesting();
});

test('routeRegistry: 注册表体检零违规(每个接口都已登记守卫口径)', () => {
  const violations = routeRegistry.auditRouteRegistry();
  assert.deepStrictEqual(violations, [], `注册表存在违规:\n- ${violations.join('\n- ')}`);
  // 注册表条目数下限守卫:若有人误删整段条目,体检接口会因“表变空”而虚假通过,
  assert.ok(routeRegistry.ROUTES.length >= 50, `注册表条目数异常(${routeRegistry.ROUTES.length}),疑似被误删`);
  const endpoints = collectMountedEndpoints();
  assert.ok(endpoints.filter((item) => item.isWrite).length >= 30, '写接口样本数量过低,遍历断言已退化');
});

// 遍历全表断言“每个已挂载写接口都要求权限”:以无任何菜单权限的操作员身份逐条请求,
// 有真实权限守卫的必须 403;仅登录即可调用的写接口必须在该条目显式写明 loginOnlyWrites 理由,
test('routeRegistry: 全部已挂载写接口对无权限操作员返回 403(豁免须显式声明)', async () => {
  database.setPoolForTesting(createNoPowerPool());

  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => {
    // 租户内普通操作员:非平台管理员(isAccount=0)且不具备任何菜单权限,
    req.data = { dataBase: 'gm_data_001', userName: 'tester', phone: '13800138000', userId: 2000, isAccount: 0 };
    next();
  });
  routeRegistry.mountApiRoutes(app);

  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    let deniedCount = 0;
    let exemptCount = 0;
    for (const endpoint of collectMountedEndpoints()) {
      if (!endpoint.isWrite) {
        continue;
      }
      if (!endpoint.hasPermissionGuard) {
        // 无权限守卫的写接口必须显式声明理由,否则此处直接判失败(等同于把“仅登录可写”变成可见债务),
        assert.ok(
          typeof endpoint.entry.loginOnlyWrites === 'string' && endpoint.entry.loginOnlyWrites.length > 0,
          `写接口 ${endpoint.fullPath} 仅靠登录即可调用且未声明 loginOnlyWrites 理由`,
        );
        exemptCount += 1;
        continue;
      }
      const response = await fetch(`${base}${endpoint.fullPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.strictEqual(response.status, 403, `写接口 ${endpoint.fullPath} 未被权限守卫拦下`);
      deniedCount += 1;
    }
    assert.ok(deniedCount >= 30, `实际校验到 403 的写接口仅 ${deniedCount} 个,遍历可能失效`);
    assert.ok(exemptCount > 0, '应遍历到已声明豁免的写接口(登录/账户类)');
  } finally {
    server.close();
    database.resetPoolForTesting();
  }
});

// 反向用例:漏登记守卫 / 写接口只挂 loginOnly 且未写理由 / 口径互斥写错 / 条目缺 router,
// 都必须被体检捕获——否则前面的用例只能证明“当下没问题”,无法证明“以后漏写会失败”,
test('routeRegistry: 漏写守卫或口径冲突时体检必须报错', () => {
  const expressRouter = require('express').Router;

  const writeRouter = expressRouter();
  writeRouter.post('/insert', (req, res) => res.status(200).json({ code: 0 }));

  const unguarded = { path: '/api/fake-save', router: writeRouter, note: '漏登记守卫', guards: [{ at: '/update', menu: 'fake' }] };
  const loginOnlyWrite = {
    path: '/api/fake-write',
    router: writeRouter,
    note: '写接口仅登录',
    guards: [{ at: '', loginOnly: true, reason: '未声明 loginOnlyWrites 理由' }],
  };
  const conflicting = {
    path: '/api/fake-conflict',
    router: expressRouter(),
    note: '口径冲突',
    guards: [{ at: '', menu: 'fake', anyMenu: ['fake', 'fake2'] }],
  };
  const missingRouter = { path: '/api/fake-missing', note: '缺 router' };
  const noGuard = { path: '/api/fake-noguard', router: expressRouter(), note: '完全没有守卫声明', guards: [] };

  const violations = routeRegistry.auditRouteRegistry([unguarded, loginOnlyWrite, conflicting, missingRouter, noGuard]);
  assert.strictEqual(violations.length, 5, `应报出 5 处问题,实际:${violations.join(' | ')}`);
  assert.ok(violations.some((line) => line.includes('/api/fake-save/insert') && line.includes('未登记任何守卫')));
  assert.ok(violations.some((line) => line.includes('loginOnlyWrites') && line.includes('/api/fake-write/insert')));
  assert.ok(violations.some((line) => line.includes('menu 与 anyMenu 不能同时声明')));
  assert.ok(violations.some((line) => line.includes('缺少 path 或 router')));
  assert.ok(violations.some((line) => line.includes('未声明任何守卫')));
});

// 注册表必须真正接管挂载顺序:守卫先于业务路由由 mountApiRoutes 保证,
// 这里验证同一条目内“子路径守卫”确实拦在同前缀业务路由之前(顺序错则等于无鉴权),
test('routeRegistry: 同一条目内守卫挂载顺序先于业务路由', () => {
  const app = express();
  const mounts = [];
  app.use = function (mount, handler) {
    // express 内部 Router 工厂函数名为 router,守卫均为匿名中间件,据此区分二者,
    mounts.push({ mount, isRouter: typeof handler === 'function' && handler.name === 'router' });
    return app;
  };
  const fakeEntry = {
    path: '/api/fake-order',
    router: require('express').Router(),
    note: '顺序校验',
    guards: [{ at: '/insert', menu: 'fake' }, { at: '', menu: 'fake' }],
  };
  routeRegistry.mountApiRoutes(app, [fakeEntry]);

  const routerIndex = mounts.findIndex((item) => item.isRouter);
  assert.strictEqual(routerIndex, mounts.length - 1, '业务 router 应在该条目全部守卫之后挂载');
  assert.deepStrictEqual(
    mounts.filter((item) => !item.isRouter).map((item) => item.mount),
    ['/api/fake-order/insert', '/api/fake-order'],
    '守卫挂载顺序应与声明顺序一致且先于业务路由',
  );
});
