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
// 末尾两条针对详情聚合放行名单(审查修复 20261021 二轮 P1-3):挂了 queryDetail 却没登白名单,
// 与白名单里登了一条该前缀上根本不存在的 GET 路径,两个方向都必须报错,否则对账形同虚设,
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
  const detailWithoutWhitelist = {
    path: '/api/fake-detail',
    router: expressRouter(),
    note: '挂了 queryDetail 但白名单无条目',
    guards: [{ at: '', menu: 'fake', queryDetail: true }],
  };
  const whitelistDeadPath = {
    // 借用真实白名单前缀但给一个空 router:/api/room-query/idList 在这张表里不存在,应被判“死路径”,
    path: '/api/room-query',
    router: expressRouter(),
    note: '白名单指向不存在的路径',
    guards: [{ at: '', menu: 'room', queryDetail: true }],
  };

  const violations = routeRegistry.auditRouteRegistry([
    unguarded,
    loginOnlyWrite,
    conflicting,
    missingRouter,
    noGuard,
    detailWithoutWhitelist,
    whitelistDeadPath,
  ]);
  assert.strictEqual(violations.length, 7, `应报出 7 处问题,实际:${violations.join(' | ')}`);
  assert.ok(violations.some((line) => line.includes('/api/fake-save/insert') && line.includes('未登记任何守卫')));
  assert.ok(violations.some((line) => line.includes('loginOnlyWrites') && line.includes('/api/fake-write/insert')));
  assert.ok(violations.some((line) => line.includes('menu 与 anyMenu 不能同时声明')));
  assert.ok(violations.some((line) => line.includes('缺少 path 或 router')));
  assert.ok(violations.some((line) => line.includes('未声明任何守卫')));
  assert.ok(
    violations.some((line) => line.includes('/api/fake-detail') && line.includes('没有对应的详情白名单条目')),
    '挂 queryDetail 却不登白名单未被捕获',
  );
  assert.ok(
    violations.some((line) => line.includes('/api/room-query/idList') && line.includes('没有对应的 GET 路由')),
    '白名单登了不存在的路径未被捕获',
  );
});

test('routeRegistry: 路由内部守卫必须与条目 innerGuards 双向对账', () => {
  // 正向:真实注册表里确实存在内部守卫条目,且逐个能被内省识别(防止名称表写错后断言恒真),
  // 同时要求条目自身的守卫也得声明 platformOnly——权限口径以注册表为准,不允许只活在文件里,
  const declared = routeRegistry.ROUTES.filter((entry) => (entry.innerGuards || []).length > 0);
  assert.strictEqual(declared.length, 5, `账户/账户权限五个条目应声明 innerGuards,实际 ${declared.length}`);
  declared.forEach((entry) => {
    assert.deepStrictEqual(routeRegistry.listRouterInnerGuards(entry.router), ['platformAdmin'], `${entry.path} 内省结果与声明不符`);
    assert.ok(entry.guards.some((guard) => guard.platformOnly), `${entry.path} 内部已有平台管理员守卫,条目守卫也应显式声明 platformOnly`);
  });

  const rbacGuardRouter = require('express').Router();
  rbacGuardRouter.use(rbac.requirePlatformAdmin);
  rbacGuardRouter.post('/insert', (req, res) => res.status(200).json({ code: 0 }));
  const undeclared = { path: '/api/fake-inner', router: rbacGuardRouter, note: '内部守卫未登记', guards: [{ at: '', menu: 'fake' }] };
  const ghost = { path: '/api/fake-ghost', router: require('express').Router(), note: '声明了却不存在的内部守卫', innerGuards: ['platformAdmin'], guards: [{ at: '', platformOnly: true }] };
  const unknown = { path: '/api/fake-unknown', router: require('express').Router(), note: '口径名称写错', innerGuards: ['requireAdmin'], guards: [{ at: '', menu: 'fake' }] };

  const violations = routeRegistry.auditRouteRegistry([undeclared, ghost, unknown]);
  assert.ok(violations.some((line) => line.includes('/api/fake-inner') && line.includes('内部存在未登记的守卫')), 'router 内部守卫隐形未被捕获');
  assert.ok(violations.some((line) => line.includes('/api/fake-ghost') && line.includes('在 router 内部并不存在')), '声明与实现漂移未被捕获');
  assert.ok(violations.some((line) => line.includes('/api/fake-unknown') && line.includes('未知的 innerGuards')), '写错的口径名称未被捕获');
  // 总数账:未知名称同时会计入“漂移”一项,因此是 4 处而不是 3 处,多报即表明对账逻辑在误伤正常条目,
  assert.strictEqual(violations.length, 4, `应只报出 4 处问题,实际:${violations.join(' | ')}`);
});

