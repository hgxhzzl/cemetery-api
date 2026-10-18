const express = require('express');
const router = express.Router();
const public = require('../public');
module.exports = router;

// 新建管理费收款:插入一条收款记录;管理费与墓位下葬状态无关,不改墓位状态 20260909 新增,
router.post('/insert', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 联系人同步所需值:付款人/电话/身份证号(库列原始拼写 payePrhone),浅拷贝语句函数不变更 req.body,此处先捕获 20261017 新增,
  const contactsName = req.body.payer;
  const contactsPhone = req.body.payePrhone;
  const contactsIDCard = req.body.payerIDCard;

  req.body.table = req.data.dataBase + '.adminfee';
  req.body.operator = req.data.userName;
  // idAdminfee 为自增主键,新建时剔除,由数据库自增 20260910 修改
  delete req.body.idAdminfee;

  const statement = public.getInsertStatement(req.body);
  const sqlList = [statement];

  // 同步墓位管理费起止日期:开始日期为空时兜底锚定本次收款开始日期;结束日期=本次收款顺延后的结束日期 20260910 新增,
  const roomDateSql =
    `update ${req.data.dataBase}.room set startDate = coalesce(startDate, ?), endDate = ? where idRoom = ?`;
  sqlList.push({ sql: roomDateSql, params: [req.body.startDate ?? null, req.body.endDate ?? null, idRoom] });

  // 联系人同步:按 名/电话 匹配活动联系人执行新增/更新,并同步 room.contacts 聚合;口径同墓位下葬(buried/save.js) 20261017 新增,
  try {
    const contactsStatements = await public.buildContactsSyncStatements(
      req.data.dataBase, idRoom, contactsName, contactsPhone, contactsIDCard, req.data.userName,
    );
    if (contactsStatements.length > 0) {
      sqlList.push(...contactsStatements);
      sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  return public.Transaction(sqlList, res);
});

// 修改管理费收款:按 idAdminfee 更新选中的收款记录;管理费与墓位下葬状态无关,不改墓位状态 20260909 新增,
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idAdminfee = public.parseNumericParam(req.body.idAdminfee);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idAdminfee === null) {
    return res.status(400).json({ error: 'idAdminfee参数错误!' });
  }
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 联系人同步所需值:付款人/电话/身份证号(库列原始拼写 payePrhone),浅拷贝语句函数不变更 req.body,此处先捕获 20261017 新增,
  const contactsName = req.body.payer;
  const contactsPhone = req.body.payePrhone;
  const contactsIDCard = req.body.payerIDCard;

  req.body.table = req.data.dataBase + '.adminfee';
  req.body.operator = req.data.userName;
  req.body.idfield = 'idAdminfee';
  req.body.idvalue = idAdminfee;
  // idAdminfee 作为 where 条件,从 SET 子句剔除 20260910 修改
  delete req.body.idAdminfee;

  const statement = public.getUpdateByIdStatement(req.body);
  const sqlList = [statement];

  // 同步墓位管理费起止日期:开始日期为空时兜底锚定本次收款开始日期;结束日期=本次收款顺延后的结束日期 20260910 新增,
  const roomDateSql =
    `update ${req.data.dataBase}.room set startDate = coalesce(startDate, ?), endDate = ? where idRoom = ?`;
  sqlList.push({ sql: roomDateSql, params: [req.body.startDate ?? null, req.body.endDate ?? null, idRoom] });

  // 联系人同步:按 名/电话 匹配活动联系人执行新增/更新,并同步 room.contacts 聚合;口径同墓位下葬(buried/save.js) 20261017 新增,
  try {
    const contactsStatements = await public.buildContactsSyncStatements(
      req.data.dataBase, idRoom, contactsName, contactsPhone, contactsIDCard, req.data.userName,
    );
    if (contactsStatements.length > 0) {
      sqlList.push(...contactsStatements);
      sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  return public.Transaction(sqlList, res);
});
