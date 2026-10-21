// 业务事务联动集成测试:mock 连接池注入,断言 sale/buried 的 SQL 语句序列与冗余字段同步 20260917 新增,
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bodyParser = require('body-parser');
const database = require('../database');

// mock 连接池:记录所有 SQL 调用,SELECT 返回预设行;mysql2 风格 query 返回 [rows, fields] 元组 20260917 新增,
// 20261021 扩展:第二参可传 { routes: [[子串, rows], ...] } 按语句模式路由不同返回行,
// 适配同一用例内多种 SELECT 需不同形状行的场景(未命中任何模式时返回空行集)
function createMockPool(selectRows = []) {
  const routes = selectRows && !Array.isArray(selectRows) && Array.isArray(selectRows.routes) ? selectRows.routes : null;
  const defaultRows = Array.isArray(selectRows) ? selectRows : [];
  let rows = defaultRows;
  const calls = [];
  const resolveRows = (sql) => {
    if (!routes) {
      return rows;
    }
    const hit = routes.find(([pattern]) => String(sql).includes(pattern));
    return hit ? hit[1] : [];
  };
  return {
    calls,
    setSelectRows(nextRows) {
      rows = nextRows;
    },
    async query(sql, params) {
      calls.push({ sql, params });
      return [resolveRows(sql)];
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async query(sql, params) {
          calls.push({ sql, params });
          return [resolveRows(sql)];
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
    async end() {},
  };
}

// 挂载路由并模拟认证中间件注入租户信息(可选 next.data 覆盖负载,用于构造平台/租户管理员不同口径) 20260917 新增,
function startServer(router, mountPath, overrideData) {
  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => {
    req.data = { dataBase: 'gm_data_001', userName: 'tester', phone: '13800138000', exp: '1789000000', ...(overrideData || {}) };
    next();
  });
  app.use(mountPath, router);
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test.afterEach(() => {
  database.resetPoolForTesting();
});

// 守卫缓存(菜单权限命中/区域名单)为进程级 30s TTL,用例间必须主动作废,
// 否则同一 userId 在上一条用例里缓存的结果会串到下一条,使 mock 改行集不再生效 20261021 新增,
test.beforeEach(() => {
  require('../rbac').invalidateAuthCaches();
});

// 批量建位上限(审查修复 20261021 P1-3):排×号跨度乘积即待建行数由前端任意给定,超限必须 400 且不发出任何写库语句,
// 否则一次提交数万条 insert 会打满事务内未提交行与内存,
test('room/save insert: 批量建位超过上限时 400 且不发任何写库语句', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const roomSave = require('../room/save');
  const { server, base } = startServer(roomSave, '/api/room-save');
  try {
    const response = await fetch(`${base}/api/room-save/insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: '福东', park: '一园', yNum: 1, yNumTo: 40, xNum: 1, xNumTo: 40 }),
    });
    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.ok(/上限/.test(body.error), `应答应说明超限原因,实际: ${body.error}`);
    assert.ok(!mockPool.calls.some((call) => call.sql.includes('insert into')), '超限时不应发出插入语句');
  } finally {
    server.close();
    database.resetPoolForTesting();
  }
});

// 批量建位去重与影响行数(审查修复 20261021 P1-3):已占用坐标在事务内 FOR UPDATE 一次读出后建 Set 去重,
// 跳过已存在行不重复插入;函数型事务项的返回行数需计入 affectedRows(原写法恒计 0),
test('room/save insert: 事务内锁定已占用坐标,跳过重复且 affectedRows 计入实建行数', async () => {
  const mockPool = createMockPool({
    routes: [['select yNum, xNum from gm_data_001.room', [{ yNum: 1, xNum: 1 }]]],
  });
  database.setPoolForTesting(mockPool);

  const roomSave = require('../room/save');
  const { server, base } = startServer(roomSave, '/api/room-save');
  try {
    const response = await fetch(`${base}/api/room-save/insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: '福东', park: '一园', yNum: 1, yNumTo: 2, xNum: 1, xNumTo: 2 }),
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.affectedRows, 3, '4 个待建坐标中 1 个已占用,应计 3 行');
    // 统一信封后实建/跳过行数与 affectedRows 一同放入 data 下发(前端 transformRequestHook 只返回 data),
    assert.deepStrictEqual(body.data, { affectedRows: 3, created: 3, skipped: 1 }, '应回报实建与跳过行数');

    const lock = mockPool.calls.find((call) => call.sql.includes('for update'));
    assert.ok(lock, '已有坐标应在事务内加锁读取');
    assert.ok(lock.sql.includes('isDeleted = 0'), '只锁活动墓位(已软删行可复用坐标)');
    assert.ok(lock.sql.includes("transferOutStatus <> 'statusType.transferOutStatusEnum.out'"), '已迁出坐标应视为空位');

    const inserts = mockPool.calls.filter((call) => call.sql.includes('insert into gm_data_001.room'));
    assert.strictEqual(inserts.length, 3, '不应为已占用坐标插入重复墓位');
    // 从列名清单定位 yNum/xNum 对应参数,核对实建的就是剩下三个坐标 20261021 新增,
    const coordKeys = inserts.map((call) => {
      const cols = call.sql
        .slice(call.sql.indexOf('(') + 1, call.sql.indexOf(')'))
        .split(',')
        .map((item) => item.trim());
      return `${call.params[cols.indexOf('yNum')]}:${call.params[cols.indexOf('xNum')]}`;
    });
    assert.deepStrictEqual(coordKeys.sort(), ['1:2', '2:1', '2:2'], '应跳过已占用的 1排1号');
    // 事务项内的语句经连接层统一做 $N→? 归一:语句构造器输出 $N 占位符,
    // 而驱动未开 namedPlaceholders,原样发出会报 Unknown column '$1' 20261021 新增,
    assert.ok(!inserts[0].sql.includes('$1'), '事务项内语句应已归一为 ? 占位符');
    assert.strictEqual((inserts[0].sql.match(/\?/g) || []).length, inserts[0].params.length, '占位符与参数个数应一致');
  } finally {
    server.close();
    database.resetPoolForTesting();
  }
});

