const express = require('express');
const router = express.Router();
const public = require('../public');
module.exports = router;

// 管理费期限链式顺延辅助函数已提升至 public.js（fmtFeeDay/feeDayStr/computeFeePeriodCascade/findFeePeriodAnchor/listActiveFeeRows），新建/修改/删除各入口共用同一口径 20261018 重构,

// 新建管理费收款:插入一条收款记录;管理费与墓位下葬状态无关,不改墓位状态 20260909 新增,
router.post('/insert', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 收款前置校验(⑤):缴费年限为空/0 一律拒绝提交,须大于 0 20261018 新增,
  const termYearsNum = Number(req.body.termYears);
  if (!Number.isFinite(termYearsNum) || termYearsNum <= 0) {
    return res.status(400).json({ error: '缴费年限必须大于0，请重新填写!' });
  }

  // 收款前置校验(②):新建收款须该墓位已有活动下葬记录,无下葬不可收款 20261018 新增,
  try {
    const hasBurial = await public.hasActiveBurial(req.data.dataBase, idRoom);
    if (!hasBurial) {
      return res.status(400).json({ error: '该墓位尚无下葬记录，请先登记下葬后再收取管理费!' });
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  // 联系人同步所需值:付款人/电话/身份证号(库列原始拼写 payePrhone),浅拷贝语句函数不变更 req.body,此处先捕获 20261017 新增,
  const contactsName = req.body.payer;
  const contactsPhone = req.body.payePrhone;
  const contactsIDCard = req.body.payerIDCard;

  req.body.table = req.data.dataBase + '.adminfee';
  req.body.operator = req.data.userName;
  // idAdminfee 为自增主键,新建时剔除,由数据库自增 20260910 修改
  delete req.body.idAdminfee;

  const sqlList = [];
  let cascadeDone = false;
  try {
    // 期限链式顺延：已有活动记录 + 本次新增(创建日期最新恒为链尾)一并计算，
    // 本条起止日期以链值覆盖后再写库，历史记录偏离链值的一并出更新语句 20261018 新增,
    const anchorDay = await public.findFeePeriodAnchor(req.data.dataBase, idRoom, req.body.startDate);
    const existingRows = await public.listActiveFeeRows(req.data.dataBase, idRoom);
    if (anchorDay) {
      const pending = { pendingInsert: true, termYears: req.body.termYears, endDate: req.body.endDate };
      const { targets, tailDate } = public.computeFeePeriodCascade(anchorDay, [...(existingRows || []), pending]);
      const mine = targets[targets.length - 1];
      req.body.startDate = mine.startDate;
      req.body.endDate = mine.endDate;
      targets.slice(0, -1).forEach(({ row, startDate: startStr, endDate: endStr }) => {
        if (public.feeDayStr(row.startDate) !== startStr || public.feeDayStr(row.endDate) !== endStr) {
          sqlList.push(public.getUpdateByIdStatement({
            table: req.data.dataBase + '.adminfee',
            idfield: 'idAdminfee',
            idvalue: row.idAdminfee,
            startDate: startStr,
            endDate: endStr,
            operator: req.data.userName,
          }));
        }
      });
      sqlList.push(public.getInsertStatement(req.body));
      sqlList.push({
        sql: `update ${req.data.dataBase}.room set startDate = coalesce((select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0), startDate, ?), endDate = ? where idRoom = ?`,
        params: [idRoom, public.fmtFeeDay(anchorDay), tailDate, idRoom],
      });
      cascadeDone = true;
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  if (!cascadeDone) {
    // 无锚定兜底(room 与本条均无开始日,理论上前端已必填不会出现)：维持旧口径直写 20261018 补充,
    sqlList.push(public.getInsertStatement(req.body));
    sqlList.push({
      sql: `update ${req.data.dataBase}.room set startDate = coalesce(startDate, ?), endDate = ? where idRoom = ?`,
      params: [req.body.startDate ?? null, req.body.endDate ?? null, idRoom],
    });
  }

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

  // 收款前置校验(⑤):修改时缴费年限同样不得为空/0,须大于 0 20261018 新增,
  const termYearsNum = Number(req.body.termYears);
  if (!Number.isFinite(termYearsNum) || termYearsNum <= 0) {
    return res.status(400).json({ error: '缴费年限必须大于0，请重新填写!' });
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

  const sqlList = [];
  let cascadeDone = false;
  try {
    // 期限链式顺延(同新建)：本条年限以本次提交新值参与计算(库中旧行尚未更新)，
    // 起止日期完全交给链重排——body 不再携带日期，避免同事务双写互相覆盖 20261018 新增,
    const anchorDay = await public.findFeePeriodAnchor(req.data.dataBase, idRoom, req.body.startDate);
    const existingRows = await public.listActiveFeeRows(req.data.dataBase, idRoom);
    if (anchorDay) {
      const mineRow = (existingRows || []).find((item) => String(item.idAdminfee) === String(idAdminfee));
      if (mineRow) {
        mineRow.termYears = req.body.termYears;
      }
      const { targets, tailDate } = public.computeFeePeriodCascade(anchorDay, existingRows || []);
      targets.forEach(({ row, startDate: startStr, endDate: endStr }) => {
        if (public.feeDayStr(row.startDate) !== startStr || public.feeDayStr(row.endDate) !== endStr) {
          sqlList.push(public.getUpdateByIdStatement({
            table: req.data.dataBase + '.adminfee',
            idfield: 'idAdminfee',
            idvalue: row.idAdminfee,
            startDate: startStr,
            endDate: endStr,
            operator: req.data.userName,
          }));
        }
      });
      delete req.body.startDate;
      delete req.body.endDate;
      sqlList.push(public.getUpdateByIdStatement(req.body));
      sqlList.push({
        sql: `update ${req.data.dataBase}.room set startDate = coalesce((select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0), startDate, ?), endDate = ? where idRoom = ?`,
        params: [idRoom, public.fmtFeeDay(anchorDay), tailDate, idRoom],
      });
      cascadeDone = true;
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  if (!cascadeDone) {
    // 无锚定兜底：维持旧口径——按 body 直写并覆盖 room.endDate 20261018 补充,
    sqlList.push(public.getUpdateByIdStatement(req.body));
    sqlList.push({
      sql: `update ${req.data.dataBase}.room set startDate = coalesce(startDate, ?), endDate = ? where idRoom = ?`,
      params: [req.body.startDate ?? null, req.body.endDate ?? null, idRoom],
    });
  }

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