// 「用户管理」子树与设备白名单的收口对账(审查修复 20261021 三轮 P1-1):
// 这几个接口读写的都是 gm_data_000 里的全局表,语句本身不带租户条件,唯一的隔离就剩权限守卫一行,
// 因此“仅平台管理员”不得只活在注释或菜单配置里:条目必须声明 globalScope + 整前缀 platformOnly,
// 且真实请求必须以 403 结束并证明守卫排在 handler 之前(一条碰 contract 表的 SQL 都不该发出去),
test('routeRegistry: 全局共享表条目必须整前缀收口为仅平台管理员', async () => {
  const PLATFORM_ONLY_ENTRIES = [
    '/api/device',
    '/api/contract-save',
    '/api/contract-query',
    '/api/contract-delete',
    '/api/account-save',
    '/api/account-query',
    '/api/account-delete',
    '/api/accountPower-save',
    '/api/accountPower-query',
  ];
  PLATFORM_ONLY_ENTRIES.forEach((path) => {
    const entry = routeRegistry.ROUTES.find((item) => item.path === path);
    assert.ok(entry, `注册表缺少条目 ${path}`);
    assert.ok(typeof entry.globalScope === 'string' && entry.globalScope.startsWith('gm_data_000.'), `${path} 未声明 globalScope`);
    assert.ok(
      (entry.guards || []).some((guard) => !guard.at && guard.platformOnly),
      `${path} 存在全局表但未按整前缀声明 platformOnly`,
    );
  });

  // 行为面:以租户内普通操作员(isAccount=0,且本例连菜单权限池也返回空)请求合同三个前缀的全部接口,
  // 全部应被平台守卫挡下;若守卫排在 handler 之后,pool 会收到“SELECT * FROM gm_data_000.contract”这种整库语句,
  const noPowerPool = createNoPowerPool();
  database.setPoolForTesting(noPowerPool);
  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => {
    req.data = { dataBase: 'gm_data_001', userName: 'tester', phone: '13800138000', userId: 2000, isAccount: 0 };
    next();
  });
  routeRegistry.mountApiRoutes(app);

  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const contractEndpoints = collectMountedEndpoints().filter((item) => item.entry.path.startsWith('/api/contract'));
    assert.ok(contractEndpoints.length >= 5, `合同接口遍历数异常(${contractEndpoints.length}),用例已退化`);
    for (const endpoint of contractEndpoints) {
      const response = await fetch(`${base}${endpoint.fullPath}`, {
        method: endpoint.methods.includes('GET') ? 'GET' : endpoint.methods[0],
        headers: { 'Content-Type': 'application/json' },
        body: endpoint.methods.includes('GET') ? undefined : JSON.stringify({}),
      });
      assert.strictEqual(response.status, 403, `全局表接口 ${endpoint.fullPath} 未收口为仅平台管理员`);
    }
    assert.deepStrictEqual(
      noPowerPool.calls.filter((call) => String(call.sql).includes('gm_data_000.contract')),
      [],
      '守卫应在 handler 之前结束请求,不应发出任何读取全平台合同的语句',
    );
  } finally {
    server.close();
    database.resetPoolForTesting();
  }
});

