//用于基础数据更新
const pool = require('./database');
const bcrypt = require('bcryptjs');

//bcrypt哈希特征前缀,用于区分存量明文密码 20260915 安全改造,
const bcryptPrefix = /^\$2[aby]\$/;

const simpleIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const qualifiedIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const dateFieldPattern = /(date|time)$/i;

function assertIdentifier(value, label) {
  if (!simpleIdentifierPattern.test(String(value || ''))) {
    throw new Error(`Invalid ${label}`);
  }

  return value;
}

function assertTableName(value) {
  if (!qualifiedIdentifierPattern.test(String(value || ''))) {
    throw new Error('Invalid table');
  }

  return value;
}

//将ISO-8601时间(带T和Z)转为MySQL标准格式YYYY-MM-DD HH:mm:ss,按本地时区转换避免偏移8小时 20260827联调修复,
function normalizeDateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function normalizeValues(values) {
  return values.map((value) => normalizeDateValue(value));
}

//生成MySQL标准格式当前时间YYYY-MM-DD HH:mm:ss,避免toLocaleString受系统locale影响 20260915 优化,
function getCurrentDateTime() {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

exports.getCurrentDateTime = getCurrentDateTime;

//密码哈希:统一使用 bcrypt 存储,登录与改密写入时调用 20260915 安全改造,
exports.hashPassword = function (password) {
  return bcrypt.hash(String(password || ''), 10);
}

//判断是否为bcrypt哈希(以 $2a/$2b/$2y 开头) 20260915 安全改造,
exports.isBcryptHash = function (value) {
  return bcryptPrefix.test(String(value || ''));
}

//密码校验:bcrypt哈希优先比对,非哈希时兼容存量明文比对;恒resolve(true/false) 20260915 安全改造,
exports.verifyPassword = function (input, stored) {
  const storedStr = String(stored || '');
  if (bcryptPrefix.test(storedStr)) {
    return bcrypt.compare(String(input || ''), storedStr).catch(() => false);
  }

  return Promise.resolve(String(input || '') === storedStr);
}

//日期类字段空字符串转NULL,避免Incorrect date/datetime value错误 20260827联调修复,
exports.normalizeBodyDates = function (body) {
  if (!body || typeof body !== 'object') {
    return body;
  }

  Object.keys(body).forEach((key) => {
    if (!dateFieldPattern.test(key)) {
      return;
    }

    if (body[key] === '') {
      body[key] = null;
      return;
    }

    body[key] = normalizeDateValue(body[key]);
  });

  return body;
}

exports.parseNumericParam = function (value) {
  const normalizedValue = String(value || '').trim();
  if (!/^\d+$/.test(normalizedValue)) {
    return null;
  }

  return normalizedValue;
}

//浅拷贝消除对调用方对象(req.body)的副作用,调用处无需先捕获再调用 20260917 优化,
exports.getUpdateByIdStatement = function (input) {
  const json = { ...input };
  const idfield = assertIdentifier(json.idfield, 'idfield');
  const idvalue = json.idvalue;
  const table = assertTableName(json.table);

  delete json.idfield;
  delete json.idvalue;
  delete json.table;

  const currentTime = getCurrentDateTime();
  json.modifyDate = currentTime;

  const keys = Object.keys(json);
  const values = normalizeValues(Object.values(json));
  const assignments = keys.map((item, index) => `${assertIdentifier(item, 'field')} = $${index + 1}`);

  return {
    sql: `update ${table} set ${assignments.join(', ')} where ${idfield} = $${keys.length + 1}`,
    params: [...values, idvalue],
  };
}
exports.getUpdateByConditionStatement = function (input) {
  const json = { ...input };
  const condition = json.condition;
  const table = assertTableName(json.table);
  delete json.table;
  delete json.condition;

  const currentTime = getCurrentDateTime();
  json.modifyDate = currentTime;

  const keys = Object.keys(json);
  const assignments = keys.map((item, index) => `${assertIdentifier(item, 'field')} = $${index + 1}`);

  return {
    sql: `update ${table} set ${assignments.join(', ')} where ${condition.sql}`,
    params: [...normalizeValues(Object.values(json)), ...(Array.isArray(condition.params) ? condition.params : [])],
  };
}

exports.getInsertStatement = function (input) {
  const json = { ...input };
  const table = assertTableName(json.table);
  delete json.table;

  const currentTime = getCurrentDateTime();
  json.modifyDate = currentTime;
  json.createDate = currentTime;

  const keys = Object.keys(json);
  const placeholders = keys.map((_, index) => `$${index + 1}`);

  return {
    sql: `insert into ${table} (${keys.map((item) => assertIdentifier(item, 'field')).join(', ')}) values (${placeholders.join(', ')})`,
    params: normalizeValues(keys.map((item) => json[item])),
  };
}

exports.getDeleteByIdSql = function (input) {
  const json = { ...input };
  const idfield = assertIdentifier(json.idfield, 'idfield');
  const idvalue = json.idvalue;
  const table = assertTableName(json.table);

  delete json.idfield;
  delete json.idvalue;
  delete json.table;

  const currentTime = getCurrentDateTime();
  json.modifyDate = currentTime;

  const keys = Object.keys(json);
  const values = normalizeValues(Object.values(json));
  const assignments = keys.map((item, index) => `${assertIdentifier(item, 'field')} = $${index + 1}`);

  return {
    sql: `update ${table} set ${assignments.join(', ')} where ${idfield} = $${keys.length + 1}`,
    params: [...values, idvalue],
  };
}

exports.format = function (num) {  
  var reg=/\d{1,3}(?=(\d{3})+$)/g;   
  return (num + '').replace(reg, '$&,');  
}

exports.handleQueryError = function (res, error) {
  console.error('Database query error:', error);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }

  return res;
}

