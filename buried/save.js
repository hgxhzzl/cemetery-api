const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 新建下葬:插入一条下葬记录并把墓位下葬状态直接置为已下葬;取消预定/核对/完成状态机 20260907 修改,
router.post('/insert', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 联系人同步所需值,语句函数已浅拷贝化不再变更 req.body,此处捕获保留原始值供后续事务语句复用 20260917 优化,
  const contactsName = req.body.contacts;
  const contactsPhone = req.body.contactsphone !== undefined ? req.body.contactsphone : req.body.contactsPhone;
  const contactsIDCard = req.body.contactsIDCard;

  req.body.table = req.data.dataBase + '.buried';
  req.body.operator = req.data.userName;
  delete req.body.idBuried;

  const buriedStatement = public.getInsertStatement(req.body);
  const sqlList = [];
  sqlList.push(buriedStatement);

  // 下葬变动统一维护管理期限(⑤):变更后最早下葬日=min(现有活动下葬,本次新下葬日);无收款仅置 startDate/endDate=min,有收款整链重排 20261018 新增,
  // 20261021 审查修复中C:原先在事务外读链首日与收款行、事务内写重排结果,并发时后来者拿旧快照全量覆写会丢更新;
  // 改为函数型事务项——先进事务锁墓位行串行化同墓位费用链,再在事务内读后算再写,
  sqlList.push(async (conn) => {
    await public.lockFeeChainRoot(conn, req.data.dataBase, idRoom);
    const minRows = await public.queryWith(
      conn,
      `select min(burialDate) as minBurial from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0`,
      [idRoom],
    );
    const anchorDay = public.feeMinDay(
      minRows && minRows.length > 0 ? minRows[0].minBurial : null,
      req.body.burialDate,
    );
    await public.applyFeePeriodRecascadeTx(conn, req.data.dataBase, idRoom, req.data.userName, anchorDay);
  });

  // 置墓位已下葬 + 安葬者聚合（原下葬页既有动作，重构后保留） 20260907/20260917 保留,
  sqlList.push(public.getUpdateByIdStatement({
    table: req.data.dataBase + '.room',
    operator: req.data.userName,
    idfield: 'idRoom',
    idvalue: idRoom,
    intoStatus: 'statusType.intoStatusEnum.buried',
  }));
  sqlList.push(public.getRoomDeceasedSyncSql(req.data.dataBase, idRoom));

  // 联系人同步:按 名/电话 匹配活动联系人,执行 更新电话/更新姓名/新增,并同步 room.contacts 聚合 20260916 新增,
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

// 修改下葬:按 idBuried 更新选中的下葬记录,墓位保持已下葬;取消按复选框跳转状态 20260907 修改,
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idBuried = public.parseNumericParam(req.body.idBuried);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idBuried === null) {
    return res.status(400).json({ error: 'idBuried参数错误!' });
  }
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 联系人同步所需值,语句函数已浅拷贝化不再变更 req.body,此处捕获保留原始值供后续事务语句复用 20260917 优化,
  const contactsName = req.body.contacts;
  const contactsPhone = req.body.contactsphone !== undefined ? req.body.contactsphone : req.body.contactsPhone;
  const contactsIDCard = req.body.contactsIDCard;

  // 修改前旧联系人:同步后不再被新值引用时用于软删旧记录 20260916 新增,
  let oldContactsRow = null;
  try {
    const oldRows = await pool.query(
      `select contacts, contactsphone from ${req.data.dataBase}.buried where idBuried = ? and isDeleted = 0 limit 1`,
      [idBuried],
    );
    oldContactsRow = oldRows && oldRows.length > 0 ? oldRows[0] : null;
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  const sqlList = [];
  req.body.table = req.data.dataBase + '.buried';
  req.body.operator = req.data.userName;
  req.body.idfield = 'idBuried';
  req.body.idvalue = idBuried;
  delete req.body.idBuried;

  const buriedStatement = public.getUpdateByIdStatement(req.body);
  sqlList.push(buriedStatement);

  // 下葬变动统一维护管理期限(⑤):排除被改记录取其余最早下葬日再并入本次新下葬日;无收款仅置 startDate/endDate=min,有收款整链重排 20261018 新增,
  // 20261021 审查修复中C:同新建——读与写一并收进事务(先锁墓位行),
  sqlList.push(async (conn) => {
    await public.lockFeeChainRoot(conn, req.data.dataBase, idRoom);
    const minRows = await public.queryWith(
      conn,
      `select min(burialDate) as minBurial from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0 and idBuried <> ?`,
      [idRoom, idBuried],
    );
    const anchorDay = public.feeMinDay(
      minRows && minRows.length > 0 ? minRows[0].minBurial : null,
      req.body.burialDate,
    );
    await public.applyFeePeriodRecascadeTx(conn, req.data.dataBase, idRoom, req.data.userName, anchorDay);
  });

  // 修改不改变下葬状态,墓位保持已下葬 20260907 修改,
  const json = {};
  json.table = req.data.dataBase + '.room';
  json.operator = req.data.userName;
  json.idfield = 'idRoom';
  json.idvalue = idRoom;
  json.intoStatus = 'statusType.intoStatusEnum.buried';
  const sqlRoom = public.getUpdateByIdStatement(json);
  sqlList.push(sqlRoom);

  // 安葬者聚合:活动下葬记录 deceased 空格分隔同步到 room.deceased 20260917 新增,
  sqlList.push(public.getRoomDeceasedSyncSql(req.data.dataBase, idRoom));

  // 联系人同步:按 名/电话 匹配活动联系人,执行 更新电话/更新姓名/新增;
  // 同步后旧联系人不再被新值引用(改名/清空)时,软删旧记录避免残留 20260916 新增,
  try {
    let contactsChanged = false;
    const contactsStatements = await public.buildContactsSyncStatements(
      req.data.dataBase, idRoom, contactsName, contactsPhone, contactsIDCard, req.data.userName,
    );
    if (contactsStatements.length > 0) {
      sqlList.push(...contactsStatements);
      contactsChanged = true;
    }

    // 旧记录清理:新联系人名与旧名不同(含清空)时软删旧记录;
    // 改名不改电话时同步语句已把旧记录改名为新值,此处按旧名匹配不到活动记录,不产生额外影响,
    const oldContacts = oldContactsRow ? oldContactsRow.contacts : null;
    const oldPhone = oldContactsRow ? oldContactsRow.contactsphone : null;
    const oldContactsValid = oldContacts !== null && oldContacts !== undefined && String(oldContacts).trim() !== '';
    const newName = contactsName === undefined || contactsName === null ? '' : String(contactsName).trim();
    if (oldContactsValid && String(oldContacts).trim() !== newName) {
      const conditionParts = ['idRoom = ?', 'contacts = ?', 'isDeleted = 0'];
      const conditionParams = [idRoom, String(oldContacts).trim()];
      if (oldPhone !== null && oldPhone !== undefined && String(oldPhone).trim() !== '') {
        conditionParts.push('contactsPhone = ?');
        conditionParams.push(String(oldPhone).trim());
      }
      sqlList.push(public.getSoftDeleteByConditionStatement({
        table: req.data.dataBase + '.contacts',
        condition: { sql: conditionParts.join(' AND '), params: conditionParams },
        isDeleted: 1,
        operator: req.data.userName,
      }));
      contactsChanged = true;
    }

    // 联系人发生变更时,统一同步 room.contacts 聚合 20260916 新增,
    if (contactsChanged) {
      sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  return public.Transaction(sqlList, res);
});
