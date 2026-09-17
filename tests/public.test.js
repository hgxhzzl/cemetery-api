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
  const statement = public.getUpdateByConditionStatement(json);
  assert.match(statement.sql, /where idRoom = \? AND isDeleted = 0$/);
  assert.ok(!statement.sql.includes("'1000001'"));
  // params = SET字段值(isDeleted/operator/modifyDate) + 条件参数
  assert.strictEqual(statement.params.length, 4);
  assert.strictEqual(statement.params[3], '1000001');
});

test('hashPassword/verifyPassword/isBcryptHash: 哈希与明文兼容校验', async () => {
  const hashed = await public.hashPassword('1234');
  assert.strictEqual(public.isBcryptHash(hashed), true);
  assert.strictEqual(public.isBcryptHash('1234'), false);
  assert.strictEqual(await public.verifyPassword('1234', hashed), true);
  assert.strictEqual(await public.verifyPassword('wrong', hashed), false);
  // 存量明文兼容:明文比对仍可用
  assert.strictEqual(await public.verifyPassword('1234', '1234'), true);
  assert.strictEqual(await public.verifyPassword('1234', '5678'), false);
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