// 修改操作员列白名单:非平台管理员提交 isAccount=1(自我提权)或 dataBaseName(跳租户)不得进入 SET,
// 业务列照常落库;账户同步分支改按库中 isAccount 判定,客户端提交值不采信 20261021 审查修复 中F,
test('operator/save update: 非平台管理员提交的提权列被剔除,业务列照常更新', async () => {
  const mockPool = createMockPool({
    routes: [
      ['SELECT dataBaseName, isAccount, phone FROM gm_data_000.operator', [{ dataBaseName: 'gm_data_001', isAccount: 0, phone: '13800138000' }]],
    ],
  });
  database.setPoolForTesting(mockPool);

  const operatorSave = require('../operator/save');
  const { server, base } = startServer(operatorSave, '/api/operator-save');
  try {
    const response = await fetch(`${base}/api/operator-save/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idOperator: 1001,
        name: '张三',
        region: '福东',
        isAccount: 1,
        dataBaseName: 'gm_data_999',
        createDate: '2020-01-01 00:00:00',
      }),
    });
    assert.strictEqual(response.status, 200);

    const update = mockPool.calls.find((call) => call.sql.includes('gm_data_000.operator set'));
    assert.ok(update, '应发出操作员更新语句');
    assert.ok(update.sql.includes('name ='), '业务列 name 应落库');
    assert.ok(update.sql.includes('region ='), '业务列 region 应落库');
    assert.ok(!update.sql.includes('isAccount'), '提权列 isAccount 不得落库');
    assert.ok(!update.sql.includes('dataBaseName'), '提权列 dataBaseName 不得落库');
    assert.ok(!update.sql.includes('createDate'), '审计列 createDate 不得由客户端覆写');
  } finally {
    server.close();
    database.resetPoolForTesting();
  }
});

test('sale/delete: 软删销售 + 墓位回置未销售(清空buyer) + 软删联系人 + contacts聚合,同一事务', async () => {
  // 20261018 ④ 改版后语句序列:先取活动销售(idSale+payer),再统计剩余非派生下葬,后接事务写 20261021 对齐既有失败用例,
  const mockPool = createMockPool({
    routes: [
      ['FROM gm_data_001.sale', [{ idSale: 12, payer: '张三' }]],
      ['from gm_data_001.buried', [{ cnt: 0, minBurial: null }]],
    ],
  });
  database.setPoolForTesting(mockPool);

  const saleDelete = require('../sale/delete');
  const { server, base } = startServer(saleDelete, '/api/sale-delete');
  try {
    const response = await fetch(`${base}/api/sale-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idRoom: 1000001 }),
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.code, 0);

    const calls = mockPool.calls;
    const sqls = calls.map((call) => call.sql);
    // 1. 先查活动销售记录的付款人
    assert.ok(sqls[0].includes('SELECT idSale, payer'));
    // 2. 软删 sale:条件参数化
    assert.ok(sqls.some((sql) => sql.includes('gm_data_001.sale set') && sql.includes('idRoom = ? AND isDeleted = 0')));
    // 3. 墓位回置未销售 + 清空购墓人(值在 params 中;按 unsold 参数定位,避开归零链路先发的 room 起止清空语句)
    const roomUpdate = calls.find(
      (call) => call.sql.includes('gm_data_001.room set') && call.params.includes('statusType.saleStatusEnum.unsold'),
    );
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
    // 1. 锚定日先查最早下葬日(20261018 ⑤ 改版后首位不再是联系人匹配,改为断言其存在),联系人匹配随后在列
    assert.ok(sqls.some((sql) => sql.includes('select min(burialDate)')));
    assert.ok(sqls.some((sql) => sql.includes('from gm_data_001.contacts where idRoom = ?')));
    // 2. 插入下葬记录
    assert.ok(sqls.some((sql) => sql.includes('insert into gm_data_001.buried')));
    // 3. 管理费起止锚定链:重排需先读活动收款行,再写 room 起止(20261018 ⑤ 改版后不再直写 coalesce(endDate)
    assert.ok(sqls.some((sql) => sql.includes('from gm_data_001.adminfee') && sql.includes('order by createDate asc')));
    // 20261021 审查修复中C:费用链的读全部落在事务内且先锁墓位行,收款行读取同样带行锁,
    assert.ok(sqls.some((sql) => sql.includes('gm_data_001.room where idRoom = ? for update')));
    assert.ok(sqls.some((sql) => sql.includes('order by createDate asc, idAdminfee asc for update')));
    assert.ok(sqls.some((sql) => sql.includes('gm_data_001.room set startDate')));
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

// 改密与登录态必须联动:口令改了但 login_session 仍活跃时,旧 token 在到期前依然能调全部接口 20261021 审查修复 P0-3,
test('operator/password: 改密成功后作废该手机号的活跃登录态', async () => {
  const public = require('../public');
  const hashedOld = await public.hashPassword('old-pass-123');
  const mockPool = createMockPool({
    routes: [
      [
        'FROM gm_data_000.operator WHERE idOperator = ?',
        [{ idOperator: 1001, dataBaseName: 'gm_data_001', isAccount: 0, phone: '13900139000', password: hashedOld }],
      ],
    ],
  });
  database.setPoolForTesting(mockPool);

  const operatorSave = require('../operator/save');
  const { server, base } = startServer(operatorSave, '/api/operator-save');
  try {
    const response = await fetch(`${base}/api/operator-save/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idOperator: 1001, oldPassword: 'old-pass-123', newPassword: 'new-pass-456' }),
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.data, 1, '旧密码匹配且新密码合法时应返回修改成功');

    const revoke = mockPool.calls.find((call) => call.sql.includes('DELETE FROM gm_data_000.login_session'));
    assert.ok(revoke, '应作废旧的活跃登录态');
    assert.ok(revoke.params.includes('13900139000'), '按库中取出的 phone 删除,而不是客户端提交值');
  } finally {
    server.close();
  }
});

// 一个手机号在多个园区各一条操作员时,旧写法静默取 results[0]（取哪一行由引擎决定）可能跨租户误登 20261021 审查修复 P0-4,
test('login: 同一手机号命中多个园区且未指定园区时拒绝登录', async () => {
  const twoCandidates = [
    { idOperator: 1, dataBaseName: 'gm_data_001', isAccount: 0, password: 'x' },
    { idOperator: 2, dataBaseName: 'gm_data_002', isAccount: 0, password: 'x' },
  ];
  const mockPool = createMockPool({
    routes: [['FROM gm_data_000.operator a,gm_data_000.account b', twoCandidates]],
  });
  database.setPoolForTesting(mockPool);

  const login = require('../login');
  const { server, base } = startServer(login, '/api/login');
  try {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '13800138000', password: 'any' }),
    });
    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.ok(String(body.message).includes('个园区账号'), '应提示需要区分园区');
    // 查候选集的 SQL 必须带固定排序,不能依赖引擎返回顺序
    assert.ok(mockPool.calls[0].sql.includes('ORDER BY b.dataBaseName'));
  } finally {
    server.close();
  }
});

test('reserve/save insert: 预定记录 + 墓位置已预定(销售状态不动),同一事务', async () => {
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
        // 预定限期为必填(20261011 新增),缺失会被 400 拦下
        reservationExpireDate: '2026-12-31',
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
    // 预定限期随行写入 20261011 新增 20261011 字段改名
    assert.ok(reserveInsert.sql.includes('reservationExpireDate'));
    assert.ok(reserveInsert.params.includes('2026-12-31'));
    // 2. 墓位只置预定状态,不得改写销售状态(预定不等于售出) 20261011 修正,
    const roomUpdate = calls.find(
      (call) => call.sql.includes('gm_data_001.room set') && call.params.includes('statusType.reserveStatusEnum.reserved'),
    );
    assert.ok(roomUpdate);
    assert.ok(!roomUpdate.sql.includes('saleStatus'));
    assert.ok(!roomUpdate.params.includes('statusType.saleStatusEnum.reserve'));
    assert.ok(!roomUpdate.params.includes('statusType.saleStatusEnum.unsold'));
    // 3. 墓位预定限期副本同步:由活动预定记录反推,与置预定状态同一事务 20261011 新增,
    const roomExpireSync = calls.find((call) => call.sql.includes('set r.reservationExpireDate'));
    assert.ok(roomExpireSync);
    assert.ok(roomExpireSync.sql.includes('select max(res.reservationExpireDate)'));
    assert.ok(roomExpireSync.sql.includes('gm_data_001.reserve'));
  } finally {
    server.close();
  }
});

// 一穴一条预定记录:同一墓位反复预定(含取消后重新预定)不得累积多条,否则预定人/限期取值全靠运气 20261011 新增
test('reserve/save insert: 该墓位已有预定记录时复用原行而不新增第二条', async () => {
  // 查现存记录的 SELECT 与后续语句共用 mock 返回行→命中"已有记录"分支 20261011 新增,
  const mockPool = createMockPool([{ idReserve: 2000009 }]);
  database.setPoolForTesting(mockPool);

  const reserveSave = require('../reserve/save');
  const { server, base } = startServer(reserveSave, '/api/reserve-save');
  try {
    const response = await fetch(`${base}/api/reserve-save/insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idRoom: '1000001',
        liaison: '王五',
        liaisonPhone: '13900139000',
        reservationExpireDate: '2026-12-31',
        remark: '重新预定',
      }),
    });
    assert.strictEqual(response.status, 200);

    const calls = mockPool.calls;
    const sqls = calls.map((call) => call.sql);
    // 1. 不再发出 reserve 插入语句 20261011 新增,
    assert.ok(!sqls.some((sql) => sql.includes('insert into gm_data_001.reserve')));
    // 2. 复用原行按 idReserve 更新,限期写入且 isDeleted 回置 0;idRoom 不进 SET 子句 20261011 新增,
    const reserveUpdate = calls.find(
      (call) => call.sql.includes('gm_data_001.reserve set') && call.sql.includes('where idReserve = ?'),
    );
    assert.ok(reserveUpdate);
    assert.ok(!reserveUpdate.sql.split(' where ')[0].includes('idRoom ='));
    assert.ok(reserveUpdate.params.includes(2000009));
    assert.ok(reserveUpdate.params.includes('2026-12-31'));
    assert.ok(reserveUpdate.params.includes(0));
    // 3. 同穴其余活动记录软删收敛 20261011 新增,
    assert.ok(
      sqls.some((sql) => sql.includes('gm_data_001.reserve set isDeleted = 1 where idRoom = ? and idReserve <> ? and isDeleted = 0')),
    );
    // 4. 墓位置预定与限期副本同步仍在同一事务内跟着走 20261011 新增,
    assert.ok(sqls.some((sql) => sql.includes('gm_data_001.room set')));
    assert.ok(sqls.some((sql) => sql.includes('set r.reservationExpireDate')));
  } finally {
    server.close();
  }
});

