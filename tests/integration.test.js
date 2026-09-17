// 业务事务联动集成测试:mock 连接池注入,断言 sale/buried 的 SQL 语句序列与冗余字段同步 20260917 新增,
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bodyParser = require('body-parser');
const database = require('../database');

// mock 连接池:记录所有 SQL 调用,SELECT 返回预设行;mysql2 风格 query 返回 [rows, fields] 元组 20260917 新增,
function createMockPool(selectRows = []) {
  let rows = selectRows;
  const calls = [];
  return {
    calls,
    setSelectRows(nextRows) {
      rows = nextRows;
    },
    async query(sql, params) {
      calls.push({ sql, params });
      return [rows];
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async query(sql, params) {
          calls.push({ sql, params });
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
    async end() {},
  };
}

// 挂载路由并模拟认证中间件注入租户信息 20260917 新增,
function startServer(router, mountPath) {
  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => {
    req.data = { dataBase: 'gm_data_001', userName: 'tester', phone: '13800138000', exp: '1789000000' };
    next();
  });
  app.use(mountPath, router);
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test.afterEach(() => {
  database.resetPoolForTesting();
});

test('sale/delete: 软删销售 + 墓位回置未销售(清空buyer) + 软删联系人 + contacts聚合,同一事务', async () => {
  const mockPool = createMockPool([{ payer: '张三' }]);
  database.setPoolForTesting(mockPool);

  const saleDelete = require('../sale/delete');
  const { server, base } = startServer(saleDelete, '/api/sale-delete');
  try {
    const response = await fetch(`${base}/api/sale-delete?idRoom=1000001`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.code, 0);

    const calls = mockPool.calls;
    const sqls = calls.map((call) => call.sql);
    // 1. 先查活动销售记录的付款人
    assert.ok(sqls[0].includes('SELECT payer'));
    // 2. 软删 sale:条件参数化
    assert.ok(sqls.some((sql) => sql.includes('gm_data_001.sale set') && sql.includes('idRoom = ? AND isDeleted = 0')));
    // 3. 墓位回置未销售 + 清空购买人(值在 params 中)
    const roomUpdate = calls.find((call) => call.sql.includes('gm_data_001.room set'));
    assert.ok(roomUpdate);
    assert.ok(roomUpdate.params.includes('statusType.saleStatusEnum.unsold'));
    assert.ok(roomUpdate.params.includes(''));
    // 4. 软删联系人:按 idRoom + 付款人匹配
    const contactsDelete = calls.find((call) => call.sql.includes('gm_data_001.contacts set'));
    assert.ok(contactsDelete);
    assert.ok(contactsDelete.params.includes('张三'));
    // 5. contacts 聚合同步 room.contacts
    assert.ok(sqls.some((sql) => sql.includes('GROUP_CONCAT(c.contacts')));
  } finally {
    server.close();
  }
});

test('buried/save insert: 下葬 + 锚定日期 + 墓位置已下葬 + deceased聚合 + 联系人新增 + contacts聚合,同一事务', async () => {
  // 联系人匹配查询返回空 → 走"名/电话均不存在则新增"分支
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const buriedSave = require('../buried/save');
  const { server, base } = startServer(buriedSave, '/api/buried-save');
  try {
    const response = await fetch(`${base}/api/buried-save/insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idRoom: '1000001',
        burialDate: '2026-09-17',
        deceased: '李四',
        contacts: '张三',
        contactsphone: '13800138000',
        contactsIDCard: '110101199001011234',
      }),
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.code, 0);

    const calls = mockPool.calls;
    const sqls = calls.map((call) => call.sql);
    // 1. 联系人匹配查询
    assert.ok(sqls[0].includes('from gm_data_001.contacts where idRoom = ?'));
    // 2. 插入下葬记录
    assert.ok(sqls.some((sql) => sql.includes('insert into gm_data_001.buried')));
    // 3. 管理费起止日期锚定(参数化)
    assert.ok(sqls.some((sql) => sql.includes('select min(burialDate)') && sql.includes('coalesce(endDate')));
    // 4. 墓位置已下葬
    const roomUpdate = calls.find(
      (call) => call.sql.includes('gm_data_001.room set') && call.params.includes('statusType.intoStatusEnum.buried'),
    );
    assert.ok(roomUpdate);
    // 5. deceased 聚合同步 room.deceased
    assert.ok(sqls.some((sql) => sql.includes('GROUP_CONCAT(b.deceased')));
    // 6. 联系人新增(参数化,身份证号一并带入)
    const contactsInsert = calls.find((call) => call.sql.includes('insert into gm_data_001.contacts'));
    assert.ok(contactsInsert);
    assert.ok(contactsInsert.params.includes('张三'));
    assert.ok(contactsInsert.params.includes('110101199001011234'));
    // 7. contacts 聚合同步 room.contacts
    assert.ok(sqls.some((sql) => sql.includes('GROUP_CONCAT(c.contacts')));
  } finally {
    server.close();
  }
});

test('login/logout: 删除 login_session 登录态记录,当前 token 立即失效', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const login = require('../login');
  const { server, base } = startServer(login, '/api/login');
  try {
    const response = await fetch(`${base}/api/login/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.code, 0);

    const calls = mockPool.calls;
    // 仅一条 DELETE login_session 语句,按 phone 主键删除(phone 取自认证中间件注入的 req.data)
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].sql.includes('DELETE FROM gm_data_000.login_session'));
    assert.ok(calls[0].params.includes('13800138000'));
  } finally {
    server.close();
  }
});

