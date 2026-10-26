// 业务事务联动集成测试:mock 连接池注入,断言墓位业务各形态的 SQL 语句序列与冗余字段同步 20260917 新增,
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

// 守卫缓存(菜单权限命中/区域名单)与分页总数缓存为进程级 TTL,用例间必须主动作废,
// 否则同一 userId 在上一条用例里缓存的结果会串到下一条,使 mock 改行集不再生效 20261021 新增,
// 总数缓存同理:多条用例都用 gm_data_001 且条件相近,不作废会让第二条用例直接命中上一条的总数, 20261021 二轮 P2-14 补充,
test.beforeEach(() => {
  require('../rbac').invalidateAuthCaches();
  require('../lib/countCache').resetForTesting();
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

    // 合并为多值 INSERT(审查修复 20261021 二轮 P1-9):3 个待建坐标只应发 1 条语句,而不是 3 次网络往返,
    const inserts = mockPool.calls.filter((call) => call.sql.includes('insert into gm_data_001.room'));
    assert.strictEqual(inserts.length, 1, '批量建位应合并为一条多值 INSERT');
    assert.strictEqual((inserts[0].sql.match(/\),\s*\(/g) || []).length, 2, '三个值元组之间应有两个逗号分隔');
    // 从列名清单定位 yNum/xNum 列位,按“列数 × 行序号”分段取参数,核对实建的就是剩下三个坐标 20261021 新增 20261021 改多值口径,
    const cols = inserts[0].sql
      .slice(inserts[0].sql.indexOf('(') + 1, inserts[0].sql.indexOf(')'))
      .split(',')
      .map((item) => item.trim());
    const coordKeys = [];
    for (let offset = 0; offset < inserts[0].params.length; offset += cols.length) {
      coordKeys.push(`${inserts[0].params[offset + cols.indexOf('yNum')]}:${inserts[0].params[offset + cols.indexOf('xNum')]}`);
    }
    assert.strictEqual(inserts[0].params.length, cols.length * 3, '参数个数应为列数 × 行数');
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

// 范围修改上限(审查修复 20261021 二轮 P1-10):modify=2 时排×号的乘积同样由前端任意给定,
// 原写法这条 UPDATE 不做任何限制,一排/号从 1 填到 99999 就是一条锁住整片墓位的长事务,
// 超限时必须 400 且不发出任何语句(而不是先改再报错),
test('room/save update: 范围修改超过上限时 400 且不发任何语句', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const roomSave = require('../room/save');
  const { server, base } = startServer(roomSave, '/api/room-save');
  try {
    const response = await fetch(`${base}/api/room-save/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modify: '2', region: '福东', park: '一园', yNum: 1, yNumTo: 50, xNum: 1, xNumTo: 50 }),
    });
    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.ok(/上限/.test(body.error), `应答应说明超限原因,实际: ${body.error}`);
    assert.strictEqual(mockPool.calls.length, 0, '超限时不应发出任何语句');
  } finally {
    server.close();
    database.resetPoolForTesting();
  }
});

// 上限内的范围修改仍照常执行(防止把守卫改成“一刷子全拦”),
test('room/save update: 上限内的范围修改发出单条条件 UPDATE', async () => {
  const calls = [];
  database.setPoolForTesting({
    async query(sql, params) {
      calls.push({ sql, params });
      // 写操作按 OkPacket 形状回包(范围内 2×2=4 个墓位全部更新),
      return [{ affectedRows: 4 }];
    },
  });

  const roomSave = require('../room/save');
  const { server, base } = startServer(roomSave, '/api/room-save');
  try {
    const response = await fetch(`${base}/api/room-save/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modify: '2', region: '福东', park: '一园', yNum: 1, yNumTo: 2, xNum: 1, xNumTo: 2, remark: '统一备注' }),
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(calls.length, 1, '范围修改应是一条语句而非逐行更新');
    assert.ok(calls[0].sql.startsWith('update gm_data_001.room set'));
    assert.ok(calls[0].sql.includes('xNum >= ? and xNum <= ? and yNum >= ? and yNum <= ? and region = ? and park = ?'));
    assert.ok(!calls[0].sql.includes('xyNumber'), '多条修改不得覆写统一编号');
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

// 原 /api/sale-delete(墓区销售登记页的作废)已于三轮下线,销售作废的唯一入口改为墓位业务的取消销售;
// 用例因此改钉现役链路,且取消销售的口径比旧接口更宽:把该墓位 6 张业务表的活动记录一并软删,
// 只留一条“墓位整体回置”的断言而不再是“仅删 sale + 按付款人删联系人”,
test('gravePlotBusiness/cancelSale: 作废销售逐表软删业务记录 + 墓位整体回置清空,同一事务', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const cancelSale = require('../gravePlotBusiness/cancelSale');
  const { server, base } = startServer(cancelSale, '/api/gravePlotBusiness-cancelSale');
  try {
    const response = await fetch(`${base}/api/gravePlotBusiness-cancelSale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idRoom: 1000001 }),
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.code, 0);

    const calls = mockPool.calls;
    const sqls = calls.map((call) => call.sql);
    // 1. 六张业务表按 idRoom 软删活动记录:少删一张就会留下“销售已作废但下葬/收款仍在”的脏数据,
    ['sale', 'buried', 'contacts', 'adminfee', 'burial_cert', 'period_change'].forEach((table) => {
      assert.ok(
        sqls.some((sql) => sql.includes(`gm_data_001.${table} set`) && sql.includes('idRoom = ? AND isDeleted = 0')),
        `取消销售未软删 ${table} 表的活动记录`,
      );
    });
    // 2. 墓位回置未销售/未完成,并清空编号/购墓人/安葬者/联系人/备注与管理费起止日期,
    const roomUpdate = calls.find((call) => call.sql.includes('gm_data_001.room set'));
    assert.ok(roomUpdate, '取消销售未回置墓位');
    assert.ok(roomUpdate.params.includes('statusType.saleStatusEnum.unsold'));
    assert.ok(roomUpdate.params.includes('statusType.intoStatusEnum.incomplet'));
    ['serialNo', 'buyer', 'deceased', 'contacts', 'remark', 'startDate', 'endDate'].forEach((column) => {
      assert.ok(roomUpdate.sql.includes(`${column} = ?`), `墓位回置未清空 ${column} 列`);
    });
  } finally {
    server.close();
  }
});

// 销售删除(原取消销售)的权限动作已统一为 sale.delete 并只挂在取消销售接口;
// 通用删除接口遇到 type=sale 必须 400 且不发任何写库语句,避免持该动作的调用者走默认分支误删业务记录 20261023 新增,
test('gravePlotBusiness/delete: type=sale 拒绝走通用删除,且不发出写库语句', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const gravePlotBusinessDelete = require('../gravePlotBusiness/delete');
  const { server, base } = startServer(gravePlotBusinessDelete, '/api/gravePlotBusiness-delete');
  try {
    const response = await fetch(`${base}/api/gravePlotBusiness-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idRoom: 1000001, type: 'sale' }),
    });
    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /取消销售接口/);
    assert.strictEqual(mockPool.calls.length, 0, '拒绝 type=sale 时不得发出任何写库语句');
  } finally {
    server.close();
  }
});

