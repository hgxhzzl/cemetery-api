// public.js 纯函数基础单测:SQL 构建、日期归一化、密码哈希/校验 20260915 新增,
const test = require('node:test');
const assert = require('node:assert');
const public = require('../public');

test('parseNumericParam: 纯数字返回字符串,非法输入返回 null', () => {
  assert.strictEqual(public.parseNumericParam('100'), '100');
  assert.strictEqual(public.parseNumericParam(100), '100');
  assert.strictEqual(public.parseNumericParam(' 100 '), '100');
  assert.strictEqual(public.parseNumericParam(''), null);
  assert.strictEqual(public.parseNumericParam('abc'), null);
  assert.strictEqual(public.parseNumericParam('1e3'), null);
  assert.strictEqual(public.parseNumericParam(undefined), null);
});

test('normalizeBodyDates: 空串转null、ISO转本地格式、非日期字段不动', () => {
  const body = {
    joinDate: '',
    createDate: '2024-02-17T16:09:17.000Z',
    name: '',
    idRoom: 1,
  };
  public.normalizeBodyDates(body);
  assert.strictEqual(body.joinDate, null);
  assert.match(body.createDate, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.strictEqual(body.name, '');
  assert.strictEqual(body.idRoom, 1);
});

test('getCurrentDateTime: 返回 YYYY-MM-DD HH:mm:ss 格式', () => {
  assert.match(public.getCurrentDateTime(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('getUpdateByIdStatement: 生成参数化 SET 与 WHERE', () => {
  const json = { table: 'gm_data_000.room', idfield: 'idRoom', idvalue: '1', price: 6666, operator: 'admin' };
  const statement = public.getUpdateByIdStatement(json);
  assert.match(statement.sql, /^update gm_data_000\.room set /);
  assert.match(statement.sql, /where idRoom = \$\d+$/);
  assert.ok(!statement.sql.includes('idfield'));
  assert.ok(!statement.sql.includes('idvalue'));
  // params = SET字段值(price/operator/modifyDate) + 末尾 idvalue
  assert.strictEqual(statement.params.length, 4);
  assert.strictEqual(statement.params[3], '1');
  assert.ok(statement.params.includes(6666));
});

test('getUpdateByConditionStatement: 条件参数化拼接,值不内联进SQL', () => {
  const json = {
    table: 'gm_data_000.sale',
    condition: { sql: 'idRoom = ? AND isDeleted = 0', params: ['1000001'] },
    isDeleted: 1,
    operator: 'admin',
  };
  const statement = public.getSoftDeleteByConditionStatement(json);
  assert.match(statement.sql, /where idRoom = \? AND isDeleted = 0$/);
  assert.ok(!statement.sql.includes("'1000001'"));
  // params = SET字段值(isDeleted/operator/modifyDate) + 条件参数
  assert.strictEqual(statement.params.length, 4);
  assert.strictEqual(statement.params[3], '1000001');
});

test('hashPassword/verifyPassword/isScryptHash: scrypt 哈希与存量形式兼容校验', async () => {
  // 口径改造(审查修复 20261021 二轮 P1-6):新哈希为 scrypt,bcrypt 与明文仅作存量登录兼容,
  const hashed = await public.hashPassword('1234');
  assert.strictEqual(public.isScryptHash(hashed), true);
  assert.strictEqual(public.isBcryptHash(hashed), false, '新哈希不应再是 bcrypt 形式');
  assert.strictEqual(public.looksHashed(hashed), true);
  assert.strictEqual(public.looksHashed('1234'), false);
  assert.strictEqual(public.needsPasswordUpgrade(hashed), false, 'scrypt 形式无需再升级');
  // 长度守卫:operator/account.password 列是 varchar(100),超出会被静默截断导致登录永久失败,
  assert.ok(hashed.length <= 100, `哈希串不得超 100 字,实际 ${hashed.length}`);
  assert.strictEqual(await public.verifyPassword('1234', hashed), true);
  assert.strictEqual(await public.verifyPassword('wrong', hashed), false);
  // 脏格式(段数不足)判不匹配而非抛错,
  assert.strictEqual(await public.verifyPassword('1234', 'scrypt$32768$8$1$abc'), false);
  // 存量明文兼容:明文比对仍可用
  assert.strictEqual(await public.verifyPassword('1234', '1234'), true);
  assert.strictEqual(await public.verifyPassword('1234', '5678'), false);
});

test('verifyPassword: 存量 bcrypt 哈希仍可登录且被判定为需升级', async () => {
  // cost 取 4 仅为本用例跑得快,与线上的 cost=10 同为 $2 前缀格式,
  const legacy = require('bcryptjs').hashSync('1234', 4);
  assert.strictEqual(public.isBcryptHash(legacy), true);
  assert.strictEqual(public.looksHashed(legacy), true, 'bcrypt 存量不得被当成明文再哈希');
  assert.strictEqual(public.needsPasswordUpgrade(legacy), true, 'bcrypt 存量应在登录成功后升级');
  assert.strictEqual(await public.verifyPassword('1234', legacy), true);
  assert.strictEqual(await public.verifyPassword('wrong', legacy), false);
  // 明文存量同理需升级(升级判定只看“是不是 scrypt”),
  assert.strictEqual(public.looksHashed('1234'), false);
  assert.strictEqual(public.needsPasswordUpgrade('1234'), true);
});

test('getMultiRowInsertStatements: 多行合并为多条多值 INSERT 并对齐占位符', () => {
  const statements = public.getMultiRowInsertStatements({
    table: 'gm_data_001.room',
    payloads: [
      { xyNumber: '1排1号', yNum: 1, xNum: 1, table: 'gm_data_001.room' },
      { xyNumber: '1排2号', yNum: 1, xNum: 2 },
    ],
  });

  assert.strictEqual(statements.length, 1, '2 行应合并为 1 条语句');
  assert.strictEqual(statements[0].sql.split(' values ').length - 1, 1, '列名只出现一次');
  assert.strictEqual((statements[0].sql.match(/\),\s*\(/g) || []).length, 1, '两个值元组之间应有一个逗号分隔');
  // 保留列仍被剔除(与单行写法的闸门一致),
  assert.ok(!statements[0].sql.includes('isDeleted'), '保留列不得进入多值 INSERT');
  // $N 按出现顺序展开为 ?,参数个数必须与 ? 个数逐一对齐,
  const normalized = statements[0].sql.replace(/\$\d+(?![A-Za-z0-9_$])/g, '?');
  assert.strictEqual((normalized.match(/\?/g) || []).length, statements[0].params.length);
  assert.ok(normalized.startsWith('insert into gm_data_001.room ('), normalized);

  const empty = public.getMultiRowInsertStatements({ table: 'gm_data_001.room', payloads: [] });
  assert.deepStrictEqual(empty, [], '空批次不得生成语句');
});

test('format: 数字千分位', () => {
  assert.strictEqual(public.format(6666), '6,666');
  assert.strictEqual(public.format('1234567'), '1,234,567');
});

test('getInsertStatement: 生成参数化 INSERT,值不进 SQL 文本', () => {
  const json = { table: 'gm_data_001.contacts', idRoom: '1000001', contacts: '张三', contactsPhone: '13800138000' };
  const statement = public.getInsertStatement(json);
  assert.match(statement.sql, /^insert into gm_data_001\.contacts \(/);
  assert.ok(!statement.sql.includes('张三'));
  assert.ok(!statement.sql.includes('13800138000'));
  // params = 业务字段值 + createDate/modifyDate(函数自动注入)
  assert.strictEqual(statement.params.length, 5);
  assert.ok(statement.params.includes('张三'));
  assert.ok(statement.params.includes('13800138000'));
});

test('getDeleteByIdSql: 参数化软删语句,idvalue 不进 SQL 文本', () => {
  const json = { table: 'gm_data_001.room', idfield: 'idRoom', idvalue: '1000001', isDeleted: 1, operator: 'admin' };
  const statement = public.getDeleteByIdSql(json);
  assert.match(statement.sql, /^update gm_data_001\.room set /);
  assert.match(statement.sql, /where idRoom = \$\d+$/);
  assert.ok(!statement.sql.includes("'1000001'"));
  // params = isDeleted/operator/modifyDate + 末尾 idvalue
  assert.strictEqual(statement.params.length, 4);
  assert.strictEqual(statement.params[3], '1000001');
});

test('getRoomContactsSyncSql/getRoomDeceasedSyncSql: 聚合 SQL 生成', () => {
  const contactsSql = public.getRoomContactsSyncSql('gm_data_001', '1000001');
  assert.ok(contactsSql.includes('GROUP_CONCAT(c.contacts'));
  assert.ok(contactsSql.includes("separator ' '"));
  assert.ok(contactsSql.includes(', 200)'));
  assert.ok(contactsSql.includes('where c.idRoom = 1000001'));
  assert.ok(contactsSql.includes('and c.isDeleted = 0'));

  const deceasedSql = public.getRoomDeceasedSyncSql('gm_data_001', '1000001');
  assert.ok(deceasedSql.includes('GROUP_CONCAT(b.deceased'));
  assert.ok(deceasedSql.includes(', 100)'));
  assert.ok(deceasedSql.includes('where b.idRoom = 1000001'));
  assert.ok(deceasedSql.includes('and b.isDeleted = 0'));
});

// 保留列集中防护(审查修复 20261021 P0-2):写口把 req.body 直接当列集合使用,
// 因此任何身份/租户/审计/主键列都不得由入参流入 SET/VALUES
test('保留列防护:更新语句剔除 isDeleted/isAccount/dataBaseName/uuid/createDate 与主键列', () => {
  const dirty = {
    table: 'gm_data_000.room',
    idfield: 'idRoom',
    idvalue: '1000001',
    price: 6666,
    operator: 'admin',
    // 以下均为攻击性入参,全部应被剔除
    isDeleted: 1,
    isAccount: 1,
    dataBaseName: 'gm_data_999',
    uuid: 'evil',
    createDate: '2000-01-01 00:00:00',
    idRoom: 999999,
  };
  const statement = public.getUpdateByIdStatement(dirty);
  assert.ok(!statement.sql.includes('isDeleted'), 'SET 不应包含 isDeleted');
  assert.ok(!statement.sql.includes('isAccount'), 'SET 不应包含 isAccount');
  assert.ok(!statement.sql.includes('dataBaseName'), 'SET 不应包含 dataBaseName');
  assert.ok(!statement.sql.includes('uuid'), 'SET 不应包含 uuid');
  assert.ok(!statement.sql.includes('createDate'), 'SET 不应包含 createDate');
  // SET 子句里不得出现主键列(只在 WHERE 中出现一次)
  assert.strictEqual(statement.sql.split('idRoom').length - 1, 1);
  // 存活列:price/operator/modifyDate + 末尾 idvalue
  assert.strictEqual(statement.params.length, 4);
  assert.strictEqual(statement.params[3], '1000001');
  // 原入参对象不得被就地修改(浅拷贝口径 20260917)
  assert.strictEqual(dirty.isDeleted, 1);
});

test('保留列防护:条件更新与新建同样剔除保留列,仅软删构造器放行 isDeleted', () => {
  const conditionStatement = public.getUpdateByConditionStatement({
    table: 'gm_data_000.sale',
    condition: { sql: 'idRoom = ? AND isDeleted = 0', params: ['1000001'] },
    isDeleted: 1,
    isAccount: 1,
    operator: 'admin',
  });
  assert.ok(!conditionStatement.sql.includes('set isDeleted'), '条件更新 SET 不应包含 isDeleted');
  assert.ok(!conditionStatement.sql.includes('isAccount'), '条件更新 SET 不应包含 isAccount');
  // 条件更新也统一刷 modifyDate(与按主键更新口径一致)
  assert.match(conditionStatement.sql, /modifyDate/);

  const softDelete = public.getSoftDeleteByConditionStatement({
    table: 'gm_data_000.sale',
    condition: { sql: 'idRoom = ? AND isDeleted = 0', params: ['1000001'] },
    isDeleted: 1,
    operator: 'admin',
  });
  assert.match(softDelete.sql, /set isDeleted/, '软删构造器应显式写入 isDeleted');

  const insertStatement = public.getInsertStatement({
    table: 'gm_data_000.contacts',
    contacts: '张三',
    isDeleted: 1,
  });
  assert.ok(!insertStatement.sql.includes('isDeleted'), 'INSERT 列不应包含 isDeleted');
  // 建户路径合法写 isAccount/account 的 dataBaseName,INSERT 不拦这两个列(仅 UPDATE 拦)
  const accountInsert = public.getInsertStatement({
    table: 'gm_data_000.operator',
    phone: '13800138000',
    isAccount: 1,
    dataBaseName: 'gm_data_001',
  });
  assert.match(accountInsert.sql, /isAccount/, '建户 INSERT 应保留 isAccount');
  assert.match(accountInsert.sql, /dataBaseName/, '建户 INSERT 应保留 dataBaseName');
});

// 请求日志脱敏(审查修复 20261021 P2):日志里的手机号/账户名一旦落盘,留存期远超业务数据本身,
test('maskRequestTarget: 敏感参数与手机号形态的值都被脱敏', () => {
  assert.strictEqual(public.maskRequestTarget('/api/room-query/list'), '/api/room-query/list');
  assert.strictEqual(public.maskRequestTarget('/api/room-query/list?phone=13800138000&pageNum=1'), '/api/room-query/list?phone=138****8000&pageNum=1');
  // 参数名命中敏感词但值不是手机号形态:整值打码(账户名/联系人姓名直接走 query 传给后端),
  assert.strictEqual(public.maskRequestTarget('/api/contract-query/list?accountName=%E5%BC%A0%E4%B8%89&idRoom=1000001'), '/api/contract-query/list?accountName=***&idRoom=1000001');
  assert.strictEqual(public.maskRequestTarget('/api/login/13800138000'), '/api/login/138****8000');
  // 空查询串与无值参数不应被改写成 "?" 尾巴,
  assert.strictEqual(public.maskRequestTarget('/api/x?'), '/api/x');
  assert.strictEqual(public.maskRequestTarget('/api/x?flag'), '/api/x?flag');
  assert.strictEqual(public.maskRequestTarget(''), '');
});

test('maskQueryValue: 只按值形态与参数名判定,不误伤普通数值参数', () => {
  assert.strictEqual(public.maskQueryValue('idRoom', '1000001'), '1000001');
  assert.strictEqual(public.maskQueryValue('password', 'plain-text'), '***');
  assert.strictEqual(public.maskQueryValue('orderBy', '12123456789'), '121****6789');
});