// 墓区业务页预定入口与预定登记页共用同一辅助函数,两个入口得同样不堆积 20261011 新增
test('gravePlotBusiness/save insert(reserve): 已有预定记录时同样复用原行', async () => {
  const mockPool = createMockPool([{ idReserve: 2000012 }]);
  database.setPoolForTesting(mockPool);

  const businessSave = require('../gravePlotBusiness/save');
  const { server, base } = startServer(businessSave, '/api/gravePlotBusiness-save');
  try {
    const response = await fetch(`${base}/api/gravePlotBusiness-save/insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idRoom: '1000001',
        type: 'reserve',
        payer: '张预定',
        payerPhone: '13800138000',
        remark: '业务页预定',
      }),
    });
    assert.strictEqual(response.status, 200);

    const calls = mockPool.calls;
    const sqls = calls.map((call) => call.sql);
    assert.ok(!sqls.some((sql) => sql.includes('insert into gm_data_001.reserve')));
    const reserveUpdate = calls.find(
      (call) => call.sql.includes('gm_data_001.reserve set') && call.sql.includes('where idReserve = ?'),
    );
    assert.ok(reserveUpdate);
    assert.ok(reserveUpdate.params.includes(2000012));
    // 联系人/电话按 liaison/liaisonPhone 列名回落 20261011 新增,
    assert.ok(reserveUpdate.params.includes('张预定'));
    assert.ok(sqls.some((sql) => sql.includes('gm_data_001.room set')));
  } finally {
    server.close();
  }
});

// 预定限期必填拦截:空值会被 normalizeBodyDates 转成 null,直接落库会报错或写入零值日期 20261011 新增
test('reserve/save insert: 缺 reservationExpireDate 时 400 且不发出任何写入语句', async () => {
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
        liaison: '王五',
        liaisonPhone: '13900139000',
        reservationExpireDate: '',
      }),
    });
    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.ok(body.error.includes('reservationExpireDate'));
    assert.strictEqual(mockPool.calls.length, 0);
  } finally {
    server.close();
  }
});

// 预定修改同步墓位限期副本:reserve 改了而 room 没改,墓位侧展示的到期日就是旧值 20261011 新增
test('reserve/save update: 预定记录更新 + 墓位限期副本同步,同一事务', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const reserveSave = require('../reserve/save');
  const { server, base } = startServer(reserveSave, '/api/reserve-save');
  try {
    const response = await fetch(`${base}/api/reserve-save/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idReserve: '2000001',
        idRoom: '1000001',
        liaison: '王五',
        liaisonPhone: '13900139000',
        reservationExpireDate: '2027-01-31',
      }),
    });
    assert.strictEqual(response.status, 200);

    const calls = mockPool.calls;
    const sqls = calls.map((call) => call.sql);
    // 1. 预定记录按 idReserve 更新,限期入 SET 子句,而 idRoom 仅作同步靶子不得回落为更新列 20261011 新增,
    const reserveUpdate = calls.find((call) => call.sql.includes('gm_data_001.reserve set'));
    assert.ok(reserveUpdate);
    assert.ok(reserveUpdate.sql.includes('reservationExpireDate = ?'));
    assert.ok(!reserveUpdate.sql.includes('idRoom = ?'));
    assert.ok(reserveUpdate.params.includes('2027-01-31'));
    // 2. 限期副本同步语句排在预定更新之后(同事务内才能读到新值) 20261011 新增,
    const syncIndex = sqls.findIndex((sql) => sql.includes('set r.reservationExpireDate'));
    assert.ok(syncIndex > -1);
    assert.ok(syncIndex > sqls.indexOf(reserveUpdate.sql));
    assert.ok(sqls[syncIndex].includes('gm_data_001.reserve'));
    // 3. 按 idReserve 反查所属墓位,不拿调用方的 idRoom 当条件 20261011 新增,
    assert.ok(sqls[syncIndex].includes('res2.idReserve = 2000001'));
  } finally {
    server.close();
  }
});