exports.respondList = function (res, list) {
  return res.json({ code: 0, data: { list } });
}

exports.respondDetail = function (res, list) {
  if (!Array.isArray(list) || list.length === 0) {
    return res.status(404).json({ error: '数据不存在!' });
  }

  return res.json({ code: 0, data: { list } });
}

exports.respondAffectedRows = function (res, result, options = {}) {
  const affectedRows = Number(result && result.affectedRows) || 0;
  const successStatus = options.successStatus || 200;
  const notFoundStatus = options.notFoundStatus || 404;

  if (affectedRows === 0) {
    return res.status(notFoundStatus).json({ code: 0, affectedRows });
  }

  return res.status(successStatus).json({ code: 0, affectedRows });
}

exports.respondTransaction = function (res, result, options = {}) {
  const affectedRows = Number(result && result.affectedRows) || 0;
  const successStatus = options.successStatus || 200;

  return res.status(successStatus).json({ code: 0, affectedRows });
}
//同步墓位 room.contacts:聚合该墓位全部活动联系人姓名(空格分隔),截断 200 字符,无活动联系人时置空 20260913 新增,
exports.getRoomContactsSyncSql = function (dataBase, idRoom) {
  return (
    'update ' + dataBase + '.room r set r.contacts = (' +
    "select LEFT(GROUP_CONCAT(c.contacts order by c.idContacts asc separator ' '), 200) from " + dataBase + '.contacts c' +
    ' where c.idRoom = ' + idRoom + ' and c.isDeleted = 0' +
    ') where r.idRoom = ' + idRoom
  );
}

//同步墓位 room.deceased:聚合该墓位全部活动下葬记录安葬者姓名(空格分隔),截断 100 字符,无活动下葬记录时置空 20260917 新增,
exports.getRoomDeceasedSyncSql = function (dataBase, idRoom) {
  return (
    'update ' + dataBase + '.room r set r.deceased = (' +
    "select LEFT(GROUP_CONCAT(b.deceased order by b.idBuried asc separator ' '), 100) from " + dataBase + '.buried b' +
    ' where b.idRoom = ' + idRoom + ' and b.isDeleted = 0' +
    ') where r.idRoom = ' + idRoom
  );
}

