// 墓位业务保存(gravePlotBusiness/save.js)的入参形态拆分(审查修复 20261021 二轮 P2-15)。
// 前端统一业务模型按 type 落到不同业务表:每种形态都要把目标表没有的列先从 body 里剔除
// (否则该键会被拼进 INSERT/UPDATE 的列清单,直接报“未知列”),跨表字段(安葬者/联系人)还要先捕获再交给对应表的语句,
// 原先这些剔除清单在“新建”和“修改”两个 handler 里各写一份、共六处逐字重复,
// 改一处忘一处就会出现“新建能存、修改丢字段”的口径漂移,而语法与用例都不会报错,
// 本模块只做纯数据整形:不连库、不碰 res,可单独推演;对外经 public.js 门面再导出,调用点无需 require 本文件。

// 判空口径:提交值可能是 undefined(前端未带该键)、null 或空串,三种都算“没填”,
function hasFilledValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

// 文本列未填时写空串(这些列在库里是 NOT NULL),不可直传 undefined:mysql2 绑定 undefined 会直接报错,
function blankToEmpty(value) {
  return value === undefined || value === null ? '' : value;
}

// 日期列未填时写 null 而非空串:datetime 列在 sql_mode=STRICT_TRANS_TABLES 下写空串会被 MySQL 拒,
// 与文本列的兜底值不同,因此单独成函数,避免调用处混用两种口径,
function blankToNull(value) {
  return value === undefined || value === null ? null : value;
}

function removeKeys(body, keys) {
  keys.forEach((key) => {
    delete body[key];
  });
}

// 销售形态:安葬者五字段属 buried 表、联系人四字段属 contacts 表,均须从 sale 的写入字段中剔除;
// 捕获下来的值供后续 buried 插入与联系人同步使用(新建与修改两个分支口径逐字相同),
const SALE_FOREIGN_FIELDS = [
  'deceased', 'deathDate', 'burialDate', 'deceasedIDCard', 'deceasedRelation',
  'contacts', 'contactsphone', 'contactsPhone', 'contactsIDCard',
];

function captureSaleFormFields(body) {
  // 付款人三字段与编号本身就是 sale 列,因此只捕获不剔除(后续拼 INSERT 仍需要它们),
  const captured = {
    deceased: body.deceased,
    deathDate: body.deathDate,
    burialDate: body.burialDate,
    deceasedIDCard: body.deceasedIDCard,
    deceasedRelation: body.deceasedRelation,
    payer: body.payer,
    payerPhone: body.payerPhone,
    payerIDCard: body.payerIDCard,
    serialNo: body.serialNo,
  };
  // 先捕获后剔除:跨表列留在 body 里会被拼进 sale 的 INSERT/UPDATE 列清单而直接报“未知列”,
  removeKeys(body, SALE_FOREIGN_FIELDS);
  return captured;
}

// 金额列归一:前端提交的是带千分位的显示串,落库前去掉逗号;realPriceString 只用于展示不进库,
// 注意:仅新建路径调用,修改路径历史上不重算金额格式(保持原口径,不在本批顺带改动),
function normalizePriceField(body) {
  body.realPrice = String(body.realPrice ?? '').replace(/,/g, '');
  delete body.realPriceString;
}

// 下葬形态:付款人/金额/编号属销售侧字段,与 buried 表无关,统一清理;
// 安葬者三字段本就落在 buried 表,因此保留直写,不在剔除之列,
const BURIED_FOREIGN_FIELDS = ['payer', 'payerPhone', 'payerIDCard', 'realPrice', 'realPriceString', 'payee', 'serialNo'];

function stripBuriedFormFields(body) {
  removeKeys(body, BURIED_FOREIGN_FIELDS);
}

// 预定形态:reserve 表只有 liaison 系列列,先把统一模型的付款人字段映射为预定联系人字段,再剔除 reserve 没有的列,
// 联系人三字段与 deathDate 分属 contacts/buried 表,reserve 表里都没有这两类列:前端提交的是统一业务模型(键恒存在,
// 空串也会被拼进列清单),新建与修改两个分支必须一律剔除,否则 INSERT/UPDATE 报未知列(500)20261026 修复,
// 20261026 前新建分支沿用“只剔付款人/金额/安葬者”的旧口径且两份清单都漏了 deathDate,导致预定提交恒报 Internal server error,
// forUpdate:修改分支不更新外键 idRoom(墓位不变),
const RESERVE_FOREIGN_FIELDS = [
  'payer', 'payerPhone', 'realPrice', 'realPriceString', 'payerIDCard', 'payee', 'serialNo',
  'deceased', 'deathDate', 'burialDate', 'deceasedIDCard', 'deceasedRelation',
  'contacts', 'contactsphone', 'contactsPhone', 'contactsIDCard',
];
const RESERVE_UPDATE_EXTRA_FIELDS = ['idRoom'];

function prepareReserveFormBody(body, forUpdate) {
  body.liaison = body.payer;
  body.liaisonPhone = body.payerPhone;
  removeKeys(body, RESERVE_FOREIGN_FIELDS);
  if (forUpdate) {
    removeKeys(body, RESERVE_UPDATE_EXTRA_FIELDS);
  }
}

// 安葬证形态:落 burial_cert 本表,仅插入/更新不联动,业务侧字段一律清理,
// forUpdate:墓位不变,故 idRoom 也不得进 SET,
const CERTIFICATE_FOREIGN_FIELDS = [
  'payer', 'payerPhone', 'payerIDCard', 'realPrice', 'realPriceString', 'payee',
  'deceased', 'deceasedIDCard', 'contacts', 'contactsphone', 'contactsIDCard',
];

function prepareCertificateFormBody(body, forUpdate) {
  removeKeys(body, CERTIFICATE_FOREIGN_FIELDS);
  if (forUpdate) {
    removeKeys(body, ['idRoom']);
  }
}

// 默认(业务表)形态:graveplotbusiness 本表既无安葬者列也无联系人列,两种形态口径完全相同,
const DEFAULT_FORM_FOREIGN_FIELDS = ['deceased', 'burialDate', 'deceasedIDCard', 'deceasedRelation', 'contacts', 'contactsphone', 'contactsIDCard'];

function stripDefaultFormFields(body) {
  removeKeys(body, DEFAULT_FORM_FOREIGN_FIELDS);
}

module.exports = {
  hasFilledValue,
  blankToEmpty,
  blankToNull,
  captureSaleFormFields,
  normalizePriceField,
  stripBuriedFormFields,
  prepareReserveFormBody,
  prepareCertificateFormBody,
  stripDefaultFormFields,
};