// 反向:新登记一个全局表条目却忘收权限 / 又给全局表挂了区域归属,两个方向都必须被体检报错,
// 否则上面的正向断言只能证明“当下没问题”,挡不住以后新增的那一行,
test('routeRegistry: 全局共享表条目漏收权限或误挂归属时报错', () => {
  const emptyRouter = require('express').Router();
  const noPlatform = {
    path: '/api/fake-global',
    router: emptyRouter,
    note: '声明了全局表却没收平台锁',
    globalScope: 'gm_data_000.contract',
    guards: [{ at: '', menu: 'fake' }],
  };
  const withOwnership = {
    path: '/api/fake-global-scope',
    router: emptyRouter,
    note: '全局表不应做区域归属',
    globalScope: 'gm_data_000.contract',
    guards: [{ at: '', platformOnly: true }, { at: '/insert', menu: 'fake', ownership: { table: 'room', idParam: 'idRoom' } }],
  };

  const violations = routeRegistry.auditRouteRegistry([noPlatform, withOwnership]);
  assert.ok(
    violations.some((line) => line.includes('/api/fake-global') && line.includes('却未按整前缀声明 platformOnly')),
    '全局表条目漏收平台锁未被捕获',
  );
  assert.ok(
    violations.some((line) => line.includes('/api/fake-global-scope/insert') && line.includes('不得声明 ownership')),
    '全局表条目误挂区域归属未被捕获',
  );
  // 总数账:两个条目各贡献一处(第二条的平台锁已声明,只报 ownership 那项),多报即为误伤,
  assert.strictEqual(violations.length, 2, `应只报出 2 处问题,实际:${violations.join(' | ')}`);
});