// 修改预定时调用方漏传 idRoom,限期副本仍得跟着改(旧写法依赖 idRoom,漏传就静默不同步) 20261011 新增
test('reserve/save update: 不带 idRoom 时仍按 idReserve 反查墓位同步限期副本', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const reserveSave = require('../reserve/save');
  const { server, base } = startServer(reserveSave, '/api/reserve-save');
  try {
    const response = await fetch(`${base}/api/reserve-save/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idReserve: '2000001',
        liaison: '王五',
        reservationExpireDate: '2027-03-31',
      }),
    });
    assert.strictEqual(response.status, 200);

    const sqls = mockPool.calls.map((call) => call.sql);
    assert.ok(sqls.some((sql) => sql.includes('gm_data_001.reserve set')));
    const syncSql = sqls.find((sql) => sql.includes('set r.reservationExpireDate'));
    assert.ok(syncSql);
    assert.ok(syncSql.includes('res2.idReserve = 2000001'));
  } finally {
    server.close();
  }
});

// 墓区业务页预定修改与预定登记页同一口径:改期必同步墓位副本 20261011 新增
test('gravePlotBusiness/save update(reserve): 预定记录更新 + 墓位限期副本同步,同一事务', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const businessSave = require('../gravePlotBusiness/save');
  const { server, base } = startServer(businessSave, '/api/gravePlotBusiness-save');
  try {
    const response = await fetch(`${base}/api/gravePlotBusiness-save/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idRoom: '1000001',
        idBusiness: '2000015',
        type: 'reserve',
        payer: '张预定',
        payerPhone: '13800138000',
        reservationExpireDate: '2027-06-30',
      }),
    });
    assert.strictEqual(response.status, 200);

    const calls = mockPool.calls;
    const sqls = calls.map((call) => call.sql);
    const reserveUpdate = calls.find(
      (call) => call.sql.includes('gm_data_001.reserve set') && call.sql.includes('where idReserve = ?'),
    );
    assert.ok(reserveUpdate);
    assert.ok(reserveUpdate.params.includes('2027-06-30'));
    const syncIndex = sqls.findIndex((sql) => sql.includes('set r.reservationExpireDate'));
    assert.ok(syncIndex > sqls.indexOf(reserveUpdate.sql));
    assert.ok(sqls[syncIndex].includes('res2.idReserve = 2000015'));
  } finally {
    server.close();
  }
});

// 取消预定后墓位限期必须清空:否则墓位仍显示一个已失效的到期日 20261011 新增
test('reserve/delete: 软删预定 + 墓位只回置未预定(销售状态不动) + 限期副本清空,同一事务', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const reserveDelete = require('../reserve/delete');
  const { server, base } = startServer(reserveDelete, '/api/reserve-delete');
  try {
    const response = await fetch(`${base}/api/reserve-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idRoom: 1000001 }),
    });
    assert.strictEqual(response.status, 200);

    const sqls = mockPool.calls.map((call) => call.sql);
    // 1. 预定记录软删 20261011 新增,
    assert.ok(sqls.some((sql) => sql.includes('gm_data_001.reserve set') && sql.includes('idRoom = ? AND isDeleted = 0')));
    // 2. 墓位状态回置:只回预定状态,销售状态不能跟着回未销售(否则已销售墓位会被取消预定打回) 20261011 修正,
    const roomUpdate = mockPool.calls.find((call) => call.sql.includes('gm_data_001.room set'));
    assert.ok(roomUpdate);
    assert.ok(roomUpdate.params.includes('statusType.reserveStatusEnum.unreserved'));
    assert.ok(!roomUpdate.sql.includes('saleStatus'));
    assert.ok(!roomUpdate.params.includes('statusType.saleStatusEnum.unsold'));
    // 3. 限期副本靠子查询无活动记录自然回 NULL,故 isDeleted = 0 过滤条件不能丢 20261011 新增,
    const roomExpireSync = sqls.find((sql) => sql.includes('set r.reservationExpireDate'));
    assert.ok(roomExpireSync);
    assert.ok(roomExpireSync.includes('res.isDeleted = 0'));
  } finally {
    server.close();
  }
});

test('gravePlotBusiness/save update(sale): 下葬日期/死亡日期留空时绑 null 而非空串', async () => {
  // 20261012 加编号占位校验后同一用例内多种 SELECT 需不同行形:销售行带 oldPayer/idRoom、
  // 区域查询带 region、占位查重返回空、buried 存在性返回 idBuried → 走“有记录则更新”分支 20261021 对齐既有失败用例,
  const mockPool = createMockPool({
    routes: [
      ['FROM gm_data_001.sale', [{ oldPayer: '张三', idRoom: 1000001 }]],
      ['select region from', [{ region: '福东' }]],
      ['select idRoom from', []],
      ['SELECT idBuried FROM', [{ idBuried: 3000001 }]],
      ['select min(burialDate)', [{ minBurial: null }]],
    ],
  });
  database.setPoolForTesting(mockPool);

  const businessSave = require('../gravePlotBusiness/save');
  const { server, base } = startServer(businessSave, '/api/gravePlotBusiness-save');
  try {
    const response = await fetch(`${base}/api/gravePlotBusiness-save/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'sale',
        idBusiness: '1000001',
        idRoom: '1000001',
        payer: '张三',
        payerPhone: '13800138000',
        payerIDCard: '110101199001011234',
        payee: '李四',
        serialNo: '000123',
        deceased: '王五',
        // 两个日期均留空:normalizeBodyDates 已将空串转 null,落到更新语句应绑 null(datetime 写空串在严格模式下会报错) 20261011 新增,
        deathDate: '',
        burialDate: '',
        deceasedIDCard: '',
        deceasedRelation: '',
        remark: '',
      }),
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.code, 0);

    const buriedUpdate = mockPool.calls.find((call) => call.sql.includes('gm_data_001.buried set'));
    assert.ok(buriedUpdate, '应发出 buried 更新语句');
    // 语句下发前 normalizeSql 已将 $N 占位符换为 ?,故按 SET 子句的出现顺序定位参数位置
    // (getUpdateByIdStatement 的 params 与 SET 逐项一一对应) 20261011 新增,
    const setClause = buriedUpdate.sql.split(' set ')[1].split(' where ')[0];
    const assignments = setClause.split(',');
    const findParam = (field) => {
      const index = assignments.findIndex((item) => item.trim().startsWith(`${field} =`));
      return buriedUpdate.params[index];
    };
    assert.ok(assignments.some((item) => item.trim().startsWith('burialDate =')), 'buried 更新应包含下葬日期列');
    assert.ok(assignments.some((item) => item.trim().startsWith('deathDate =')), 'buried 更新应包含死亡日期列');
    assert.strictEqual(findParam('burialDate'), null);
    assert.strictEqual(findParam('deathDate'), null);
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
    const response = await fetch(`${base}/api/transferOut-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idTransfer: 1, idRoom: 1000001 }),
    });
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
    const response = await fetch(`${base}/api/adminfee-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idAdminfee: 9 }),
    });
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
    // 无权限:mock 返回空 → 403。命中结果已改为 30s TTL 缓存,故先作废缓存模拟“管理员改了权限”
    // 后再发第二个请求,否则仍会拿到上一条的缓存放行结果(审查修复 20261021 P2 性能),
    mockPool.setSelectRows([]);
    rbac.invalidateAuthCaches();
    const deniedResponse = await fetch(`${base}/guard`);
    assert.strictEqual(deniedResponse.status, 403);
    // 权限查询语句按菜单ID过滤(useMenu)
    const permSql = mockPool.calls.find((call) => call.sql.includes('operator_power'));
    assert.ok(permSql);
    assert.ok(permSql.sql.includes('useMenu = 1'));
  } finally {
    server.close();
  }
});