test('gravePlotBusiness/save insert(buried): 下葬 + 锚定日期 + 墓位置已下葬 + deceased聚合 + 联系人新增 + contacts聚合,同一事务', async () => {
  // 原 /api/buried-save(墓区下葬登记页)已于三轮下线,单条下葬记录的写唯一入口是墓位业务的下葬形态;
  // 联系人匹配查询返回空 → 走"名/电话均不存在则新增"分支,
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const gravePlotBusinessSave = require('../gravePlotBusiness/save');
  const { server, base } = startServer(gravePlotBusinessSave, '/api/gravePlotBusiness-save');
  try {
    const response = await fetch(`${base}/api/gravePlotBusiness-save/insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'buried',
        idRoom: '1000001',
        burialDate: '2026-09-17',
        deathDate: '2026-09-15',
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
    // 1. 锚定日先查最早下葬日(与本次下葬日取小),联系人匹配读在事务内随后在列
    assert.ok(sqls.some((sql) => sql.includes('select min(burialDate)')));
    assert.ok(sqls.some((sql) => sql.includes('gm_data_001.contacts') && sql.includes('idRoom = ?')));
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

// 存量口令升级必须拿“本次提交的明文”重哈希:旧写法拿库中存值去哈希,对 bcrypt 存量相当于把哈希当明文再哈希,
// 一次登录就把用户口令彻底弄坏(审查修复 20261021 二轮 P1-6),
test('login: 存量 bcrypt 口令登录成功后升级为 scrypt(基于提交的明文重哈希)', async () => {
  const bcrypt = require('bcryptjs');
  const legacy = bcrypt.hashSync('pass-123', 4);
  const mockPool = createMockPool({
    routes: [
      [
        'FROM gm_data_000.operator a,gm_data_000.account b',
        [
          {
            userid: 1001,
            username: '张三',
            phone: '13800138011',
            dataBaseName: 'gm_data_001',
            accountName: '某陵园',
            isAccount: 1,
            password: legacy,
            termYears: '',
          },
        ],
      ],
    ],
  });
  database.setPoolForTesting(mockPool);

  const login = require('../login');
  const { server, base } = startServer(login, '/api/login');
  try {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '13800138011', password: 'pass-123' }),
    });
    assert.strictEqual(response.status, 200, '存量 bcrypt 口令应能正常登录');

    // 升级走 fire-and-forget(失败不阻断本次登录),给它一个等待窗口落库,
    let upgrade = null;
    for (let i = 0; i < 100 && !upgrade; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      upgrade = mockPool.calls.find((call) => call.sql.includes('UPDATE gm_data_000.operator SET password')) || null;
    }
    assert.ok(upgrade, '校验通过后应把存量口令升级为 scrypt 存储');
    assert.ok(String(upgrade.params[0]).startsWith('scrypt$'), '升级后的存储形式应为 scrypt');
    assert.strictEqual(await require('../public').verifyPassword('pass-123', upgrade.params[0]), true, '升级必须基于本次提交的明文');
    assert.strictEqual(upgrade.params[1], 1001, '按 userid 定位待升级的行');
  } finally {
    server.close();
  }
});

// 墓位业务页「预定期」入口承接原独立预定页的新建口径(旧 /api/reserve-save 已于 20261023 下线),
// 预定记录 + 墓位置为已预定(销售状态不动) + 限期副本同步仍在同一事务,
test('gravePlotBusiness/save insert(reserve): 新建预定记录 + 墓位置为已预定(销售状态不动) + 限期副本同步,同一事务', async () => {
  const mockPool = createMockPool([]);
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
        payer: '王五',
        payerPhone: '13900139000',
        // 预定限期为必填(20261011 新增),缺失会被 400 拦下
        reservationExpireDate: '2026-12-31',
        // 以下为前端统一业务模型的其余键:预定形态必须全部剔除,否则 INSERT 会包含 reserve 表没有的列(20261026 新增),
        realPrice: '1,200.00',
        realPriceString: '1,200.00',
        payerIDCard: '330100199001011234',
        payee: '李四',
        serialNo: 'A001',
        remark: '备注',
        deceased: '张三',
        deathDate: '2026-01-01',
        burialDate: '2026-01-02',
        deceasedIDCard: '330100199001015678',
        deceasedRelation: '配偶',
        contacts: '赵六',
        contactsphone: '13900139001',
        contactsIDCard: '330100199001019999',
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
    // INSERT 列清单只能是 reserve 表真实列:安葬者/联系人/金额这类跨表列必须已剔除,
    // 否则真实 MySQL 报 Unknown column,前端只能看到 Internal server error(mock 不校验列名,故在此反向断言)20261026 新增,
    ['deathDate', 'burialDate', 'deceased', 'contacts', 'contactsphone', 'contactsIDCard', 'realPrice', 'serialNo', 'payee', 'payerIDCard'].forEach((column) => {
      assert.ok(!reserveInsert.sql.includes(column), `预定 INSERT 不得包含 reserve 表没有的列 ${column}`);
    });
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

// 一穴一条预定记录:同一墓位反复预定(含取消后重新预定)不得累积多条,否则预定人/限期取值全靠运气 20261011 新增;
// 旧 /api/reserve-save 已下线,本用例改为验证墓位业务页入口复用的同一辅助函数 20261023 调整,
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
        reservationExpireDate: '2026-12-31',
        remark: '业务页预定',
      }),
    });
    assert.strictEqual(response.status, 200);

    const calls = mockPool.calls;
    const sqls = calls.map((call) => call.sql);
    assert.ok(!sqls.some((sql) => sql.includes('insert into gm_data_001.reserve')));
    // 1. 复用原行按 idReserve 更新,限期写入且 isDeleted 回置 0;idRoom 不进 SET 子句 20261011 新增,
    const reserveUpdate = calls.find(
      (call) => call.sql.includes('gm_data_001.reserve set') && call.sql.includes('where idReserve = ?'),
    );
    assert.ok(reserveUpdate);
    assert.ok(!reserveUpdate.sql.split(' where ')[0].includes('idRoom ='));
    assert.ok(reserveUpdate.params.includes(2000012));
    assert.ok(reserveUpdate.params.includes('2026-12-31'));
    assert.ok(reserveUpdate.params.includes(0));
    // 2. 联系人/电话按 liaison/liaisonPhone 列名回落 20261011 新增,
    assert.ok(reserveUpdate.params.includes('张预定'));
    // 3. 同穴其余活动记录软删收敛 20261011 新增,
    assert.ok(
      sqls.some((sql) => sql.includes('gm_data_001.reserve set isDeleted = 1 where idRoom = ? and idReserve <> ? and isDeleted = 0')),
    );
    // 4. 墓位置为已预定与限期副本同步仍在同一事务内跟着走 20261011 新增,
    assert.ok(sqls.some((sql) => sql.includes('gm_data_001.room set')));
    assert.ok(sqls.some((sql) => sql.includes('set r.reservationExpireDate')));
  } finally {
    server.close();
  }
});

// 预定限期必填拦截:空值会被 normalizeBodyDates 转成 null,直接落库会报错或写入零值日期 20261011 新增;
// 旧 /api/reserve-save 下线后同一口径由墓位业务页承接 20261023 调整,
test('gravePlotBusiness/save insert(reserve): 缺 reservationExpireDate 时 400 且不发出任何写入语句', async () => {
  const mockPool = createMockPool([]);
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
        payer: '王五',
        payerPhone: '13900139000',
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

// 修改预定时调用方漏传 idRoom,限期副本仍得跟着改(旧写法依赖 idRoom,漏传就静默不同步) 20261011 新增;
// 旧 /api/reserve-save 下线后同一口径由墓位业务页承接 20261023 调整,
test('gravePlotBusiness/save update(reserve): 不带 idRoom 时仍按 idReserve 反查墓位同步限期副本', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const businessSave = require('../gravePlotBusiness/save');
  const { server, base } = startServer(businessSave, '/api/gravePlotBusiness-save');
  try {
    const response = await fetch(`${base}/api/gravePlotBusiness-save/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idBusiness: '2000001',
        type: 'reserve',
        payer: '王五',
        payerPhone: '13900139000',
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

// 墓区业务页预定修改与旧预定登记页同一口径:改期必同步墓位副本 20261011 新增;
// 旧 /api/reserve-save 已下线,本用例成为唯一的修改口径断言 20261023 调整,
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
    // 1. 预定记录按 idReserve 更新,限期入 SET 子句,而 idRoom 仅作同步靶子不得回落为更新列 20261011 新增,
    const reserveUpdate = calls.find(
      (call) => call.sql.includes('gm_data_001.reserve set') && call.sql.includes('where idReserve = ?'),
    );
    assert.ok(reserveUpdate);
    assert.ok(reserveUpdate.sql.includes('reservationExpireDate = ?'));
    assert.ok(!reserveUpdate.sql.includes('idRoom = ?'));
    assert.ok(reserveUpdate.params.includes('2027-06-30'));
    // 2. 限期副本同步语句排在预定更新之后(同事务内才能读到新值) 20261011 新增,
    const syncIndex = sqls.findIndex((sql) => sql.includes('set r.reservationExpireDate'));
    assert.ok(syncIndex > -1);
    assert.ok(syncIndex > sqls.indexOf(reserveUpdate.sql));
    assert.ok(sqls[syncIndex].includes('gm_data_001.reserve'));
    // 3. 按 idReserve 反查所属墓位,不拿调用方的 idRoom 当条件 20261011 新增,
    assert.ok(sqls[syncIndex].includes('res2.idReserve = 2000015'));
  } finally {
    server.close();
  }
});

// 取消预定后墓位限期必须清空:否则墓位仍显示一个已失效的到期日 20261011 新增;
// 旧 /api/reserve-delete 下线后由墓位业务删除接口的 type=reserve 分支承接 20261023 调整,
test('gravePlotBusiness/delete type=reserve: 软删预定 + 墓位只回置未预定(销售状态不动) + 限期副本清空,同一事务', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const businessDelete = require('../gravePlotBusiness/delete');
  const { server, base } = startServer(businessDelete, '/api/gravePlotBusiness-delete');
  try {
    const response = await fetch(`${base}/api/gravePlotBusiness-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idRoom: 1000001, type: 'reserve' }),
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

// 安葬证设置只有一个“确认提交”，权限页已去掉 certificate.create：首次保存（idCert=0）也走 update 入口，
// 后端在该分支回落到插入 burial_cert，使仅具 certificate.modify 的账号不被 create 守卫 403 20261023 新增,
test('gravePlotBusiness/save update(certificate): idBusiness=0 首次保存回落到插入 burial_cert', async () => {
  const mockPool = createMockPool([]);
  database.setPoolForTesting(mockPool);

  const businessSave = require('../gravePlotBusiness/save');
  const { server, base } = startServer(businessSave, '/api/gravePlotBusiness-save');
  try {
    const response = await fetch(`${base}/api/gravePlotBusiness-save/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idBusiness: 0,
        idRoom: 1000001,
        type: 'certificate',
        certHolder: '李持证',
        certHolderPhone: '13800138000',
        deceasedA: '安葬者',
      }),
    });
    assert.strictEqual(response.status, 200);

    const calls = mockPool.calls;
    const insertCall = calls.find((call) => call.sql.includes('insert into gm_data_001.burial_cert'));
    assert.ok(insertCall, '首次保存应回落到插入 burial_cert');
    assert.ok(!calls.some((call) => call.sql.includes('burial_cert set')), '首次保存不应发 UPDATE');
    assert.ok(insertCall.params.includes('李持证'));
    assert.ok(insertCall.params.includes(1000001), '插入需保留 idRoom');
    assert.ok(!insertCall.sql.includes('idBusiness'), 'idBusiness 不得作为列写入');
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