//墓位预定限期副本同步的语句模板:取该墓位活动预定记录的预定限期,无活动预定时自动置空,
//与 contacts/deceased 两个聚合同步同属"墓位冗余列由业务表反推"口径,预定登记/修改/取消三条路径均复用本模板避免各处手写产生偏差;
//MAX 兜底防一穴多条活动预定(历史脏数据)时子查询返回多行报错;whereClause 里的值均已经过 parseNumericParam 校验 20261011 新增,
function roomReservationExpireSyncSql(dataBase, whereClause) {
  return (
    'update ' + dataBase + '.room r set r.reservationExpireDate = (' +
    'select max(res.reservationExpireDate) from ' + dataBase + '.reserve res' +
    ' where res.idRoom = r.idRoom and res.isDeleted = 0' +
    ') where ' + whereClause
  );
}

//按墓位同步限期副本(预定登记/取消预定两个入口手里就是 idRoom) 20261011 新增,
exports.getRoomReservationExpireSyncSql = function (dataBase, idRoom) {
  return roomReservationExpireSyncSql(dataBase, 'r.idRoom = ' + idRoom);
}

//按预定记录反查所属墓位再同步限期副本(预定修改两个入口用):不依赖调用方是否传 idRoom——
//漏传时旧写法会静默不同步,造成 reserve 已改期、room 副本还是旧到期日 20261011 新增,
exports.getRoomReservationExpireSyncByIdReserveSql = function (dataBase, idReserve) {
  return roomReservationExpireSyncSql(
    dataBase,
    'r.idRoom = (select res2.idRoom from ' + dataBase + '.reserve res2 where res2.idReserve = ' + idReserve + ')',
  );
}

//预定记录一穴一条:同一墓位不累积多条预定信息——已有记录(含取消后的历史行)就复用原行按本次提交覆盖并把 isDeleted 回置 0,
//一条都没有才新增;复用时顺带把同穴其余活动记录软删(历史遗留的一穴多条),保证"一穴只留一条"从本次写入起成立 20261011 新增,
//入参 json 为已设好 table/operator 的预定记录字段(同 getInsertStatement 入参),idRoom 由调用方先过 parseNumericParam 校验,
exports.buildReserveUpsertStatements = async function (dataBase, idRoom, json) {
  // 优先复用活动记录(isDeleted = 0),无活动记录时取最近一条已取消记录(历史不堆积的关键),
  // 本应用同一事务内先查后写且预定登记为单操作员场景,不再额外加行锁 20261011 新增,
  const rows = await pool.query(
    'select idReserve from ' + dataBase + '.reserve where idRoom = ? order by isDeleted asc, idReserve desc limit 1',
    [idRoom],
  );
  if (!rows || rows.length === 0) {
    return { reused: false, statements: [exports.getInsertStatement(json)] };
  }

  const idReserve = rows[0].idReserve;
  const updateJson = { ...json, idfield: 'idReserve', idvalue: idReserve, isDeleted: 0 };
  // idRoom 就是原行所属墓位、idReserve 为主键,两者不必再进 SET 子句 20261011 新增,
  delete updateJson.idRoom;
  delete updateJson.idReserve;

  return {
    reused: true,
    idReserve,
    statements: [
      exports.getUpdateByIdStatement(updateJson),
      {
        sql: 'update ' + dataBase + '.reserve set isDeleted = 1 where idRoom = ? and idReserve <> ? and isDeleted = 0',
        params: [idRoom, idReserve],
      },
    ],
  };
}

//token失效统一提示文案,index/menu 共用,避免各处硬编码 20260917 梳理,
exports.TOKEN_EXPIRED_MESSAGE = 'token失效1';

//事务
exports.Transaction = function (sqlList,res) {  
  pool.withTransaction(sqlList)
    .then((result) => {
      return exports.respondTransaction(res, result);
    })
    .catch((error) => {
      return exports.handleQueryError(res, error);
    });

  return res;
}