// 墓位信息查询改写后的语句口径(审查修复 20261021 P2 性能):count 不再 JOIN sale/contacts 派生表,
// 日期/关键词改判 EXISTS,联系人列对本页行走相关子查询;参数个数必须与 ? 个数逐项对齐,
test('roomQuery/list: count 单表取数,日期与关键词走 EXISTS,不再全表聚合派生表', async () => {
  const mockPool = createMockPool({ routes: [['COUNT(*) AS total', [{ total: 7 }]], ['FROM gm_data_001.room r WHERE', []]] });
  database.setPoolForTesting(mockPool);

  const roomQuery = require('../roomQuery/query');
  const { server, base } = startServer(roomQuery, '/api/room-query');
  try {
    const response = await fetch(
      `${base}/api/room-query/list?region=%E7%A6%8F%E4%B8%9C&startDate=2026-01-01&endDate=2026-01-31&keyword=%E5%BC%A0&sold=true&current=2&pageSize=20`,
    );
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.data.total, 7);

    const calls = mockPool.calls.filter((call) => call.sql.includes('gm_data_001.room r'));
    assert.strictEqual(calls.length, 2, '应先 count 后取页两段查询');
    const [countCall, dataCall] = calls;

    assert.ok(!countCall.sql.includes('LEFT JOIN'), 'count 不应再 JOIN 任何表');
    assert.ok(!countCall.sql.includes('GROUP BY idRoom'), '不应再带全表聚合的派生表');
    assert.ok(countCall.sql.includes('EXISTS (SELECT 1 FROM gm_data_001.sale s'), '日期范围应改判 EXISTS');
    assert.ok(countCall.sql.includes('EXISTS (SELECT 1 FROM gm_data_001.contacts ck'), '关键词应包含联系人 EXISTS');
    assert.strictEqual((countCall.sql.match(/\?/g) || []).length, countCall.params.length, 'count 占位符与参数个数应一致');

    assert.ok(!dataCall.sql.includes('LEFT JOIN'), '本页取数不应再 JOIN sale/contacts');
    assert.ok(dataCall.sql.includes('AS payerPhone'), '销售列应以别名保留');
    assert.ok(dataCall.sql.includes('AS contacts'), '联系人列应以别名保留');
    assert.strictEqual(dataCall.params[dataCall.params.length - 2], 20, 'pageSize 应为最后一个参数前一位');
    assert.strictEqual(dataCall.params[dataCall.params.length - 1], 20, 'offset 应为 (current-1)*pageSize');
    assert.strictEqual((dataCall.sql.match(/\?/g) || []).length, dataCall.params.length, '页查询占位符与参数个数应一致');
  } finally {
    server.close();
    database.resetPoolForTesting();
  }
});

// 响应信封统一(审查修复 20261021 P1-5):全站历史手写 `json({ error })` 经 normalizeEnvelope 补齐 code/message,
// 0 行更新不再是 `code: 0`+404 的矛盾体,前端无论读 message 还是读 error 都能拿到可读文案,
test('响应信封: 历史 {error} 写法与 0 行更新都输出可用 code/message', async () => {
  const publicFun = require('../public');
  const app = express();
  app.use(publicFun.normalizeEnvelope);
  app.get('/legacy', (req, res) => res.status(400).json({ error: '编号已被其它墓位占用' }));
  app.get('/ok', (req, res) => res.json({ code: 0, data: { list: [] } }));
  app.get('/zero', (req, res) => publicFun.respondAffectedRows(res, { affectedRows: 0 }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const legacy = await fetch(`${base}/legacy`);
    assert.strictEqual(legacy.status, 400);
    const legacyBody = await legacy.json();
    assert.strictEqual(legacyBody.code, 400, '缺 code 时应取 HTTP 状态码');
    assert.strictEqual(legacyBody.message, '编号已被其它墓位占用', 'error 文案应透到 message');

    const ok = await fetch(`${base}/ok`);
    const okBody = await ok.json();
    assert.strictEqual(okBody.code, 0);
    assert.strictEqual(okBody.message, '操作成功', '成功体补默认 message');
    assert.strictEqual(okBody.error, undefined, '成功体不应背 error 字段');

    const zero = await fetch(`${base}/zero`);
    assert.strictEqual(zero.status, 404);
    const zeroBody = await zero.json();
    assert.notStrictEqual(zeroBody.code, 0, '0 行更新不能仍报成功码');
    assert.ok(zeroBody.message.includes('不存在'), '给出语义 message');
    assert.strictEqual(zeroBody.error, zeroBody.message, '兼容位 error 与 message 同值');
  } finally {
    server.close();
  }
});

test('rbac: 菜单权限命中结果 30s 内复用缓存,授权变更后立即作废', async () => {
  // 一次页面加载会并行打多个接口前缀,每个守卫都要跑一次 operator_power JOIN(审查修复 20261021 P2 性能),
  // 同一 userId + 同一菜单集合的命中结果应只打一次库;权限落库后不得再拿旧结果放行,
  const mockPool = createMockPool([{ 1: 1 }]);
  database.setPoolForTesting(mockPool);

  const rbac = require('../rbac');
  const app = express();
  app.use((req, res, next) => {
    req.data = { dataBase: 'gm_data_001', userName: 'tester', phone: '13800138000', userId: 2100, isAccount: 0 };
    next();
  });
  app.get('/guard', rbac.requirePowerByMenuName('room'), (req, res) => res.status(200).json({ code: 0 }));
  const server = app.listen(0);
  const powerCalls = () => mockPool.calls.filter((call) => call.sql.includes('operator_power')).length;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.strictEqual((await fetch(`${base}/guard`)).status, 200);
    assert.strictEqual((await fetch(`${base}/guard`)).status, 200);
    assert.strictEqual((await fetch(`${base}/guard`)).status, 200);
    assert.strictEqual(powerCalls(), 1, '同一次会话内重复命中应只打一次库');

    // 模拟管理员把该菜单权限关掉:作废旧结果后下一次请求必须重新查库并 403,
    rbac.invalidateAuthCaches();
    mockPool.setSelectRows([]);
    assert.strictEqual((await fetch(`${base}/guard`)).status, 403);
    assert.strictEqual(powerCalls(), 2, '作废缓存后应重新查库');
  } finally {
    server.close();
  }
});

