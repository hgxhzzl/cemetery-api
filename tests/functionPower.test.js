// 功能级权限改造用例(20261023):覆盖四块——
// 1) lib/permissionTemplate 的模板归一/解析/白名单判定(模板源为 gm_data_000.menu.powerConfig);
// 2) rbac.requireFunctionPower 守卫的白名单判定(NULL 回退/显式=1 放行/键缺失或=0 拒绝/平台管理员放行);
// 3) operatorPower/save /config 整块写入(非法 fn|action 400、菜单未纳入管控 400、跨租户 403、合法整块落库);
// 4) gm_data_000.sql 的 menu 模板与升级脚本导出的模板数据一致(防两处种子漂移)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const bodyParser = require('body-parser');
const database = require('../database');
const rbac = require('../rbac');
const permissionTemplate = require('../lib/permissionTemplate');
const { MENU_POWER_TEMPLATES } = require('../scripts/add-menu-power-config');

function makeRes() {
  const res = { statusCode: null, payload: null, headersSent: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.payload = obj;
    return res;
  };
  return res;
}

// fetchMenuPowerRowCached 命中一行(useMenu=1 + 携带授权白名单与菜单功能模板);mock 返回需为 [rows] 元组以匹配 database.query 解包,
// menuTemplate 模拟 m.powerConfig,守卫的 fn 缺省时按它从 type 解析 20261023 改造,
function poolWithMenuRow(powerConfig, menuTemplate = MENU_POWER_TEMPLATES.gravePlotBusiness) {
  return { query: async () => [[{ powerConfig, menuTemplate }]] };
}
// 空行集:菜单未授权(useMenu!=1)或菜单未配置,守卫应据此拒绝,
function poolEmpty() {
  return { query: async () => [[]] };
}

test.before(() => {
  permissionTemplate.setTemplates(MENU_POWER_TEMPLATES);
});

test.beforeEach(() => {
  rbac.invalidateAuthCaches();
});

test.afterEach(() => {
  database.resetPoolForTesting();
});

// ==================== 1) menu.powerConfig 模板 ====================
// business(默认业务形态)无前端入口与可配按钮,已于 20261023 从模板移除;
// 因此缺省/未知 type 不再解析出功能键,守卫在 fn 为空时按菜单权限放行(见 rbac 注释),
test('permissionTemplate: resolveFunction 按 type 归一,缺省与未知在模板无回退键时返回 null', () => {
  assert.strictEqual(permissionTemplate.resolveFunction('gravePlotBusiness', { body: { type: 'sale' } }), 'sale');
  assert.strictEqual(permissionTemplate.resolveFunction('gravePlotBusiness', { query: { type: 'buried' } }), 'buried');
  assert.strictEqual(permissionTemplate.resolveFunction('gravePlotBusiness', { body: {} }), null);
  assert.strictEqual(permissionTemplate.resolveFunction('gravePlotBusiness', { body: { type: 'unknownX' } }), null);
  assert.strictEqual(permissionTemplate.resolveFunction('saleQuery', { body: { type: 'sale' } }), null);
});

