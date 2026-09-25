const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 删除墓位业务:业务形态仅软删本业务表记录,不回置墓位销售状态(与墓位销售完全独立) 20260923 新增,
// 下葬形态(type=buried):软删选中的下葬记录(按 idBuried),联动逻辑完整复制下葬页但代码独立 20260923 新增,
router.get('/', async (req, res) => {
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 下葬形态：删除单条下葬记录（参数与逻辑同下葬页删除接口，代码独立不复用 buried 模块路由）
  if (req.query.type === 'buried') {
    return deleteBuriedRecord(req, res, idRoom);
  }

  // 联系人形态(type=contacts):按 idContacts 软删选中的联系人记录,同步 room.contacts 聚合(同墓位联系人页,代码独立) 20260924 新增,
  if (req.query.type === 'contacts') {
    const idContacts = public.parseNumericParam(req.query.idContacts);
    if (idContacts === null) {
      return res.status(400).json({ error: 'idContacts参数错误!' });
    }
    const json = {
      table: req.data.dataBase + '.contacts',
      idfield: 'idContacts',
      idvalue: idContacts,
      isDeleted: 1,
      operator: req.data.userName,
    };
    const statement = public.getUpdateByIdStatement(json);
    return public.Transaction([statement, public.getRoomContactsSyncSql(req.data.dataBase, idRoom)], res);
  }

  // 业务形态:软删除该墓位的活动墓位业务记录(idRoom 已校验为纯数字,参数化传递)
  const json = {
    table: req.data.dataBase + '.graveplotbusiness',
    condition: { sql: 'idRoom = ? AND isDeleted = 0', params: [idRoom] },
    isDeleted: 1,
    operator: req.data.userName,
  };
  const sql = public.getUpdateByConditionStatement(json);
  return public.Transaction([sql], res);
});

// 删除下葬记录:软删选中记录(按 idBuried);若该墓位已无其他活动下葬记录,
// 则把墓位下葬状态回置为未下葬并清空管理费起止日期,事务保证多表一致 20260923 新增,
async function deleteBuriedRecord(req, res, idRoom) {
  const idBuried = public.parseNumericParam(req.query.idBuried);
  if (idBuried === null) {
    return res.status(400).json({ error: 'idBuried参数错误!' });
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
    // 先取删除前的联系人/电话,用于定位需同步软删的联系人
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
    // 已无活动下葬记录:管理费起止日期一并清空
    sqlList.push({
      sql: `update ${req.data.dataBase}.room set startDate = null, endDate = null where idRoom = ?`,
      params: [idRoom],
    });
  } else {
    // 删除的可能是最早下葬记录:开始日期按剩余活动记录重新锚定;结束日期不动(保留收款顺延值)
    sqlList.push({
      sql:
        `update ${req.data.dataBase}.room set ` +
        `startDate = (select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0) ` +
        `where idRoom = ?`,
      params: [idRoom, idRoom],
    });
  }

  // 删除的下葬记录含联系人时,同步软删 contacts 中 同墓位/同名 的活动联系人(电话非空时一并匹配),并同步 room.contacts 聚合
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

  // 安葬者聚合:软删后按剩余活动下葬记录 deceased 空格分隔同步到 room.deceased
  sqlList.push(public.getRoomDeceasedSyncSql(req.data.dataBase, idRoom));

  return public.Transaction(sqlList, res);
}