test('rbac: 按菜单 name 守卫的占位符顺序与参数数组一致(防位置绑定错位)', async () => {
  // 回归 20261019:权限查询单语句化时把 m.name IN (?) 写在 JOIN 段,其占位符早于 WHERE 的 a.idOperator = ?;
  // mysql2 按占位符出现顺序消费参数数组,于是菜单名被绑给 idOperator、userId 被绑给 m.name,命中恒为空,
  // 表现为所有非平台管理员账号打开业务页(墓位设置/选择设置等)均 403“缺少该菜单操作权限”。
  // mock 池不解析 SQL,故此处直接断言 SQL 里的占位符次序与参数数组内容 20261019 新增,
  const mockPool = createMockPool([{ 1: 1 }]);
  database.setPoolForTesting(mockPool);

  const rbac = require('../rbac');
  const app = express();
  app.use((req, res, next) => {
    req.data = { dataBase: 'gm_data_001', userName: 'tester', phone: '13800138000', userId: 2000, isAccount: 0 };
    next();
  });
  app.get('/guard-name', rbac.requirePowerByMenuName('room'), (req, res) => res.status(200).json({ code: 0 }));
  app.get('/guard-any', rbac.requirePowerByAnyMenuName('room', 'sale'), (req, res) => res.status(200).json({ code: 0 }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.strictEqual((await fetch(`${base}/guard-name`)).status, 200);
    assert.strictEqual((await fetch(`${base}/guard-any`)).status, 200);

    const nameCall = mockPool.calls.find((call) => call.sql.includes('operator_power') && call.params.length === 2);
    const anyCall = mockPool.calls.find((call) => call.sql.includes('operator_power') && call.params.length === 3);
    for (const call of [nameCall, anyCall]) {
      assert.ok(call, '应命中一条 operator_power 权限查询');
      // 首位参数必须是 userId,且每个 ? 都有对应参数
      assert.strictEqual(call.params[0], 2000);
      assert.strictEqual((call.sql.match(/\?/g) || []).length, call.params.length);
      // idOperator 的 ? 必须早于菜单名的 ? 出现,否则位置绑定会互换
      const idIndex = call.sql.indexOf('a.idOperator = ?');
      const nameIndex = call.sql.indexOf('m.name IN (');
      assert.ok(idIndex > -1 && nameIndex > -1);
      assert.ok(idIndex < nameIndex, '菜单名占位符必须排在 a.idOperator 占位符之后');
    }
    assert.deepStrictEqual(nameCall.params, [2000, 'room']);
    assert.deepStrictEqual(anyCall.params, [2000, 'room', 'sale']);
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

test('cardColor/query: 整库一条配色记录原样下发(不解析 JSON)', async () => {
  const storedJson =
    '{"unsold":{"color":"#FCF6EF","border":"#FCA678","isEnabled":true},"sold":{"color":"#F4FEF9","border":"#00A870","isEnabled":true},' +
    '"buried":{"color":"#F4F8FE","border":"#0052D9","isEnabled":true},"expired":{"color":"#FCE5E5","border":"#D54941","isEnabled":true}}';
  const mockPool = createMockPool([{ idConfig: 1, configJson: storedJson }]);
  database.setPoolForTesting(mockPool);

  const cardColorQuery = require('../cardColor/query');
  const { server, base } = startServer(cardColorQuery, '/api/cardColor-query');
  try {
    const response = await fetch(`${base}/api/cardColor-query/color`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.data.list[0].configJson, storedJson);
    assert.ok(mockPool.calls[0].sql.includes('FROM gm_data_001.card_color'));
  } finally {
    server.close();
  }
});

test('cardColor/save: 合法配色色值规整大写并更新现有行(只做更新)', async () => {
  // SELECT 返回现有配置行 → 走 UPDATE 分支
  const mockPool = createMockPool([{ idConfig: 1 }]);
  database.setPoolForTesting(mockPool);

  const cardColorSave = require('../cardColor/save');
  const { server, base } = startServer(cardColorSave, '/api/cardColor-save');
  const item = (color, border, isEnabled) => ({ color, border, isEnabled });
  try {
    const response = await fetch(`${base}/api/cardColor-save/color`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          unsold: item('#dbd53a', '#a59f1f', true),
          reserved: item('#fff0d9', '#d68c22', true),
          sold: item('#f4fef9', '#00a870', true),
          buried: item('#f4f8fe', '#0052d9', false),
          expired: item('#fce5e5', '#d54941', true),
        },
      }),
    });
    assert.strictEqual(response.status, 200);

    const updateCall = mockPool.calls.find((call) => call.sql.includes('UPDATE gm_data_001.card_color'));
    assert.ok(updateCall, '应发出按现有 idConfig 的 UPDATE 语句');
    assert.strictEqual(updateCall.params[1], 1);
    // 小写入参统一大写入库,供前端直接当 CSS 变量值使用
    assert.ok(updateCall.params[0].includes('"#DBD53A"'));
    assert.ok(updateCall.params[0].includes('"isEnabled":false'));
  } finally {
    server.close();
  }
});

