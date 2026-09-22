const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 新建销售:插入销售记录 + 墓位置为已销售 + 同步向 contacts 新增一条联系人(付款人=联系人),三表事务一致 20260909 修改,
router.post('/insert', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 同步联系人所需字段,语句函数已浅拷贝化不再变更 req.body,此处捕获保留原始值供后续事务语句复用 20260917 优化,
  const payer = req.body.payer;
  const payerPhone = req.body.payerPhone;
  const payerIDCard = req.body.payerIDCard;
  const serialNo = req.body.serialNo;

  req.body.table = req.data.dataBase + '.sale';
  req.body.operator = req.data.userName;
  let price = req.body.realPrice.toString();
  price = price.replace(/,/g, '');
  req.body.realPrice = price;
  delete req.body.realPriceString;

  delete req.body.idSale;

  var sql = public.getInsertStatement(req.body);
  let sqlList = [];
  sqlList.push(sql);
  let json = {};
  json.table = req.data.dataBase + '.room';
  json.operator = req.data.userName;
  json.idfield = 'idRoom';
  json.idvalue = idRoom;
  json.saleStatus = 'statusType.saleStatusEnum.sold';
  // 同步 room.buyer = 付款人(可为空),与销售记录同事务 20260916 新增,
  json.buyer = payer === undefined || payer === null ? '' : payer;
  // 同步 room.cardno = 票据编号,与销售记录同事务 20260922 新增,
  json.cardno = serialNo === undefined || serialNo === null ? '' : serialNo;
  var sqlRoom = public.getUpdateByIdStatement(json);
  sqlList.push(sqlRoom);

  // 付款人非空时,同步向 contacts 表新增一条联系人:付款人=联系人,电话/付款人身份证号一并带入 20260909 新增,
  if (payer !== undefined && payer !== null && String(payer).trim() !== '') {
    const contactsJson = {
      table: req.data.dataBase + '.contacts',
      idRoom,
      contacts: payer,
      contactsPhone: payerPhone === undefined || payerPhone === null ? '' : payerPhone,
      contactsIDCard: payerIDCard === undefined || payerIDCard === null ? '' : payerIDCard,
      operator: req.data.userName,
    };
    sqlList.push(public.getInsertStatement(contactsJson));
    // 联系人新增后同步 room.contacts 聚合字段(全部活动联系人空格分隔) 20260917 新增,
    sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
  }

  return public.Transaction(sqlList, res);
});

// 修改销售:更新销售记录 + 同步对应联系人,事务一致 20260909 修改,
// 同步的联系人其名恒等于 sale.payer,故按“修改前的旧付款人名”定位联系人;付款人改名时把联系人名一并改为新付款人 20260909 修复,
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idSale = public.parseNumericParam(req.body.idSale);
  if (idSale === null) {
    return res.status(400).json({ error: 'idSale参数错误!' });
  }

  // 同步联系人所需的新值,语句函数已浅拷贝化不再变更 req.body,此处捕获保留原始值供后续事务语句复用 20260917 优化,
  const payer = req.body.payer;
  const payerPhone = req.body.payerPhone;
  const payerIDCard = req.body.payerIDCard;
  const serialNo = req.body.serialNo;

  req.body.table = req.data.dataBase + '.sale';
  req.body.operator = req.data.userName;
  delete req.body.realPriceString;
  //处理id
  req.body.idfield = 'idSale';
  req.body.idvalue = idSale;
  delete req.body.idSale;
  //
  const statement = public.getUpdateByIdStatement(req.body);

  const saleTable = req.data.dataBase + '.sale';
  // 先取修改前的旧付款人与 idRoom(此时 sale 尚未更新),用于按旧名定位需同步的联系人 20260909 修复,
  try {
    const results = await pool.query(`SELECT payer AS oldPayer, idRoom FROM ${saleTable} WHERE idSale = ? AND isDeleted = 0 LIMIT 1`, [idSale]);
    const row = results && results.length > 0 ? results[0] : null;
    const sqlList = [statement];

    const newPayerValid = payer !== undefined && payer !== null && String(payer).trim() !== '';
    const idRoom = row ? public.parseNumericParam(row.idRoom) : null;
    const oldPayer = row ? row.oldPayer : null;
    const oldPayerValid = oldPayer !== undefined && oldPayer !== null && String(oldPayer).trim() !== '';

    // 新付款人有效且能取到旧付款人/墓位时,按 idRoom 相等且 联系人=旧付款人 定位,更新联系人名(=新付款人)/电话/身份证号 20260909 修复,
    if (newPayerValid && idRoom !== null && oldPayerValid) {
      const contactsJson = {
        table: req.data.dataBase + '.contacts',
        condition: { sql: 'idRoom = ? AND contacts = ? AND isDeleted = 0', params: [idRoom, oldPayer] },
        contacts: payer,
        contactsPhone: payerPhone === undefined || payerPhone === null ? '' : payerPhone,
        contactsIDCard: payerIDCard === undefined || payerIDCard === null ? '' : payerIDCard,
        operator: req.data.userName,
      };
      sqlList.push(public.getUpdateByConditionStatement(contactsJson));
      // 联系人更新后同步 room.contacts 聚合字段(全部活动联系人空格分隔) 20260917 新增,
      sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
    }

    // 同步 room.buyer = 新付款人(可为空)与 room.cardno = 票据编号,与销售记录同事务 20260916/20260922 新增,
    if (idRoom !== null) {
      const roomJson = {
        table: req.data.dataBase + '.room',
        condition: { sql: 'idRoom = ? AND isDeleted = 0', params: [idRoom] },
        buyer: payer === undefined || payer === null ? '' : payer,
        cardno: serialNo === undefined || serialNo === null ? '' : serialNo,
        operator: req.data.userName,
      };
      sqlList.push(public.getUpdateByConditionStatement(roomJson));
    }

    return public.Transaction(sqlList, res);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