// 登记页下线的防回潮约束(审查修复 20261021 三轮 P1-3):销售/下葬/联系人三个登记页接口已从注册表摘除,
// 写操作唯一入口是 gravePlotBusiness;若有人把它们加回来,等于重新打开一条无预定闸门/不派生下葬记录的旁路,
// 因此这里钉住三层:条目不存在、任何守卫不再引用这三个已下线的菜单名、详情放行菜单全集里不含它们,
test('routeRegistry: 已下线的登记页接口不得重新回到注册表', () => {
  const OFFLINE_PREFIXES = [
    '/api/sale-save',
    '/api/sale-delete',
    '/api/buried-save',
    '/api/buried-delete',
    '/api/contacts-save',
    '/api/contacts-delete',
  ];
  const OFFLINE_MENUS = ['sale', 'buried', 'contacts'];

  OFFLINE_PREFIXES.forEach((path) => {
    assert.ok(!routeRegistry.ROUTES.some((entry) => entry.path === path), `${path} 已随登记页下线,不应再挂载`);
  });

  // 菜单行已从种子库删除,再引用只会得到恒 403 的死守卫,顺带把“臆想中的菜单名”拦在启动前,
  const menuNames = new Set();
  routeRegistry.ROUTES.forEach((entry) => {
    (entry.guards || []).forEach((guard) => {
      if (guard.menu) {
        menuNames.add(guard.menu);
      }
      (guard.anyMenu || []).forEach((name) => menuNames.add(name));
    });
  });
  OFFLINE_MENUS.forEach((name) => {
    assert.ok(!menuNames.has(name), `守卫仍在引用已下线菜单 ${name}`);
  });

  const rbac = require('../rbac');
  OFFLINE_MENUS.forEach((name) => {
    assert.ok(!rbac.DETAIL_PAGE_MENUS.includes(name), `详情放行菜单全集仍含已下线菜单 ${name}`);
  });
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

// 三轮 P1-2 共用口径:四个业务写入口与它们的目标墓位归属作用域(两个用例分别验单区/多区),
const ownRoomScope = { table: 'room', idParam: 'idRoom' };
const BUSINESS_INSERT = [
  { path: '/api/gravePlotBusiness-save', menu: 'gravePlotBusiness' },
  { path: '/api/transferOut-save', menu: 'transferOut' },
  { path: '/api/adminfee-save', menu: 'adminfee' },
  { path: '/api/reserve-save', menu: 'reserve' },
];
const findEntry = (path) => routeRegistry.ROUTES.find((item) => item.path === path);

// 区域归属必须约束“新建”(审查修复 20261021 三轮 P1-2):/update、/delete 早已按主键查归属,
// /insert 却空着——限定区域的操作员仍可直接指定它区 idRoom 新建业务记录。前端可选墓位本身已由区域名单收窄
// (墓位列表按 region 等值 + 园区/区域下拉 filterByOperatorRegions + 显式 region 参数由 requireRegionScope 拦下),
// 所以这道闸只为“绕过界面直调接口”兜底,正常操作零行为变化;两层都钉住:声明层与真实请求层,
test('routeRegistry: 业务新建接口按目标墓位区域收窄(跨区新建 403,本区新建不误伤)', async () => {
  // 1) 声明层:四个业务前缀的 /insert 都必须挂 ownRoomScope——新记录无主键可查,归属只能按目标墓位判定,
  BUSINESS_INSERT.forEach(({ path, menu }) => {
    const insertGuard = (findEntry(path).guards || []).find((guard) => guard.at === '/insert');
    assert.ok(insertGuard, `${path} 缺少 /insert 守卫`);
    assert.strictEqual(insertGuard.menu, menu, `${path}/insert 菜单口径不符`);
    assert.deepStrictEqual(insertGuard.ownership, ownRoomScope, `${path}/insert 未按目标墓位声明区域归属`);
  });

  // 2) 请求层:只跑注册表声明的守卫,业务 handler 换成占位响应
  // (否则要为四种形态各造一套事务 mock,且本用例要验的是守卫而不是业务分支),
  // 墓位 region 由可变开关控制,据此构造“同区/跨区”两种目标墓位, 20261021 新增,
  let roomRegion = '福东';
  database.setPoolForTesting({
    async query(sql) {
      const text = String(sql);
      if (text.includes('operator_power') || text.includes('gm_data_000.menu')) {
        // 权限与菜单存在性检查恒命中:让 403 只能来自区域归属而不是缺菜单权限,
        return [[{ 1: 1 }]];
      }
      return [[{ region: roomRegion }]];
    },
  });

  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => {
    // 福西区操作员(非平台管理员):名单注入口径与 index.js 的 requireRegionScope 结果一致,
    req.data = { dataBase: 'gm_data_001', userName: 'tester', phone: '13800138000', userId: 2400, isAccount: 0 };
    req.operatorRegions = ['福西'];
    next();
  });
  BUSINESS_INSERT.forEach(({ path }) => {
    const insertGuard = (findEntry(path).guards || []).find((guard) => guard.at === '/insert');
    app.use(`${path}/insert`, ...routeRegistry.buildGuardMiddlewares(insertGuard), (req, res) => res.json({ ok: true }));
  });

  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const { path } of BUSINESS_INSERT) {
      roomRegion = '福东';
      const denied = await fetch(`${base}${path}/insert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idRoom: 1 }),
      });
      assert.strictEqual(denied.status, 403, `${path}/insert 它区墓位新建应被归属守卫拦下`);
      const deniedBody = await denied.json();
      assert.ok(deniedBody.error.includes('不属于当前区域'), `${path}/insert 拒绝原因应为区域归属:${deniedBody.error}`);

      roomRegion = '福西';
      const allowed = await fetch(`${base}${path}/insert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idRoom: 1 }),
      });
      assert.strictEqual(allowed.status, 200, `${path}/insert 本区墓位新建不应被误伤`);
    }
  } finally {
    server.close();
    database.resetPoolForTesting();
  }
});

