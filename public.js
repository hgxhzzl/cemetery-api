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

//构建联系人同步语句:同墓位活动联系人按 名/电话 匹配,联系人名/电话/身份证号一并同步 20260917 修改,
//同名存在且电话/身份证号有变化则更新;同名不存在但同电话存在则更新联系人名与身份证号;名/电话均不存在则新增;联系人名为空不处理 20260916 新增,
//从 buried/save.js 提升为公共函数,供下葬/收管理费等页复用同一口径,避免各页手写产生偏差 20261017 新增,
exports.buildContactsSyncStatements = async function (dataBase, idRoom, contactsName, contactsPhone, contactsIDCard, operator) {
  const nameValid = contactsName !== undefined && contactsName !== null && String(contactsName).trim() !== '';
  if (!nameValid) {
    return [];
  }

  const name = String(contactsName).trim();
  const phone = String(contactsPhone === undefined || contactsPhone === null ? '' : contactsPhone).trim();
  const idCard = String(contactsIDCard === undefined || contactsIDCard === null ? '' : contactsIDCard).trim();
  const table = dataBase + '.contacts';
  const rows = await pool.query(
    `select idContacts, contacts, contactsPhone, contactsIDCard from ${table} where idRoom = ? and isDeleted = 0`,
    [idRoom],
  );

  const sameName = rows.find((item) => String(item.contacts || '').trim() === name);
  if (sameName) {
    // 同名活动联系人存在:电话或身份证号有变化才更新
    if (String(sameName.contactsPhone || '').trim() !== phone || String(sameName.contactsIDCard || '').trim() !== idCard) {
      return [exports.getUpdateByConditionStatement({
        table,
        condition: { sql: 'idContacts = ? AND isDeleted = 0', params: [sameName.idContacts] },
        contactsPhone: phone,
        contactsIDCard: idCard,
        operator,
      })];
    }
    return [];
  }

  const samePhone = phone !== '' ? rows.find((item) => String(item.contactsPhone || '').trim() === phone) : null;
  if (samePhone) {
    // 同名不存在但电话相同:更新联系人名与身份证号
    return [exports.getUpdateByConditionStatement({
      table,
      condition: { sql: 'idContacts = ? AND isDeleted = 0', params: [samePhone.idContacts] },
      contacts: name,
      contactsIDCard: idCard,
      operator,
    })];
  }

  // 名/电话均不存在:新增一条联系人
  return [exports.getInsertStatement({
    table,
    idRoom,
    contacts: name,
    contactsPhone: phone,
    contactsIDCard: idCard,
    operator,
  })];
}

// ==================== 管理费期限链式顺延（收管理费新建/修改/删除共用口径） ====================
// 该墓位全部活动收款记录按 createDate 升序链式顺延：首条开始日期=墓位锚定起始日(room.startDate，即最早下葬日期；为空回落本次提交/剩余记录最早开始日期)，
// 其后每条开始=上一条结束，结束=开始+该条缴费年限；room.endDate 取链尾。提升自 adminfee/save.js 供删除入口复用，避免各入口手写顺延产生偏差 20261018 新增,

// 空值安全转本地零点 Date：库列 datetime 经 mysql2 回传 Date、提交值为 YYYY-MM-DD 串；无效返回 null 20261018 新增,
function toFeeDay(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const parsed = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addFeeYears(dateObj, years) {
  const shifted = new Date(dateObj.getTime());
  shifted.setFullYear(shifted.getFullYear() + years);
  return shifted;
}

exports.fmtFeeDay = function (dateObj) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
}

// 空值安全的天级格式化，用于"库中现值 vs 链算目标值"的等值比较 20261018 新增,
exports.feeDayStr = function (value) {
  const d = toFeeDay(value);
  return d ? exports.fmtFeeDay(d) : '';
}

// 链式计算：orderedRows 须已按 createDate 升序且携带本次提交的最新年限值；
// 年限为空/≤0 的记录保留其原结束日期(晚于链起点时)否则结束=开始——防止无年限历史记录把整条链拽回 20261018 新增,
exports.computeFeePeriodCascade = function (anchorDay, orderedRows) {
  let cursor = anchorDay;
  const targets = [];
  orderedRows.forEach((row) => {
    const start = cursor;
    const years = Number(row.termYears) || 0;
    let end;
    if (years > 0) {
      end = addFeeYears(start, years);
    } else {
      const original = toFeeDay(row.endDate);
      end = original && original.getTime() > start.getTime() ? original : start;
    }
    targets.push({ row, startDate: exports.fmtFeeDay(start), endDate: exports.fmtFeeDay(end) });
    cursor = end;
  });
  return { targets, tailDate: exports.fmtFeeDay(cursor) };
}

