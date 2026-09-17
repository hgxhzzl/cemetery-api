const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 删除下葬:软删除选中的下葬记录(按 idBuried);若该墓位已无其他活动下葬记录,
// 则把墓位下葬状态回置为未下葬,事务保证两表一致 20260907 新增,
router.get('/', async (req, res) => {
  const idBuried = public.parseNumericParam(req.query.idBuried);
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idBuried === null) {
    return res.status(400).json({ error: 'idBuried参数错误!' });
  }
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 软删除选中的下葬记录(idBuried 已校验为纯数字,拼接安全)
  const buriedJson = {
    table: req.data.dataBase + '.buried',
    idfield: 'idBuried',
    idvalue: idBuried,
    isDeleted: 1,
    operator: req.data.userName,
  };
  const sqlBuried = public.getUpdateByIdStatement(buriedJson);
  const sqlList = [sqlBuried];

  // 查询删除后该墓位是否仍有其他活动下葬记录,无则回置墓位为未下葬
  const countSql =
    `select count(*) as cnt from ${req.data.dataBase}.buried ` +
    `where isDeleted = 0 and idRoom = ? and idBuried <> ?`;

  let oldRow = null;
  let countResults = [];
  try {
    // 先取删除前的联系人/电话,用于定位需同步软删的联系人 20260916 新增,
    const oldRows = await pool.query(
      `select contacts, contactsphone from ${req.data.dataBase}.buried where idBuried = ? and isDeleted = 0 limit 1`,
      [idBuried],
    );
    oldRow = oldRows && oldRows.length > 0 ? oldRows[0] : null;
    countResults = await pool.query(countSql, [idRoom, idBuried]);
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  const remain = countResults && countResults.length > 0 ? Number(countResults[0].cnt) : 0;
  if (remain === 0) {
    const roomJson = {
      table: req.data.dataBase + '.room',
      operator: req.data.userName,
      idfield: 'idRoom',
      idvalue: idRoom,
      intoStatus: 'statusType.intoStatusEnum.incomplet',
    };
    sqlList.push(public.getUpdateByIdStatement(roomJson));
    // 已无活动下葬记录:管理费起止日期一并清空 20260910 新增,
    sqlList.push({
      sql: `update ${req.data.dataBase}.room set startDate = null, endDate = null where idRoom = ?`,
      params: [idRoom],
    });
  } else {
    // 删除的可能是最早下葬记录:开始日期按剩余活动记录重新锚定;结束日期不动(保留收款顺延值) 20260910 新增,
    sqlList.push({
      sql:
        `update ${req.data.dataBase}.room set ` +
        `startDate = (select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0) ` +
        `where idRoom = ?`,
      params: [idRoom, idRoom],
    });
  }

  // 删除的下葬记录含联系人时,同步软删 contacts 中 同墓位/同名 的活动联系人(电话非空时一并匹配),并同步 room.contacts 聚合 20260916 新增,
  const oldContacts = oldRow ? oldRow.contacts : null;
  const oldPhone = oldRow ? oldRow.contactsphone : null;
  if (oldContacts !== null && oldContacts !== undefined && String(oldContacts).trim() !== '') {
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
    sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
  }

  // 安葬者聚合:软删后按剩余活动下葬记录 deceased 空格分隔同步到 room.deceased 20260917 新增,
  sqlList.push(public.getRoomDeceasedSyncSql(req.data.dataBase, idRoom));

  return public.Transaction(sqlList, res);
});