test('reserve/save insert: 预定记录 + 墓位置预定,同一事务', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const reserveSave = require('../reserve/save');
  const { server, base } = startServer(reserveSave, '/api/reserve-save');
  try {
    const response = await fetch(`${base}/api/reserve-save/insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idRoom: '1000001',
        reserveDate: '2026-09-17',
        contacts: '王五',
        contactsphone: '13900139000',
      }),
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.code, 0);

    const calls = mockPool.calls;
    // 1. 插入预定记录(联系人一并带入)
    const reserveInsert = calls.find((call) => call.sql.includes('insert into gm_data_001.reserve'));
    assert.ok(reserveInsert);
    assert.ok(reserveInsert.params.includes('王五'));
    // 2. 墓位置预定 + 预定状态(值在 params 中)
    const roomUpdate = calls.find(
      (call) => call.sql.includes('gm_data_001.room set') && call.params.includes('statusType.saleStatusEnum.reserve'),
    );
    assert.ok(roomUpdate);
    assert.ok(roomUpdate.params.includes('statusType.reserveStatusEnum.reserved'));
  } finally {
    server.close();
  }
});

test('transferOut/delete: 软删迁出 + 无剩余活动记录时墓位回置未迁出,同一事务', async () => {
  // 剩余活动迁出记录数 cnt=0 → 走墓位回置分支
  const mockPool = createMockPool([{ cnt: 0 }]);
  database.setPoolForTesting(mockPool);

  const transferOutDelete = require('../transferOut/delete');
  const { server, base } = startServer(transferOutDelete, '/api/transferOut-delete');
  try {
    const response = await fetch(`${base}/api/transferOut-delete?idTransfer=1&idRoom=1000001`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.code, 0);

    const calls = mockPool.calls;
    // 1. 先统计该墓位剩余活动迁出记录
    assert.ok(calls[0].sql.includes('select count(*) as cnt'));
    // 2. 软删迁出记录(isDeleted=1 在 params 中)
    assert.ok(calls.some((call) => call.sql.includes('gm_data_001.transfer_out set') && call.params.includes(1)));
    // 3. 墓位迁出状态回置未迁出
    const roomUpdate = calls.find(
      (call) =>
        call.sql.includes('gm_data_001.room set') && call.params.includes('statusType.transferOutStatusEnum.notOut'),
    );
    assert.ok(roomUpdate);
  } finally {
    server.close();
  }
});

test('adminfee/delete: 软删收款 + 按剩余活动记录重算管理费结束日期,同一事务', async () => {
  const mockPool = createMockPool([{ idRoom: '1000001' }]);
  database.setPoolForTesting(mockPool);

  const adminfeeDelete = require('../adminfee/delete');
  const { server, base } = startServer(adminfeeDelete, '/api/adminfee-delete');
  try {
    const response = await fetch(`${base}/api/adminfee-delete?idAdminfee=9`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.code, 0);

    const calls = mockPool.calls;
    // 1. 先取收款记录所属墓位
    assert.ok(calls[0].sql.includes('select idRoom from gm_data_001.adminfee'));
    // 2. 软删收款记录(idAdminfee 参数化,值以字符串形式传递)
    assert.ok(calls.some((call) => call.sql.includes('gm_data_001.adminfee set') && call.params.includes('9')));
    // 3. 结束日期按剩余活动记录重算(coalesce 无剩余时回退开始日期)
    const endDateUpdate = calls.find((call) => call.sql.includes('coalesce') && call.sql.includes('startDate'));
    assert.ok(endDateUpdate);
    assert.ok(endDateUpdate.params.includes('1000001'));
  } finally {
    server.close();
  }
});

test('rbac: 非平台管理员调用全局管理接口返回 403', async () => {
  const rbac = require('../rbac');
  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => {
    req.data = { dataBase: 'gm_data_001', userName: 'tester', phone: '13800138000', userId: 2000, isAccount: 0 };
    next();
  });
  app.get('/guard', rbac.requirePlatformAdmin, (req, res) => res.status(200).json({ code: 0 }));
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/guard`);
    assert.strictEqual(response.status, 403);
  } finally {
    server.close();
  }
});