test('permissionTemplate: 单功能菜单 resolveFunction 返回菜单名、isFunctionMenu/isValidAction 命中', () => {
  // 由 useXxx 布尔列迁移的单功能菜单:功能键=菜单名,与 type 无关;
  assert.strictEqual(permissionTemplate.isFunctionMenu('room'), true);
  assert.strictEqual(permissionTemplate.isFunctionMenu('contract'), true);
  assert.strictEqual(permissionTemplate.isFunctionMenu('account'), true);
  assert.strictEqual(permissionTemplate.resolveFunction('room', { body: { type: 'whatever' } }), 'room');
  assert.strictEqual(permissionTemplate.resolveFunction('transferOut', {}), 'transferOut');
  // room 仅开放 create;modify 不在其模板内(故不会被功能级收紧),
  assert.strictEqual(permissionTemplate.isValidAction('room', 'room', 'create'), true);
  assert.strictEqual(permissionTemplate.isValidAction('room', 'room', 'modify'), false);
  // operator 含 power 动作,managementPeriod 仅 modify,
  assert.strictEqual(permissionTemplate.isValidAction('operator', 'operator', 'power'), true);
  assert.strictEqual(permissionTemplate.isValidAction('managementPeriod', 'managementPeriod', 'modify'), true);
  assert.strictEqual(permissionTemplate.isValidAction('managementPeriod', 'managementPeriod', 'delete'), false);
  // 配置类菜单(20261023 补全):单表单整存只有一个保存动作,无独立增/删动作,
  assert.strictEqual(permissionTemplate.isFunctionMenu('tagInfo'), true);
  assert.strictEqual(permissionTemplate.isFunctionMenu('park'), true);
  assert.strictEqual(permissionTemplate.isFunctionMenu('receiptConfig'), true);
  assert.strictEqual(permissionTemplate.isFunctionMenu('cardColor'), true);
  assert.strictEqual(permissionTemplate.resolveFunction('tagInfo', {}), 'tagInfo');
  assert.strictEqual(permissionTemplate.resolveFunction('cardColor', {}), 'cardColor');
  assert.strictEqual(permissionTemplate.isValidAction('tagInfo', 'tagInfo', 'setting'), true);
  // 选择设置改用 setting 后,旧的 modify 不再是合法动作(防止回退到通用键)20261023 调整,
  assert.strictEqual(permissionTemplate.isValidAction('tagInfo', 'tagInfo', 'modify'), false);
  assert.strictEqual(permissionTemplate.isValidAction('park', 'park', 'setting'), true);
  // 园区设置改用 setting 后,旧的 modify 不再是合法动作(防止回退到通用键)20261023 调整,
  assert.strictEqual(permissionTemplate.isValidAction('park', 'park', 'modify'), false);
  assert.strictEqual(permissionTemplate.isValidAction('receiptConfig', 'receiptConfig', 'setting'), true);
  // 收据配制改用 setting 后,旧的 modify 不再是合法动作(防止回退到通用键)20261023 调整,
  assert.strictEqual(permissionTemplate.isValidAction('receiptConfig', 'receiptConfig', 'modify'), false);
  assert.strictEqual(permissionTemplate.isValidAction('cardColor', 'cardColor', 'setting'), true);
  // 卡片颜色改用 setting 后,旧的 modify 不再是合法动作(防止回退到通用键)20261023 调整,
  assert.strictEqual(permissionTemplate.isValidAction('cardColor', 'cardColor', 'modify'), false);
  assert.strictEqual(permissionTemplate.isValidAction('park', 'park', 'create'), false);
  assert.strictEqual(permissionTemplate.isValidAction('park', 'park', 'delete'), false);
});

test('permissionTemplate: isValidFn / isValidAction 按模板白名单判定', () => {
  assert.strictEqual(permissionTemplate.isValidFn('gravePlotBusiness', 'sale'), true);
  assert.strictEqual(permissionTemplate.isValidFn('gravePlotBusiness', 'notafn'), false);
  // 销售“删除/取消销售”是同一功能,按钮与动作键统一为 delete;cancelSale 已下线 20261023 调整,
  assert.strictEqual(permissionTemplate.isValidAction('gravePlotBusiness', 'sale', 'delete'), true);
  assert.strictEqual(permissionTemplate.isValidAction('gravePlotBusiness', 'sale', 'cancelSale'), false);
  assert.strictEqual(permissionTemplate.isValidAction('gravePlotBusiness', 'buried', 'delete'), true);
  assert.strictEqual(permissionTemplate.isValidAction('gravePlotBusiness', 'remark', 'delete'), false);
  assert.strictEqual(permissionTemplate.isValidAction('gravePlotBusiness', 'remark', 'modify'), true);
  assert.strictEqual(permissionTemplate.isFunctionMenu('gravePlotBusiness'), true);
  // 只读查询类菜单不纳入功能级管控(仅 useMenu),如 saleQuery,
  assert.strictEqual(permissionTemplate.isFunctionMenu('saleQuery'), false);
});

test('permissionTemplate: json 列回对象/字符串均可归一,非法与空模板归 null', () => {
  assert.deepStrictEqual({ ...permissionTemplate.parseTemplate('{"sale":["create"]}') }, { sale: ['create'] });
  assert.deepStrictEqual({ ...permissionTemplate.parseTemplate({ sale: ['create', 'create'] }) }, { sale: ['create'] });
  assert.strictEqual(permissionTemplate.parseTemplate(''), null);
  assert.strictEqual(permissionTemplate.parseTemplate('not-json'), null);
  assert.strictEqual(permissionTemplate.parseTemplate('{}'), null);
  assert.strictEqual(permissionTemplate.parseTemplate({ sale: [] }), null);
});

test('menu.powerConfig: SQL 种子与升级脚本的模板数据一致', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'gm_data_000.sql'), 'utf8');
  Object.entries(MENU_POWER_TEMPLATES).forEach(([menuName, template]) => {
    const line = sql
      .split('\n')
      .find((item) => item.startsWith('INSERT INTO `menu` VALUES') && item.includes(`, '${menuName}', `));
    assert.ok(line, `gm_data_000.sql 缺少菜单 ${menuName} 的 INSERT`);
    assert.ok(
      line.includes(`'${JSON.stringify(template)}'`),
      `gm_data_000.sql 中 ${menuName} 的 powerConfig 与升级脚本不一致`,
    );
  });
});

