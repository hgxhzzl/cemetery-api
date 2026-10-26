// lib/gravePlotBody.js 的形态拆分口径用例(审查修复 20261021 二轮 P2-15),
// 本模块是从 gravePlotBusiness/save.js 里抽出的纯数据整形:新建与修改两个 handler 原先各抄一份
// 完全相同的 delete 清单,拆分必须逐字保持原口径(仅 idRoom 这类“新建要写、修改不写”的差异保留),
// 而集成用例并不会覆盖全部六种形态,因此用一组纯函数断言把每个形态的“剔除集合 + 捕获值”钉住,
const test = require('node:test');
const assert = require('node:assert');
const gravePlotBody = require('../lib/gravePlotBody');

const {
  hasFilledValue,
  blankToEmpty,
  blankToNull,
  captureSaleFormFields,
  normalizePriceField,
  stripBuriedFormFields,
  prepareReserveFormBody,
  prepareCertificateFormBody,
  stripDefaultFormFields,
} = gravePlotBody;

// 一份“前端统一业务模型”的全字段样本:六种形态的入参都从它派生,便于比对剩余键集合,
function fullBody() {
  return {
    idRoom: 12,
    idBusiness: 34,
    type: 'sale',
    payer: '张三',
    payerPhone: '13800138000',
    payerIDCard: '3301',
    realPrice: '1,200.00',
    realPriceString: '1,200.00',
    payee: '李四',
    serialNo: 'A001',
    deceased: '王五',
    deathDate: '2026-01-01',
    burialDate: '2026-02-02',
    deceasedIDCard: '3302',
    deceasedRelation: '配偶',
    contacts: '赵六',
    contactsphone: '13900139000',
    contactsPhone: '13900139000',
    contactsIDCard: '3303',
    remark: '备注',
  };
}

function remainingKeys(body) {
  return Object.keys(body).sort();
}

test('gravePlotBody: 销售形态捕获九项跨表值并只剔除 buried/contacts 列', () => {
  const body = fullBody();
  const captured = captureSaleFormFields(body);

  assert.deepStrictEqual(captured, {
    deceased: '王五',
    deathDate: '2026-01-01',
    burialDate: '2026-02-02',
    deceasedIDCard: '3302',
    deceasedRelation: '配偶',
    payer: '张三',
    payerPhone: '13800138000',
    payerIDCard: '3301',
    serialNo: 'A001',
  });
  // 剩余集合必须恰为“除安葬者五字段 + 联系人四字段之外的全部入参”:payer/serialNo/realPrice 是 sale 自身列不得被剔,
  assert.deepStrictEqual(remainingKeys(body), [
    'idBusiness', 'idRoom', 'payee', 'payer', 'payerIDCard', 'payerPhone', 'realPrice', 'realPriceString', 'remark', 'serialNo', 'type',
  ]);
  assert.ok(!('deceased' in body) && !('contacts' in body), '跨表字段应已从 sale 写入集合中剔除');
});

test('gravePlotBody: 金额去千分位并剔除展示列,缺字段时不抛错', () => {
  const body = { realPrice: '1,200.00', realPriceString: '1,200.00' };
  normalizePriceField(body);
  assert.strictEqual(body.realPrice, '1200.00');
  assert.ok(!('realPriceString' in body), 'realPriceString 只用于展示不得进库');

  // 前端未带 realPrice:原实现直接 .toString() 会抛 TypeError 并崩掉 async handler,
  const empty = {};
  normalizePriceField(empty);
  assert.strictEqual(empty.realPrice, '');
});

test('gravePlotBody: 文本列回空串与日期列回 null 两种兜底不可混用', () => {
  assert.strictEqual(blankToEmpty(undefined), '');
  assert.strictEqual(blankToEmpty(null), '');
  assert.strictEqual(blankToEmpty(''), '');
  assert.strictEqual(blankToEmpty('张三'), '张三');

  assert.strictEqual(blankToNull(undefined), null);
  assert.strictEqual(blankToNull(null), null);
  // 日期列留空必须落 NULL:datetime 写空串在 sql_mode=STRICT_TRANS_TABLES 下会直接报错,
  assert.notStrictEqual(blankToNull(null), blankToEmpty(null));
  assert.strictEqual(blankToNull('2026-01-01'), '2026-01-01');
});