// 一个操作员管多个区是现场现行做法(operator.region 形如“福东,福西”),所以上一条的单区 403 不得被误读成
// “多区操作员也一并锁死”:名单由 rbac.fetchOperatorRegions 按半/全角逗号拆开,归属按 includes 逐项匹配。
// 本用例跑真实链路(requireRegionScope 自己查库注名单,不人工塞 req.operatorRegions),
// 防止日后拆分被改掉(整串当成一个区名)或 includes 改成等值比较时,多区操作员全线 403 却无测可发(三轮 P1-2),
test('routeRegistry: 逗号多区域名单操作员对名单内各区均可新建,名单外区仍 403', async () => {
  let roomRegion = '福东';
  database.setPoolForTesting({
    async query(sql) {
      const text = String(sql);
      if (text.includes('operator_power') || text.includes('gm_data_000.menu')) {
        return [[{ 1: 1 }]];
      }
      if (text.includes('gm_data_000.operator')) {
        // 区域名单真实数据形态:单列逗号串,同时验证全角分隔符也能被拆开,
        return [[{ region: '福东，福西' }]];
      }
      return [[{ region: roomRegion }]];
    },
  });

  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => {
    req.data = { dataBase: 'gm_data_001', userName: 'tester', phone: '13800138000', userId: 2401, isAccount: 0 };
    next();
  });
  // 与 index.js 同源:名单在 requireRegionScope 里注入,后续归属守卫直接读 req.operatorRegions,
  app.use(rbac.requireRegionScope);
  BUSINESS_INSERT.forEach(({ path }) => {
    const insertGuard = (findEntry(path).guards || []).find((guard) => guard.at === '/insert');
    app.use(`${path}/insert`, ...routeRegistry.buildGuardMiddlewares(insertGuard), (req, res) => res.json({ ok: true }));
  });

  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const { path } of BUSINESS_INSERT) {
      for (const inScopeRegion of ['福东', '福西']) {
        roomRegion = inScopeRegion;
        const response = await fetch(`${base}${path}/insert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idRoom: 1 }),
        });
        assert.strictEqual(response.status, 200, `${path}/insert 名单内 ${inScopeRegion} 区不应被误伤`);
      }

      roomRegion = '福南';
      const denied = await fetch(`${base}${path}/insert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idRoom: 1 }),
      });
      assert.strictEqual(denied.status, 403, `${path}/insert 名单外区域应被归属守卫拦下`);
    }
  } finally {
    server.close();
    database.resetPoolForTesting();
  }
});

// 成对规则的机器约束本身也得有牙齿(三轮 P1-2):只钉“当前注册表零违规”不足以证明以后漏写会报错,
// 故反向构造三种条目形态:新建漏归属应报错、写了豁免理由应静默、豁免理由已无对应漏项应报漂移,
test('routeRegistry: /insert 与 /update 的区域归属成对规则可双向报错', () => {
  const emptyRouter = require('express').Router();
  const looseGuards = [{ at: '/insert', menu: 'fake' }, { at: '/update', menu: 'fake', ownership: ownRoomScope }];
  const loose = { path: '/api/fake-loose', router: emptyRouter, note: '新建漏归属', guards: looseGuards };
  const exempted = { path: '/api/fake-exempt', router: emptyRouter, note: '已写豁免理由', insertOwnershipExempt: 'region 就在 body 里', guards: looseGuards };
  const stale = {
    path: '/api/fake-stale',
    router: emptyRouter,
    note: '豁免理由已失效',
    insertOwnershipExempt: '两边都补上了',
    guards: [
      { at: '/insert', menu: 'fake', ownership: ownRoomScope },
      { at: '/update', menu: 'fake', ownership: ownRoomScope },
    ],
  };

  const violations = routeRegistry.auditRouteRegistry([loose, exempted, stale]);
  assert.ok(violations.some((line) => line.includes('/api/fake-loose/insert') && line.includes('未声明 ownership')), '新建漏归属未被捕获');
  assert.ok(!violations.some((line) => line.includes('/api/fake-exempt')), '已写明豁免理由的条目不应被误伤');
  assert.ok(violations.some((line) => line.includes('/api/fake-stale') && line.includes('已无需要豁免')), '失效的豁免理由未被发现');
  // 总数账:loose 一处 + stale 一处,多报即表明规则在误伤正常条目,
  assert.strictEqual(violations.length, 2, `应只报出 2 处问题,实际:${violations.join(' | ')}`);

  // 真实注册表里豁免必须只有一处(批量建位)且理由非空,防止有人把豁免字段当万能后门,
  const exemptEntries = routeRegistry.ROUTES.filter((entry) => entry.insertOwnershipExempt);
  assert.deepStrictEqual(exemptEntries.map((entry) => entry.path), ['/api/room-save'], '区域归属豁免条目应只有批量建位一条');
  exemptEntries.forEach((entry) => {
    assert.ok(String(entry.insertOwnershipExempt).length >= 20, `${entry.path} 的豁免理由过短,不足以判定为有意豁免`);
  });
});
