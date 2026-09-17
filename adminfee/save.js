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

  req.body.table = req.data.dataBase + '.adminfee';
  req.body.operator = req.data.userName;
  // idAdminfee 为自增主键,新建时剔除,由数据库自增 20260910 修改
  delete req.body.idAdminfee;

  const statement = public.getInsertStatement(req.body);

  // 同步墓位管理费起止日期:开始日期为空时兜底锚定本次收款开始日期;结束日期=本次收款顺延后的结束日期 20260910 新增,
  const roomDateSql =
    `update ${req.data.dataBase}.room set startDate = coalesce(startDate, ?), endDate = ? where idRoom = ?`;
  const roomDateParams = [req.body.startDate ?? null, req.body.endDate ?? null, idRoom];

  return public.Transaction([statement, { sql: roomDateSql, params: roomDateParams }], res);
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

  req.body.table = req.data.dataBase + '.adminfee';
  req.body.operator = req.data.userName;
  req.body.idfield = 'idAdminfee';
  req.body.idvalue = idAdminfee;
  // idAdminfee 作为 where 条件,从 SET 子句剔除 20260910 修改
  delete req.body.idAdminfee;

  const statement = public.getUpdateByIdStatement(req.body);

  // 同步墓位管理费起止日期:开始日期为空时兜底锚定本次收款开始日期;结束日期=本次收款顺延后的结束日期 20260910 新增,
  const roomDateSql =
    `update ${req.data.dataBase}.room set startDate = coalesce(startDate, ?), endDate = ? where idRoom = ?`;
  const roomDateParams = [req.body.startDate ?? null, req.body.endDate ?? null, idRoom];

  return public.Transaction([statement, { sql: roomDateSql, params: roomDateParams }], res);
});