test('cardColor/save: 非法色值与缺态直接 400,不下发任何写库语句', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const cardColorSave = require('../cardColor/save');
  const { server, base } = startServer(cardColorSave, '/api/cardColor-save');
  const item = (color) => ({ color, border: color, isEnabled: true });
  try {
    // 脏色值(带空格/非十六进制)会被 CSS 变量直接吸收,必须在入口拦掉
    const badColor = await fetch(`${base}/api/cardColor-save/color`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { unsold: item('#GGGGGG'), sold: item('#F4FEF9'), buried: item('#F4F8FE'), expired: item('#FCE5E5') },
      }),
    });
    assert.strictEqual(badColor.status, 400);
    assert.ok((await badColor.json()).error.includes('颜色值格式错误'));

    // 缺一态(前端漏传)同样拒绝
    const missingState = await fetch(`${base}/api/cardColor-save/color`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { unsold: item('#DBD53A'), sold: item('#F4FEF9'), buried: item('#F4F8FE') } }),
    });
    assert.strictEqual(missingState.status, 400);
    assert.strictEqual(mockPool.calls.length, 0);
  } finally {
    server.close();
  }
});

test('cardColor/save: 配置行被误删时补插 idConfig=1,保证保存不失败', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const cardColorSave = require('../cardColor/save');
  const { server, base } = startServer(cardColorSave, '/api/cardColor-save');
  const item = (color, border, isEnabled) => ({ color, border, isEnabled });
  try {
    const response = await fetch(`${base}/api/cardColor-save/color`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          unsold: item('#FCF6EF', '#FCA678', true),
          reserved: item('#FFF0D9', '#D68C22', true),
          sold: item('#F4FEF9', '#00A870', true),
          buried: item('#F4F8FE', '#0052D9', true),
          expired: item('#FCE5E5', '#D54941', true),
        },
      }),
    });
    assert.strictEqual(response.status, 200);

    const insertCall = mockPool.calls.find((call) => call.sql.includes('INSERT INTO gm_data_001.card_color'));
    assert.ok(insertCall, '无现有行时应补插一条');
    // 补插固定用 idConfig=1(写进 SQL 字面量),参数位仅 configJson
    assert.ok(insertCall.sql.includes('(idConfig, configJson) VALUES (1, ?)'));
    assert.ok(insertCall.params[0].includes('"unsold"'));
  } finally {
    server.close();
  }
});

// 首页预定记录分页:活动预定 + 预定限期>=当天 + 墓位未售出未迁出,区域条件由 rbac 构造 20261011 新增,
test('dashboard/reserve-list: 预定记录按区域分页,SQL 含未售出与预定限期条件', async () => {
  const mockPool = createMockPool([{ total: 1, idReserve: 7000001, park: '宝禄', xyNumber: '8排3号' }]);
  database.setPoolForTesting(mockPool);

  const dashboardQuery = require('../dashboard/query');
  const { server, base } = startServer(dashboardQuery, '/api/dashboard-query');
  try {
    const response = await fetch(`${base}/api/dashboard-query/reserve-list?region=%E7%A6%8F%E4%B8%9C&current=1`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.data.total, 1);
    assert.strictEqual(body.data.list.length, 1);

    assert.strictEqual(mockPool.calls.length, 2, '应为 count + 数据两条查询');
    const dataCall = mockPool.calls[1];
    assert.ok(dataCall.sql.includes('gm_data_001.reserve rv'));
    assert.ok(dataCall.sql.includes('JOIN gm_data_001.room r ON rv.idRoom = r.idRoom'));
    assert.ok(dataCall.sql.includes('rv.reservationExpireDate >= CURDATE()'));
    assert.ok(dataCall.sql.includes("r.saleStatus <> 'statusType.saleStatusEnum.sold'"));
    assert.ok(dataCall.sql.includes('rv.liaison AS contacts'));
    // 区域等值条件与分页参数(默认每页 40 条,第一页 offset 0) 20261011 新增,
    assert.ok(dataCall.sql.includes('r.region = ?'));
    assert.ok(dataCall.params.includes('福东'));
    assert.strictEqual(dataCall.params[dataCall.params.length - 2], 40);
    assert.strictEqual(dataCall.params[dataCall.params.length - 1], 0);
  } finally {
    server.close();
  }
});

// 园区下拉按 idPark 排序:park 表按区域先删后插,插入序即园区设置页拖拽排序的结果,
// 丢了 ORDER BY 就只能依靠 InnoDB 默认返回序,页面拖动后下拉顺序会“这次对、下次不对” 20261011 新增,
test('park/query park: 园区下拉按 idPark 排序返回', async () => {
  const mockPool = createMockPool([
    { label: '宝禄', value: '宝禄', region: '福东' },
    { label: '估安', value: '估安', region: '福西' },
  ]);
  database.setPoolForTesting(mockPool);

  const parkQuery = require('../park/query');
  const { server, base } = startServer(parkQuery, '/api/park-query');
  try {
    const response = await fetch(`${base}/api/park-query/park`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.data.list.length, 2);

    // 无 userId 时 rbac 不发区域名单查询,仅一条园区查询 20261011 新增,
    assert.strictEqual(mockPool.calls.length, 1);
    assert.ok(mockPool.calls[0].sql.includes('gm_data_001.park ORDER BY idPark'));
  } finally {
    server.close();
  }
});