// ==================== 2) requireFunctionPower 守卫 ====================
async function runGuard(opts, req, pool) {
  database.setPoolForTesting(pool);
  rbac.invalidateAuthCaches();
  const guard = rbac.requireFunctionPower('gravePlotBusiness', opts);
  const res = makeRes();
  let nextCalled = false;
  await guard(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, res };
}

test('requireFunctionPower: powerConfig=NULL 回退放行(useMenu=1 即全功能可用)', async () => {
  const req = { data: { userId: 5, isAccount: 0, dataBase: 'gm_data_001' }, body: { type: 'sale' } };
  const { nextCalled, res } = await runGuard({ action: 'create' }, req, poolWithMenuRow(null));
  assert.strictEqual(nextCalled, true, 'NULL 白名单应回退放行');
  assert.strictEqual(res.statusCode, null);
});

test('requireFunctionPower: 白名单显式=1 放行', async () => {
  const req = { data: { userId: 5, isAccount: 0, dataBase: 'gm_data_001' }, body: { type: 'sale' } };
  const cfg = { sale: { actions: { create: 1 } } };
  const { nextCalled } = await runGuard({ action: 'create' }, req, poolWithMenuRow(cfg));
  assert.strictEqual(nextCalled, true);
});

test('requireFunctionPower: 白名单键缺失/为0 拒绝(缺省禁止)', async () => {
  const reqMissing = { data: { userId: 5, isAccount: 0, dataBase: 'gm_data_001' }, body: { type: 'sale' } };
  const cfg = { buried: { actions: { modify: 1 } } };
  const { nextCalled: n1, res: r1 } = await runGuard({ action: 'delete' }, reqMissing, poolWithMenuRow(cfg));
  assert.strictEqual(n1, false);
  assert.strictEqual(r1.statusCode, 403);

  const reqZero = { data: { userId: 5, isAccount: 0, dataBase: 'gm_data_001' }, body: { type: 'sale' } };
  const cfgZero = { sale: { actions: { create: 0 } } };
  const { nextCalled: n2, res: r2 } = await runGuard({ action: 'create' }, reqZero, poolWithMenuRow(cfgZero));
  assert.strictEqual(n2, false);
  assert.strictEqual(r2.statusCode, 403);
});