test('rbac: 平台管理员短路放行,不查询权限表', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const rbac = require('../rbac');
  const app = express();
  app.use((req, res, next) => {
    req.data = { dataBase: 'gm_data_000', userName: 'admin', phone: '13766891959', userId: 1000, isAccount: 1 };
    next();
  });
  app.get('/guard', rbac.requirePower('103102', 'create'), (req, res) => res.status(200).json({ code: 0 }));
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/guard`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(mockPool.calls.length, 0);
  } finally {
    server.close();
  }
});

test('rbac: 操作员具备菜单动作权限时放行,否则 403', async () => {
  const mockPool = createMockPool([{ ok: 1 }]);
  database.setPoolForTesting(mockPool);

  const rbac = require('../rbac');
  const app = express();
  app.use((req, res, next) => {
    req.data = { dataBase: 'gm_data_001', userName: 'tester', phone: '13800138000', userId: 2000, isAccount: 0 };
    next();
  });
  app.get('/guard', rbac.requirePower('103102', 'create'), (req, res) => res.status(200).json({ code: 0 }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    // 有权限:mock 返回非空权限行 → 放行
    const okResponse = await fetch(`${base}/guard`);
    assert.strictEqual(okResponse.status, 200);
    // 无权限:mock 返回空 → 403
    mockPool.setSelectRows([]);
    const deniedResponse = await fetch(`${base}/guard`);
    assert.strictEqual(deniedResponse.status, 403);
    // 权限查询语句按菜单ID与动作列过滤(useCreate)
    const permSql = mockPool.calls.find((call) => call.sql.includes('operator_power'));
    assert.ok(permSql);
    assert.ok(permSql.sql.includes('useCreate = 1'));
  } finally {
    server.close();
  }
});

test('operator/save password: 非平台管理员跨租户改密返回 403', async () => {
  // 目标操作员属于 gm_data_002,调用者租户为 gm_data_001 → 跨租户拒绝
  const mockPool = createMockPool([{ idOperator: 1000, dataBaseName: 'gm_data_002', isAccount: 1, password: 'x' }]);
  database.setPoolForTesting(mockPool);

  const operatorSave = require('../operator/save');
  const { server, base } = startServer(operatorSave, '/api/operator-save');
  try {
    const response = await fetch(`${base}/api/operator-save/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idOperator: 1000, oldPassword: 'x', newPassword: 'y' }),
    });
    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.ok(body.error.includes('本租户'));
  } finally {
    server.close();
  }
});
