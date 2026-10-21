const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 删除下葬:软删除选中的下葬记录(按 idBuried);若该墓位已无其他活动下葬记录,
// 则把墓位下葬状态回置为未下葬,事务保证两表一致 20260907 新增,
router.post('/', async (req, res) => {
  const idBuried = public.parseNumericParam(public.readParam(req, 'idBuried'));
  const idRoom = public.parseNumericParam(public.readParam(req, 'idRoom'));
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
  const sqlBuried = public.getSoftDeleteByIdStatement(buriedJson);
  const sqlList = [sqlBuried];

  // 删除后该墓位是否仍有其他活动下葬记录,以及剩余活动下葬的最早日期:均在事务内统计(见下方费用链例程) 20261021 调整,

  let oldRow = null;
  try {
    // 先取删除前的联系人/电话,用于定位需同步软删的联系人 20260916 新增,
    const oldRows = await pool.query(
      `select contacts, contactsphone from ${req.data.dataBase}.buried where idBuried = ? and isDeleted = 0 limit 1`,
      [idBuried],
    );
    oldRow = oldRows && oldRows.length > 0 ? oldRows[0] : null;
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  // 下葬删除后统一维护管理期限(⑤):以剩余活动下葬记录最早日期为链首(归零则 anchorDay=null→起止置空、adminfee 记录保留);
  // 无收款仅置 startDate/endDate=min,有收款整链重排 20261018 新增,
  // 20261021 审查修复中C:剩余下葬统计、墓位状态回置、期限重排的读与写一并收进同一事务(先锁墓位行串行化同墓位费用链),
  // 原先在事务外读计数再在事务内写回,并发删除时后来者拿旧快照覆写会丢更新;同时修正原先链首日期在软删前取值、
  // 把本次被删记录的日期也算进去的偏差,
  sqlList.push(async (conn) => {
    await public.runFeeChainTx(conn, {
      dataBase: req.data.dataBase,
      idRoom,
      operator: req.data.userName,
      remainSql:
        `select count(*) as cnt, min(burialDate) as minBurial from ${req.data.dataBase}.buried ` +
        `where isDeleted = 0 and idRoom = ? and idBuried <> ?`,
      remainParams: [idRoom, idBuried],
      onRemain: async (connection, remain) => {
        if (remain === 0) {
          // 已无其他活动下葬记录:墓位下葬状态回置未完成 20260907 保留,
          await public.execWith(connection, [public.getUpdateByIdStatement({
            table: req.data.dataBase + '.room',
            operator: req.data.userName,
            idfield: 'idRoom',
            idvalue: idRoom,
            intoStatus: 'statusType.intoStatusEnum.incomplet',
          })]);
        }
      },
    });
  });

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
    sqlList.push(public.getSoftDeleteByConditionStatement({
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