// 园区保存写入侧去重:park 表的 (park, region) 没有唯一索引、写入又是按区域先删后插,
// 重名行会把按园区序排序的查询关联放大成多行;去重只能卡在入库前(页面上的 new Set 拦不住直调接口),
// 且只删重复项、保留首次位置,不能打乱页面拖拽出来的数组序 20261011 新增,
test('park/save insert: 同名园区只插一条且保持原顺序', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const parkSave = require('../park/save');
  const { server, base } = startServer(parkSave, '/api/park-save');
  try {
    const response = await fetch(`${base}/api/park-save/insert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { region: '福东', park: '宝禄' },
        { region: '福东', park: '估安' },
        { region: '福东', park: '宝禄' },
      ]),
    });
    assert.strictEqual(response.status, 200);

    const inserts = mockPool.calls.filter((call) => call.sql.includes('insert into gm_data_001.park'));
    assert.strictEqual(inserts.length, 2, '重名园区应只保留一条');
    assert.deepStrictEqual(
      inserts.map((call) => call.params[0]),
      ['宝禄', '估安'],
    );
    // 删旧只按区域发一次(区域取自首项),不会因去重变成逐条删除 20261011 新增,
    const deletes = mockPool.calls.filter((call) => call.sql.includes('delete from gm_data_001.park'));
    assert.strictEqual(deletes.length, 1);
    assert.deepStrictEqual(deletes[0].params, ['福东']);
  } finally {
    server.close();
  }
});

// 墓区下葬查询两种排序:位置优先(默认)与下葬日期优先,末尾均以 idBuried 兜底保证并列行稳定分页;
// 园区层级按 park 表的 idPark(园区设置页拖拽序)而非中文编码序;日期优先时额外把下葬日期为空的记录排到末尾
// (MySQL 的 ASC 把 NULL 当最小值) 20261011 新增,
test('buriedQuery/list: sortMode 切换园区优先与下葬日期优先排序', async () => {
  const mockPool = createMockPool([{ total: 0 }]);
  database.setPoolForTesting(mockPool);

  const buriedQuery = require('../buriedQuery/query');
  const { server, base } = startServer(buriedQuery, '/api/buriedQuery-query');
  try {
    // 不传 sortMode 走默认(园区/排号/序号/下葬日期),再显式传 date 验证另一分支 20261011 新增,
    const first = await fetch(`${base}/api/buriedQuery-query/list?region=%E7%A6%8F%E4%B8%9C&current=1`);
    const second = await fetch(`${base}/api/buriedQuery-query/list?region=%E7%A6%8F%E4%B8%9C&current=1&sortMode=date`);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);

    const dataCalls = mockPool.calls.filter((call) => call.sql.includes('SELECT b.idBuried'));
    assert.strictEqual(dataCalls.length, 2);
    // 园区层级直接等值关联 park 取 idPark:重名行已在写入侧去重(park/save.js),读侧不再做聚合兜底 20261011 修改,
    assert.ok(dataCalls[0].sql.includes('LEFT JOIN gm_data_001.park pc ON pc.park = r.park'));
    // 销售列新增:按 idRoom 聚合取最大 idSale(最新一笔活动销售)再回连主键,不能直接 LEFT JOIN sale,
    // 因存量数据有一穴多条活动销售,直连会把下葬记录放大成多行 20261011 新增,
    assert.ok(
      dataCalls[0].sql.includes('SELECT idRoom, MAX(idSale) AS idSale'),
    );
    assert.ok(dataCalls[0].sql.includes('GROUP BY idRoom) sl ON sl.idRoom = r.idRoom'));
    assert.ok(dataCalls[0].sql.includes('LEFT JOIN gm_data_001.sale s ON s.idSale = sl.idSale'));
    assert.ok(!dataCalls[0].sql.includes('sale s ON s.idRoom = r.idRoom'));
    // 墓位类型取 room 原值(i18n key),由前端翻译展示,后端不拼词条;规格列已去掉,SELECT 不再取 r.specs 20261011 修改,
    assert.ok(dataCalls[0].sql.includes('r.roomType'));
    assert.ok(!dataCalls[0].sql.includes('r.specs'));
    assert.ok(dataCalls[0].sql.includes('s.createDate AS saleDate'));
    assert.ok(
      dataCalls[0].sql.includes(
        'ORDER BY pc.idPark IS NULL ASC, pc.idPark ASC, r.park ASC, r.yNum ASC, r.xNum ASC, b.burialDate ASC, b.idBuried ASC',
      ),
    );
    assert.ok(
      dataCalls[1].sql.includes(
        'ORDER BY b.burialDate IS NULL ASC, b.burialDate ASC, pc.idPark IS NULL ASC, pc.idPark ASC, r.park ASC, ' +
          'r.yNum ASC, r.xNum ASC, b.idBuried ASC',
      ),
    );
    // 总数语句不参与排序关联:分页总数不因园区子查询而变 20261011 新增,
    const countCalls = mockPool.calls.filter((call) => call.sql.includes('COUNT(*) AS total'));
    assert.ok(!countCalls[0].sql.includes('LEFT JOIN'));
  } finally {
    server.close();
  }
});

// 设备白名单口径统一(审查修复 20261021 P1-1):租户管理员同样 isAccount=1,但不得跨租户登记设备解锁任意登录,
// 因此 requireAdmin 改按 rbac.isPlatformAdmin(额外限定 dataBase=gm_data_000)判定,
test('device/bind: 租户管理员(isAccount=1 但非平台库)无权登记设备', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const device = require('../device');
  const { server, base } = startServer(device.router, '/api/device', { isAccount: 1 });
  try {
    const response = await fetch(`${base}/api/device/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceHash: 'a'.repeat(64), deviceName: 'pc-1' }),
    });
    assert.strictEqual(response.status, 403, '非平台总管库管理员应 403');
    assert.ok(!mockPool.calls.some((call) => call.sql.includes('INSERT INTO gm_data_000.device')), '拒绝时不应写入白名单');
  } finally {
    server.close();
    database.resetPoolForTesting();
  }
});

// requireRegionScope 区域分配豁免:给操作员分配区域(POST /api/operator-save/insert|update)不受调用者
// 自身区域收窄拦截,否则区域管理员无法分配范围外区域;同一越权区域走普通业务路径仍应 403 20261012 新增,
test('rbac.requireRegionScope: 操作员区域分配写操作放行,普通业务同值仍拦截', async () => {
  const mockPool = createMockPool([{ region: '福东' }]);
  database.setPoolForTesting(mockPool);
  const rbac = require('../rbac');

  const makeReq = (path) => ({
    method: 'POST',
    path,
    originalUrl: path,
    body: { region: '福东,福西' },
    query: {},
    // 非平台管理员且已配自身区域(名单=[福东]),才能验证“越权拦截”与“分配豁免”两条分支的区分 20261012 新增,
    data: { userId: 1001, dataBase: 'gm_data_001', isAccount: 0, userName: 'tester' },
  });
  const makeRes = () => {
    const res = { code: 0, status(c) { res.code = c; return res; }, json() { return res; } };
    return res;
  };

  // 1) 分配路径:越过收窄,应调 next 且不 403
  let called = false;
  const passRes = makeRes();
  await rbac.requireRegionScope(makeReq('/api/operator-save/update'), passRes, () => { called = true; });
  assert.ok(called, 'operator-save/update 应放行');
  assert.strictEqual(passRes.code, 0, 'operator-save/update 不应被 403');

  // 2) 普通业务路径携带范围外区域:仍应 403 且不调 next
  called = false;
  const denyRes = makeRes();
  await rbac.requireRegionScope(makeReq('/api/sale-save/update'), denyRes, () => { called = true; });
  assert.ok(!called, '普通业务越权区域不应放行');
  assert.strictEqual(denyRes.code, 403, '普通业务越权区域应 403');

  database.resetPoolForTesting();
});
