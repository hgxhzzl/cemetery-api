const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 构建联系人同步语句:同墓位活动联系人按 名/电话 匹配,联系人名/电话/身份证号一并同步 20260917 修改,
// 同名存在且电话/身份证号有变化则更新;同名不存在但同电话存在则更新联系人名与身份证号;名/电话均不存在则新增;联系人名为空不处理 20260916 新增,
async function buildContactsSyncStatements(dataBase, idRoom, contactsName, contactsPhone, contactsIDCard, operator) {
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
      return [public.getUpdateByConditionStatement({
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
    return [public.getUpdateByConditionStatement({
      table,
      condition: { sql: 'idContacts = ? AND isDeleted = 0', params: [samePhone.idContacts] },
      contacts: name,
      contactsIDCard: idCard,
      operator,
    })];
  }

  // 名/电话均不存在:新增一条联系人
  return [public.getInsertStatement({
    table,
    idRoom,
    contacts: name,
    contactsPhone: phone,
    contactsIDCard: idCard,
    operator,
  })];
}

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

  // 管理费起止日期锚定:开始日期=该墓位活动下葬记录最早下葬日期;结束日期仅在为空时取同值(不覆盖收款顺延后的日期) 20260910 新增,
  const anchorDateSql =
    `update ${req.data.dataBase}.room set ` +
    `startDate = (select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0), ` +
    `endDate = coalesce(endDate, (select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0)) ` +
    `where idRoom = ?`;
  sqlList.push({ sql: anchorDateSql, params: [idRoom, idRoom, idRoom] });

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

  // 联系人同步:按 名/电话 匹配活动联系人,执行 更新电话/更新姓名/新增,并同步 room.contacts 聚合 20260916 新增,
  try {
    const contactsStatements = await buildContactsSyncStatements(
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

  // 管理费起止日期锚定:开始日期=该墓位活动下葬记录最早下葬日期;结束日期仅在为空时取同值(不覆盖收款顺延后的日期) 20260910 新增,
  const anchorDateSql =
    `update ${req.data.dataBase}.room set ` +
    `startDate = (select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0), ` +
    `endDate = coalesce(endDate, (select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0)) ` +
    `where idRoom = ?`;
  sqlList.push({ sql: anchorDateSql, params: [idRoom, idRoom, idRoom] });

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
    const contactsStatements = await buildContactsSyncStatements(
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
      sqlList.push(public.getUpdateByConditionStatement({
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
