// SQL 语句构造与标识符白名单:列名/表名断言、保留列剔除、insert/update/soft-delete 语句生成(由 public.js 拆出,审查修复 20261021 P1-7)。
// 对外口径不变:public.js 门面仍再导出本模块全部成员,调用点无需改动。

const { getCurrentDateTime, normalizeValues } = require('./common');

const simpleIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const qualifiedIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function assertIdentifier(value, label) {
  if (!simpleIdentifierPattern.test(String(value || ''))) {
    throw new Error(`Invalid ${label}`);
  }

  return value;
}

// 导出供授权层(rbac 归属校验的库名防御)与业务文件复用,避免各处重抄正则 20261021 新增,
exports.assertIdentifier = assertIdentifier;
exports.assertTableName = assertTableName;

function assertTableName(value) {
  if (!qualifiedIdentifierPattern.test(String(value || ''))) {
    throw new Error('Invalid table');
  }

  return value;
}

// 保留列集中防护(审查修复 20261021 P0-2):全站 20+ 写口直接把 req.body 当列集合交给下面的语句
// 构造器,意味着客户端可以往 SET/VALUES 里塞任意列——包含 isAccount(提权)、dataBaseName(跳租户写入)、
// uuid(改登录唯一键)、isDeleted(复活/静默作废记录)、createDate(篡改审计时间)以及主键本身(改目标行)。
// 逐 handler 防会漏,故在构造器这一唯一切面统一剔除;服务端自身确实需要写保留列时(如软删)
// 必须走 getSoftDelete* 显式构造器,保证「谁在写保留列」在代码里可被检索。
const RESERVED_UPDATE_FIELDS = ['isDeleted', 'isAccount', 'dataBaseName', 'uuid', 'createDate'];

/**
 * 剔除保留列(就地修改入参对象)
 * @param {Object} json 待写入的列集合
 * @param {Object} [options] { allow: 显式放行的列, also: 额外必须剔除的列名(如主键) }
 * @returns {string[]} 被剔除的列名
 */
exports.stripReservedFields = function (json, options = {}) {
  const allowed = new Set(options.allow || []);
  const forced = new Set((options.also || []).filter(Boolean));
  const removed = [];
  Object.keys(json).forEach((key) => {
    if (allowed.has(key)) {
      return;
    }
    if (RESERVED_UPDATE_FIELDS.includes(key) || forced.has(key)) {
      delete json[key];
      removed.push(key);
    }
  });
  return removed;
}

// 软删专用构造器:语义与对应通用构造器一致,仅多放行 isDeleted 一列
exports.getSoftDeleteByIdStatement = function (input) {
  return exports.getUpdateByIdStatement(input, { allow: ['isDeleted'] });
}
exports.getSoftDeleteByConditionStatement = function (input) {
  return exports.getUpdateByConditionStatement(input, { allow: ['isDeleted'] });
}

//浅拷贝消除对调用方对象(req.body)的副作用,调用处无需先捕获再调用 20260917 优化,
exports.getUpdateByIdStatement = function (input, options = {}) {
  const json = { ...input };
  const idfield = assertIdentifier(json.idfield, 'idfield');
  const idvalue = json.idvalue;
  const table = assertTableName(json.table);

  delete json.idfield;
  delete json.idvalue;
  delete json.table;

  // 主键列已在 WHERE 中使用 idvalue,留在 SET 里只会被用来把行改到另一个主键上,一律剔除
  exports.stripReservedFields(json, { ...options, also: [idfield] });

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
exports.getUpdateByConditionStatement = function (input, options = {}) {
  const json = { ...input };
  const condition = json.condition;
  const table = assertTableName(json.table);
  delete json.table;
  delete json.condition;

  exports.stripReservedFields(json, options);

  const currentTime = getCurrentDateTime();
  json.modifyDate = currentTime;

  const keys = Object.keys(json);
  const assignments = keys.map((item, index) => `${assertIdentifier(item, 'field')} = $${index + 1}`);

  return {
    sql: `update ${table} set ${assignments.join(', ')} where ${condition.sql}`,
    params: [...normalizeValues(Object.values(json)), ...(Array.isArray(condition.params) ? condition.params : [])],
  };
}

exports.getInsertStatement = function (input, options = {}) {
  const json = { ...input };
  const table = assertTableName(json.table);
  delete json.table;

  // 新建记录只拦 isDeleted(避免直接造出一条隐身记录);
  // isAccount/dataBaseName 在建户路径上是合法业务列(account 写入固定为1、operator 服务端置0),
  // createDate/modifyDate 紧接着由服务端时间覆盖,故此处不予拦截
  exports.stripReservedFields(json, {
    ...options,
    allow: ['isAccount', 'dataBaseName', 'uuid', 'createDate', 'modifyDate', ...(options.allow || [])],
  });

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

  // 本构造器专职软删,因此显式放行 isDeleted(其余保留列仍被剔除)
  exports.stripReservedFields(json, { allow: ['isDeleted'], also: [idfield] });

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