test('gravePlotBody: hasFilledValue 把 undefined/null/空串/纯空白一律视为未填', () => {
  assert.strictEqual(hasFilledValue(undefined), false);
  assert.strictEqual(hasFilledValue(null), false);
  assert.strictEqual(hasFilledValue(''), false);
  assert.strictEqual(hasFilledValue('   '), false);
  assert.strictEqual(hasFilledValue('张三'), true);
  // 判定不能写成 String(value).trim() 不含 null 分支:String(null) 得到 'null' 会被当成已填,
  assert.strictEqual(hasFilledValue(String(null)), true, '字符串 "null" 属非空串,此处只用于说明历史坑的成因');
});

test('gravePlotBody: 下葬形态剔除销售侧字段但保留安葬者字段直写', () => {
  const body = fullBody();
  stripBuriedFormFields(body);
  // 仅剔除 payer/payerPhone/payerIDCard/realPrice/realPriceString/payee/serialNo 七项(与原本地副本逐字一致),
  // 安葬者字段本就落在 buried 表,因此不得被误删(历史上已发生过一次“误删致记录丢失”),
  assert.deepStrictEqual(remainingKeys(body), [
    'burialDate', 'contacts', 'contactsIDCard', 'contactsPhone', 'contactsphone', 'deathDate',
    'deceased', 'deceasedIDCard', 'deceasedRelation', 'idBusiness', 'idRoom', 'remark', 'type',
  ]);
});

test('gravePlotBody: 预定形态映射 liaison 并剔除 reserve 表没有的跨表列', () => {
  const inserted = fullBody();
  prepareReserveFormBody(inserted, false);
  assert.strictEqual(inserted.liaison, '张三');
  assert.strictEqual(inserted.liaisonPhone, '13800138000');
  // 新建分支:外键 idRoom 需写入,不得剔除;其余非 reserve 列一律剔除——
  // 20261026 修复:此前新建分支保留联系人三字段且两个分支都漏剔 deathDate,前端统一业务模型提交时
  // 这些键会被拼进 INSERT 列清单,MySQL 直接报未知列(前端只看到 Internal server error),
  assert.ok('idRoom' in inserted, '新建预定不应剔除 idRoom(外键需要写入)');
  ['payer', 'payerPhone', 'payerIDCard', 'realPrice', 'realPriceString', 'payee', 'serialNo',
    'deceased', 'deathDate', 'burialDate', 'deceasedIDCard', 'deceasedRelation',
    'contacts', 'contactsphone', 'contactsPhone', 'contactsIDCard'].forEach((key) => {
    assert.ok(!(key in inserted), `新建预定应剔除 ${key}`);
  });
  // 剩余键集合必须恰为 reserve 表真实列(外加由 handler 删除的 idBusiness/type),
  assert.deepStrictEqual(remainingKeys(inserted), ['idBusiness', 'idRoom', 'liaison', 'liaisonPhone', 'remark', 'type']);

  const updated = fullBody();
  prepareReserveFormBody(updated, true);
  assert.strictEqual(updated.liaison, '张三');
  // 修改分支墓位不变:外键 idRoom 不得进 SET,其余剔除口径与新建一致,
  assert.deepStrictEqual(remainingKeys(updated), ['idBusiness', 'liaison', 'liaisonPhone', 'remark', 'type']);
});

test('gravePlotBody: 安葬证形态剔除业务字段,修改分支额外剔除 idRoom', () => {
  const inserted = fullBody();
  prepareCertificateFormBody(inserted, false);
  ['payer', 'payerPhone', 'payerIDCard', 'realPrice', 'realPriceString', 'payee', 'deceased', 'deceasedIDCard', 'contacts', 'contactsphone', 'contactsIDCard'].forEach((key) => {
    assert.ok(!(key in inserted), `新建安葬证应剔除 ${key}`);
  });
  assert.ok('idRoom' in inserted, '新建安葬证不剔除 idRoom(外键需要写入)');

  const updated = fullBody();
  prepareCertificateFormBody(updated, true);
  assert.ok(!('idRoom' in updated), '修改安葬证应剔除 idRoom');
});

test('gravePlotBody: 默认业务形态剔除安葬者与联系人字段', () => {
  const body = fullBody();
  stripDefaultFormFields(body);
  ['deceased', 'burialDate', 'deceasedIDCard', 'deceasedRelation', 'contacts', 'contactsphone', 'contactsIDCard'].forEach((key) => {
    assert.ok(!(key in body), `默认形态应剔除 ${key}`);
  });
  ['payer', 'serialNo', 'realPrice', 'remark', 'idRoom'].forEach((key) => {
    assert.ok(key in body, `默认形态不应剔除 ${key}`);
  });
});