// 锚定起始日（统一定义）：一律优先取该墓位最早活动下葬日期 min(burialDate)——直接以下葬事实为准，不读可能滞后的 room.startDate 副本;
// 无活动下葬记录时回落 room.startDate(先收款后下葬/历史场景)，仍为空再回落调用方提供的兜底日期；均无则返回 null 由调用方兜底 20261018 统一定义,
exports.findFeePeriodAnchor = async function (dataBase, idRoom, bodyStartDate) {
  const minRows = await pool.query(
    `select min(burialDate) as minBurial from ${dataBase}.buried where idRoom = ? and isDeleted = 0`,
    [idRoom],
  );
  const minBurial = minRows && minRows.length > 0 ? toFeeDay(minRows[0].minBurial) : null;
  if (minBurial) {
    return minBurial;
  }
  const roomRows = await pool.query(`select startDate from ${dataBase}.room where idRoom = ? limit 1`, [idRoom]);
  const roomStart = roomRows && roomRows.length > 0 ? toFeeDay(roomRows[0].startDate) : null;
  if (roomStart) {
    return roomStart;
  }
  return toFeeDay(bodyStartDate);
}

// 读取该墓位全部活动收款记录（createDate 升序，同秒按主键稳定排序） 20261018 新增,
exports.listActiveFeeRows = async function (dataBase, idRoom) {
  return pool.query(
    `select idAdminfee, termYears, startDate, endDate from ${dataBase}.adminfee
      where idRoom = ? and isDeleted = 0 order by createDate asc, idAdminfee asc`,
    [idRoom],
  );
}

// 安全取多个日期值(可混合 Date/字符串/null)中的最早本地零点 Date；全无效返回 null 20261018 ⑤ 新增,
exports.feeMinDay = function (...values) {
  let earliest = null;
  values.forEach((v) => {
    const d = toFeeDay(v);
    if (d && (!earliest || d.getTime() < earliest.getTime())) {
      earliest = d;
    }
  });
  return earliest;
}

// 该墓位是否存在可用于锚定的活动下葬记录(即有下葬日期的活动 buried)——收管理费前置校验用(② 无锚定下葬不可收款)；
// 仅“有日期下葬”才作锚:避免无日期 buried 行使 min(burialDate) 为空、收款后又被下次下葬变动归零软删 20261018 新增,
exports.hasActiveBurial = async function (dataBase, idRoom) {
  const rows = await pool.query(
    `select 1 as hit from ${dataBase}.buried where idRoom = ? and isDeleted = 0 and burialDate is not null limit 1`,
    [idRoom],
  );
  return !!(rows && rows.length > 0);
}

// 下葬增/删/改后统一维护该墓位管理期限（⑤/Rule2）：anchorDay 为变更后最早活动下葬日期（由调用方按增/删/改语义算好传入）——
// 无活动下葬记录(anchorDay 为空)时 room.startDate/endDate 置空,并软删该墓位全部活动收款记录(无埋则 adminfee 一并软删,Rule2)；
// 无活动收款记录时仅将 room.startDate/endDate 同置 anchorDay（无条件覆盖）；
// 有收款记录时以 anchorDay 为锚整链重排 adminfee 起止，并写回 room.startDate=anchorDay、room.endDate=链尾 20261018 ⑤ 新增, 20261018 Rule2 归零软删 adminfee,
exports.applyFeePeriodRecascade = async function (dataBase, idRoom, operator, anchorDay) {
  if (!anchorDay) {
    return [
      exports.getUpdateByConditionStatement({
        table: dataBase + '.adminfee',
        condition: { sql: 'idRoom = ? AND isDeleted = 0', params: [idRoom] },
        isDeleted: 1,
        operator,
      }),
      {
        sql: `update ${dataBase}.room set startDate = null, endDate = null where idRoom = ?`,
        params: [idRoom],
      },
    ];
  }
  const anchorStr = exports.fmtFeeDay(anchorDay);
  const feeRows = await exports.listActiveFeeRows(dataBase, idRoom);
  if (!feeRows || feeRows.length === 0) {
    return [{
      sql: `update ${dataBase}.room set startDate = ?, endDate = ? where idRoom = ?`,
      params: [anchorStr, anchorStr, idRoom],
    }];
  }
  const { targets, tailDate } = exports.computeFeePeriodCascade(anchorDay, feeRows);
  const statements = [];
  targets.forEach(({ row, startDate: startStr, endDate: endStr }) => {
    if (exports.feeDayStr(row.startDate) !== startStr || exports.feeDayStr(row.endDate) !== endStr) {
      statements.push(exports.getUpdateByIdStatement({
        table: dataBase + '.adminfee',
        idfield: 'idAdminfee',
        idvalue: row.idAdminfee,
        startDate: startStr,
        endDate: endStr,
        operator,
      }));
    }
  });
  statements.push({
    sql: `update ${dataBase}.room set startDate = ?, endDate = ? where idRoom = ?`,
    params: [anchorStr, tailDate, idRoom],
  });
  return statements;
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