// 总数短 TTL 复用(审查修复 20261021 二轮 P2-14):同一筛选条件下翻到第二页时总数根本不会变,
// 而这条 COUNT(*) 在大表上是整片扫描;现只重跑本页取数那一条语句,并且两条语句并发发出而不是串行等待, 20261021 新增,
test('roomQuery/list: 同一筛选条件翻页复用总数,不再重跑 COUNT', async () => {
  const mockPool = createMockPool({ routes: [['COUNT(*) AS total', [{ total: 7 }]], ['FROM gm_data_001.room r WHERE', []]] });
  database.setPoolForTesting(mockPool);

  const roomQuery = require('../roomQuery/query');
  const { server, base } = startServer(roomQuery, '/api/room-query');
  try {
    await fetch(`${base}/api/room-query/list?region=%E7%A6%8F%E4%B8%9C&current=1&pageSize=20`);
    assert.strictEqual(mockPool.calls.filter((call) => call.sql.includes('COUNT(*) AS total')).length, 1, '第一页应查一次总数');
    const callsAfterFirstPage = mockPool.calls.length;
    assert.strictEqual(callsAfterFirstPage, 2, '第一页共两条语句(count + 取页)');

    const second = await fetch(`${base}/api/room-query/list?region=%E7%A6%8F%E4%B8%9C&current=2&pageSize=20`);
    assert.strictEqual(second.status, 200);
    const body = await second.json();
    assert.strictEqual(body.data.total, 7, '第二页总数应来自缓存且数值与首屏一致');
    assert.strictEqual(mockPool.calls.filter((call) => call.sql.includes('COUNT(*) AS total')).length, 1, '翻页不应重跑 COUNT');
    assert.strictEqual(mockPool.calls.length, callsAfterFirstPage + 1, '第二页只多发一条取数语句');
    const secondDataCall = mockPool.calls[mockPool.calls.length - 1];
    assert.strictEqual(secondDataCall.params[secondDataCall.params.length - 1], 20, '第二页 offset 应为 (current-1)*pageSize');

    // 换了筛选条件就是另一个总数,必须回源重算,不能把上一个筛选条件的总数直接给用户, 20261021 新增,
    await fetch(`${base}/api/room-query/list?region=%E7%A6%8F%E8%A5%BF&current=1&pageSize=20`);
    assert.strictEqual(mockPool.calls.filter((call) => call.sql.includes('COUNT(*) AS total')).length, 2, '筛选条件变化应重新回源');
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

// 设备白名单口径(20261026 按用户要求调整):登记本机是日常运维动作,白名单又是全局共用的一批指定电脑,
// 园区管理员(isAccount=1 但 dataBase 不是 gm_data_000)也必须能登记——原 20261021 的“仅平台管理员”口径
// 会让园区管理员点“登记本机”恒 403;普通操作员(isAccount=0)仍必须被拒,
test('device/bind: 任一管理员账号可登记设备，普通操作员仍 403', async () => {
  const device = require('../device');

  // 园区管理员:登录库是自己的租户库,不是平台总管库
  const adminPool = createMockPool([]);
  database.setPoolForTesting(adminPool);
  const admin = startServer(device.router, '/api/device', { isAccount: 1, dataBase: 'gm_data_002' });
  try {
    const response = await fetch(`${admin.base}/api/device/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceHash: 'a'.repeat(64), deviceName: 'pc-1' }),
    });
    assert.strictEqual(response.status, 200, '园区管理员应可登记本机');
    const insert = adminPool.calls.find((call) => call.sql.includes('INSERT INTO gm_data_000.device'));
    assert.ok(insert, '登记成功时应写入白名单');
    assert.deepStrictEqual(insert.params, ['a'.repeat(64), 'pc-1']);
  } finally {
    admin.server.close();
  }

  // 普通操作员:登记是管理动作,不得写入全局白名单
  const operatorPool = createMockPool([]);
  database.setPoolForTesting(operatorPool);
  const operator = startServer(device.router, '/api/device', { isAccount: 0, dataBase: 'gm_data_002' });
  try {
    const response = await fetch(`${operator.base}/api/device/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceHash: 'b'.repeat(64), deviceName: 'pc-2' }),
    });
    assert.strictEqual(response.status, 403, '普通操作员不得登记设备');
    assert.ok(
      !operatorPool.calls.some((call) => call.sql.includes('INSERT INTO gm_data_000.device')),
      '拒绝时不应写入白名单',
    );
  } finally {
    operator.server.close();
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

// ==================== 详情聚合放行矩阵(审查修复 20261021 二轮 P1-3) ====================
// 取注册表里真实的守卫条目与真实路由挂载单个前缀(不在测试里重抄一遍“先归属后菜单”的组装顺序),
// 只把权限查询的返回行改成“按本次提交的菜单名是否已授权”判定,以此构造“只开通下葬菜单”这类
// 现实中大量存在的部分授权账号:迁出前缀的详情路径此前未登记宽松口径,这类账号点详情整体打不开,
function startRegistryApp(entryPath, options = {}) {
  const routeRegistry = require('../routeRegistry');
  const { authorizedMenus = [], operatorRegions, businessRows = [{ idRoom: 1 }] } = options;
  const entry = routeRegistry.ROUTES.find((item) => item.path === entryPath);
  assert.ok(entry, `路由注册表缺少 ${entryPath} 条目`);
  const calls = [];
  // mock 池的 query 必须返回 mysql2 风格的 [行数组] 元组,故命中行集均先存成数组再套一层返回, 20261021 新增,
  const hitRows = [{ 1: 1 }];
  database.setPoolForTesting({
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const text = String(sql);
      if (text.includes('operator_power')) {
        // 参数顺序为 [userId, ...菜单名]:命中与否取决于本次守卫提交的菜单集合里有没有已授权菜单,
        const menuNames = (params || []).slice(1).map(String);
        return [menuNames.some((name) => authorizedMenus.includes(name)) ? hitRows : []];
      }
      if (text.includes('gm_data_000.menu')) {
        // 菜单存在性检查恒命中:使 403 文案稳定落在“缺少该菜单操作权限”,便于断言拒绝原因,
        return [hitRows];
      }
      return [businessRows];
    },
  });
  const app = express();
  app.use((req, res, next) => {
    req.data = { dataBase: 'gm_data_001', userName: 'tester', phone: '13800138000', userId: 2300, isAccount: 0 };
    // 区域名单真实链路上由 requireRegionScope 注入,此处直接给定,单独验证“详情放行不放宽区域归属”,
    if (Array.isArray(operatorRegions)) {
      req.operatorRegions = operatorRegions;
    }
    next();
  });
  for (const guard of entry.guards || []) {
    const middlewares = routeRegistry.buildGuardMiddlewares(guard);
    if (middlewares.length > 0) {
      app.use(routeRegistry.buildMountPath(entry.path, guard.at), ...middlewares);
    }
  }
  app.use(entry.path, entry.router);
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}`, calls };
}

// 详情页菜单全集里已不再包含下线的 sale/buried/contacts,本组用例改用存活的查询页菜单作为“仅具单一详情页菜单”身份,
test('P1-3 详情聚合: 仅具下葬查询菜单的操作员可按墓位取迁出记录,同前缀列表路径仍严格校验', async () => {
  const { server, base, calls } = startRegistryApp('/api/transferOut-query', { authorizedMenus: ['buriedQuery'] });
  try {
    const detail = await fetch(`${base}/api/transferOut-query/?idRoom=1`);
    assert.strictEqual(detail.status, 200, '详情第 7 路(迁出)应被“任一详情页菜单”放行');
    const detailBody = await detail.json();
    assert.ok(Array.isArray(detailBody.data.list), '应返回该墓位的迁出记录列表');
    const powerSqls = () => calls.filter((call) => String(call.sql).includes('operator_power'));
    assert.strictEqual(powerSqls().length, 1, '详情放行只需一次权限查询');
    assert.ok(powerSqls()[0].params.slice(1).includes('transferOutQuery'), '详情口径应带上详情页菜单全集');

    // 宽松口径只覆盖白名单里的详情取数路径:同一前缀的迁出列表仍要求迁出业务页/迁出查询页菜单,
    const callsBeforeList = calls.length;
    const list = await fetch(`${base}/api/transferOut-query/list?current=1&pageSize=20`);
    assert.strictEqual(list.status, 403, '非详情路径不应被升级成宽松口径');
    const listBody = await list.json();
    assert.ok(listBody.error.includes('缺少该菜单操作权限'), `拒绝原因应为缺菜单权限:${listBody.error}`);
    const lastPower = powerSqls()[powerSqls().length - 1];
    assert.deepStrictEqual(lastPower.params.slice(1), ['transferOut', 'transferOutQuery'], '列表应按本前缀自身菜单判定');
    // 只看过列表请求新增的那几条语句:详情请求已先发过一次 transfer_out 取数,不能算到拦截头上, 20261021 新增,
    assert.ok(
      !calls.slice(callsBeforeList).some((call) => String(call.sql).includes('gm_data_001.transfer_out')),
      '被守卫拦下后不应再发业务取数',
    );
  } finally {
    server.close();
  }
});

test('P1-3 详情聚合: 白名单外的路径形状回到严格口径,白名单内的真实路径照常放行', async () => {
  // 旧判定按“路径等于 /idList”猜测,凡是挂了 queryDetail 的前缀碰到该形状都走宽松口径,
  // 而 /idList 只在 room-query 上存在(本前缀根本没这条路由),现按登记项逐条精确匹配,
  const { server, base, calls } = startRegistryApp('/api/sale-query', { authorizedMenus: ['buriedQuery'] });
  try {
    const spoof = await fetch(`${base}/api/sale-query/idList?idRoom=1`);
    assert.strictEqual(spoof.status, 403, '未登记的形状不应被当成详情路径');
    const power = calls.find((call) => String(call.sql).includes('operator_power'));
    // 销售登记页已下线,本前缀的非详情路径改按存活的「墓区销售查询」菜单严格判定,
    assert.deepStrictEqual(power.params.slice(1), ['saleQuery'], '应只按本前缀登记的单菜单严格判定');

    // 白名单内的真实详情路径必须仍然放行,否则收窄就把自家详情页一并关掉了,
    const okDetail = await fetch(`${base}/api/sale-query/get-by-room?idRoom=1`);
    assert.strictEqual(okDetail.status, 200, '已登记的详情路径不应被收窄误伤');
  } finally {
    server.close();
  }
});

test('P1-3 详情聚合: 缺 idRoom、非数值 idRoom 与非 GET 请求都不升级宽松口径', async () => {
  // 只授权管理费查询菜单(在详情页全集内但不是下葬前缀的本菜单):下葬前缀的严格口径必然 403,据此反证本次请求是否走了详情宽松口径,
  const { server, base, calls } = startRegistryApp('/api/buried-query', { authorizedMenus: ['adminfeeQuery'] });
  try {
    assert.strictEqual((await fetch(`${base}/api/buried-query/`)).status, 403, '不带 idRoom 就不是详情取数,不该借详情口径');
    assert.strictEqual((await fetch(`${base}/api/buried-query/?idRoom=abc`)).status, 403, 'idRoom 非数值时不该放大权限口径');
    const post = await fetch(`${base}/api/buried-query/?idRoom=1`, { method: 'POST' });
    assert.strictEqual(post.status, 403, '详情放行只针对 GET 取数,写请求一律严格');

    // 真正的详情取数仍放行(正向对照:证明上面三条 403 不是把详情路径整体堵死),
    assert.strictEqual((await fetch(`${base}/api/buried-query/?idRoom=1`)).status, 200);

    const powerCalls = calls.filter((call) => String(call.sql).includes('operator_power')).map((call) => call.params.slice(1));
    assert.strictEqual(powerCalls.length, 2, '严格口径命中缓存只打一次,详情口径另打一次');
    assert.ok(powerCalls.some((names) => names.length === 1 && names[0] === 'buriedQuery'), '拦截请求应按单菜单 buriedQuery 判定');
    assert.ok(powerCalls.some((names) => names.length > 10), '放行请求应按详情页菜单全集判定');
  } finally {
    server.close();
  }
});

test('P1-3 详情聚合: 宽松口径只放宽菜单层,限定区域操作员读它区墓位迁出记录仍被归属守卫拦下', async () => {
  // 本前缀的裸 / 此前既没登记详情放行也没有区域归属校验:限定区域的操作员可借详情接口读它区迁出记录,
  const denied = startRegistryApp('/api/transferOut-query', {
    authorizedMenus: ['buriedQuery'],
    operatorRegions: ['福西'],
    businessRows: [{ region: '福东', idTransfer: 9 }],
  });
  try {
    const response = await fetch(`${denied.base}/api/transferOut-query/?idRoom=1`);
    assert.strictEqual(response.status, 403, '跨区域的详情取数应被归属守卫拦下');
    const body = await response.json();
    assert.ok(body.error.includes('不属于当前区域'), `拒绝原因应为区域归属:${body.error}`);
    assert.ok(!denied.calls.some((call) => String(call.sql).includes('operator_power')), '归属守卫应排在菜单守卫之前');
    assert.ok(!denied.calls.some((call) => String(call.sql).includes('gm_data_001.transfer_out')), '拦下后不应再发业务取数');
  } finally {
    denied.server.close();
  }

  const allowed = startRegistryApp('/api/transferOut-query', {
    authorizedMenus: ['buriedQuery'],
    operatorRegions: ['福东'],
    businessRows: [{ region: '福东', idTransfer: 9 }],
  });
  try {
    const ok = await fetch(`${allowed.base}/api/transferOut-query/?idRoom=1`);
    assert.strictEqual(ok.status, 200, '同区域墓位的详情取数应正常放行');
  } finally {
    allowed.server.close();
  }
});