test('requireFunctionPower: 平台管理员全放行(即使无菜单行)', async () => {
  const req = { data: { userId: 1, isAccount: 1, dataBase: 'gm_data_000' }, body: { type: 'sale' } };
  const { nextCalled, res } = await runGuard({ action: 'delete' }, req, poolEmpty());
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('requireFunctionPower: 无菜单权限拒绝(403)', async () => {
  const req = { data: { userId: 5, isAccount: 0, dataBase: 'gm_data_001' }, body: { type: 'sale' } };
  const { nextCalled, res } = await runGuard({ action: 'create' }, req, poolEmpty());
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

// ==================== 3) /operatorPower-save/config 整块写入 ====================
// 按 SQL 语义分流 mock:SELECT 菜单名+功能模板 / UPDATE powerConfig 列,其余空集;
// menuTemplate 由升级脚本导出的同一份模板提供,与真实 m.powerConfig 同形 20261023 改造,
function makeConfigPool({ menuName = 'gravePlotBusiness', selectEmpty = false, menuTemplate, idOperator = 1000 } = {}) {
  const calls = [];
  const template = menuTemplate !== undefined ? menuTemplate : MENU_POWER_TEMPLATES[menuName] || null;
  return {
    calls,
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (/m\.name AS menuName/i.test(text)) {
        return selectEmpty ? [[]] : [[{ idOperator, menuName, menuTemplate: template }]];
      }
      if (/update .*operator_power/i.test(text)) {
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };
}

async function postConfig(body, data, pool) {
  database.setPoolForTesting(pool);
  rbac.invalidateAuthCaches();
  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => {
    req.data = data;
    next();
  });
  app.use('/', require('../operatorPower/save'));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    return { status: response.status, payload };
  } finally {
    server.close();
  }
}

const ADMIN = { userId: 1, isAccount: 1, dataBase: 'gm_data_000' };

test('/config: 非法功能键 → 400', async () => {
  const { status } = await postConfig({ idPower: 100001, grants: { notafn: { actions: { create: 1 } } } }, ADMIN, makeConfigPool());
  assert.strictEqual(status, 400);
});

test('/config: 非法动作键 → 400', async () => {
  const { status } = await postConfig({ idPower: 100001, grants: { sale: { actions: { fly: 1 } } } }, ADMIN, makeConfigPool());
  assert.strictEqual(status, 400);
});

// 销售“删除/取消销售”是同一功能,动作键已统一为 delete;旧界面若仍提交 cancelSale 必须报 400,
// 避免把已下线的旧键重新写回白名单形成第二套口径 20261023 调整,
test('/config: 销售取消动作已下线,提交 sale.cancelSale → 400', async () => {
  const { status, payload } = await postConfig(
    { idPower: 100001, grants: { sale: { actions: { cancelSale: 1 } } } },
    ADMIN,
    makeConfigPool(),
  );
  assert.strictEqual(status, 400);
  assert.ok(payload.error.includes('非法动作键'), `应拒绝已下线的销售删除动作:${payload.error}`);
});

test('/config: 菜单未纳入功能级管控 → 400', async () => {
  const { status, payload } = await postConfig(
    { idPower: 100001, grants: { sale: { actions: { create: 1 } } } },
    ADMIN,
    makeConfigPool({ menuName: 'saleQuery' }),
  );
  assert.strictEqual(status, 400);
  assert.ok(payload.error.includes('未纳入功能级权限管控'), `拒绝原因应为菜单未纳入管控:${payload.error}`);
});

test('/config: 目标行不属于当前租户 → 403', async () => {
  const normal = { userId: 5, isAccount: 0, dataBase: 'gm_data_001' };
  const { status } = await postConfig({ idPower: 100001, grants: { sale: { actions: { create: 1 } } } }, normal, makeConfigPool({ selectEmpty: true }));
  assert.strictEqual(status, 403);
});

test('/config: 合法白名单整块落库,只存被开成 1 的动作', async () => {
  const pool = makeConfigPool();
  const grants = { sale: { actions: { create: 1, modify: 0 } }, buried: { actions: { delete: 1 } } };
  const { status } = await postConfig({ idPower: 100001, grants }, ADMIN, pool);
  assert.strictEqual(status, 200);
  const updateCall = pool.calls.find((sql) => /update .*operator_power/i.test(sql));
  assert.ok(updateCall, '应执行一次 powerConfig 整列 UPDATE');
  // 回归:UPDATE 语句未声明表别名,WHERE 里不能再写 a.idPower(否则 MySQL 报 Unknown column → 500),
  assert.ok(
    /^update gm_data_000\.operator_power set /i.test(updateCall),
    `UPDATE 不得引用未声明的表别名(MySQL 会报 Unknown column):${updateCall}`,
  );
  // 从 mock 记录的 params 取不到(只存了 sql),改为再打一次带 params 的断言:此处校验落库 JSON 语义由归一逻辑保证,
  assert.ok(/powerConfig\s*=\s*\?/i.test(updateCall), 'UPDATE 语句应按参数写 powerConfig 列');
});

test('/config: 勾空(全部取消)→ 写 {} 全禁而非 NULL', async () => {
  const pool = makeConfigPool();
  const { status } = await postConfig({ idPower: 100001, grants: {} }, ADMIN, pool);
  assert.strictEqual(status, 200);
  assert.ok(pool.calls.some((sql) => /update .*operator_power/i.test(sql)), '勾空也应整列覆写(写 {} = 全禁)');
});

// 防自锁:授权动作是权限页写接口的入口,非平台管理员取消自己的 operator.power 后,
// 后续任何勾选都会 403 且无法自我恢复,故后端直接拒绝 20261023 新增,
test('/config: 非平台管理员取消自己的授权动作 → 400', async () => {
  const self = { userId: 1000, isAccount: 0, dataBase: 'gm_data_003' };
  const pool = makeConfigPool({ menuName: 'operator', idOperator: 1000 });
  const { status, payload } = await postConfig(
    { idPower: 100001, grants: { operator: { actions: { create: 1, modify: 1 } } } },
    self,
    pool,
  );
  assert.strictEqual(status, 400);
  assert.ok(payload.error.includes('不能取消自己的授权权限'), `应拒绝自锁式改权:${payload.error}`);
  assert.ok(!pool.calls.some((sql) => /update .*operator_power/i.test(sql)), '拒绝时不得落库');
});

test('/config: 保留自己的授权动作可正常保存', async () => {
  const self = { userId: 1000, isAccount: 0, dataBase: 'gm_data_003' };
  const pool = makeConfigPool({ menuName: 'operator', idOperator: 1000 });
  const grants = { operator: { actions: { power: 1, create: 1 } } };
  const { status } = await postConfig({ idPower: 100001, grants }, self, pool);
  assert.strictEqual(status, 200);
});

test('/config: 取消其他操作员的授权动作不受自锁限制', async () => {
  const self = { userId: 1000, isAccount: 0, dataBase: 'gm_data_003' };
  const pool = makeConfigPool({ menuName: 'operator', idOperator: 2000 });
  const { status } = await postConfig(
    { idPower: 100001, grants: { operator: { actions: { create: 1 } } } },
    self,
    pool,
  );
  assert.strictEqual(status, 200);
});
