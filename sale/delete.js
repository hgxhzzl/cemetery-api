const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 删除销售:软删该墓位活动销售记录 + 墓位销售状态回置未销售 + 同步软删 contacts(idRoom 相等且 联系人=付款人),事务一致 20260909 修改;
// ④ 连带软删该销售派生的下葬记录(buried.idSale 归属本次销售),并按剩余活动下葬跑下葬例程A(重排/归零软删 adminfee、维护 room 起止) 20261018 新增,
router.post('/', async (req, res) => {
  const idRoom = public.parseNumericParam(public.readParam(req, 'idRoom'));
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  const dataBase = req.data.dataBase;
  const saleTable = dataBase + '.sale';
  const buriedTable = dataBase + '.buried';
  try {
    // 取该墓位活动销售记录:付款人用于联系人同步软删,idSale 用于连带软删该销售派生的下葬记录 20260909 新增 20261018 ④ 扩展取 idSale,
    const saleRows = await pool.query(`SELECT idSale, payer FROM ${saleTable} WHERE idRoom = ? AND isDeleted = 0`, [idRoom]);
    const payer = saleRows && saleRows.length > 0 ? saleRows[0].payer : null;
    const saleIds = (saleRows || []).map((row) => Number(row.idSale)).filter((n) => Number.isFinite(n) && n > 0);

    // 软删除该墓位的活动销售记录(idRoom 已校验为纯数字,参数化传递)
    const sqlSale = public.getSoftDeleteByConditionStatement({
      table: saleTable,
      condition: { sql: 'idRoom = ? AND isDeleted = 0', params: [idRoom] },
      isDeleted: 1,
      operator: req.data.userName,
    });

    // 墓位销售状态回置:未销售,与销售开单时的置位互为逆操作;同步清空购墓人与编号 20260916/20260922 修改 20261003 cardno→serialNo,
    const sqlRoom = public.getUpdateByIdStatement({
      table: dataBase + '.room',
      operator: req.data.userName,
      idfield: 'idRoom',
      idvalue: idRoom,
      saleStatus: 'statusType.saleStatusEnum.unsold',
      buyer: '',
      serialNo: '',
    });

    const sqlList = [sqlSale];

    // ④ 连带软删该销售派生的下葬记录(仅按 idSale 归属精确锁定,不动其它来源登记的下葬) 20261018 新增,
    if (saleIds.length > 0) {
      const delPlaceholders = saleIds.map(() => '?').join(',');
      sqlList.push({
        sql: `update ${buriedTable} set isDeleted = 1, operator = ?, modifyDate = ? where idRoom = ? and isDeleted = 0 and idSale in (${delPlaceholders})`,
        params: [req.data.userName, public.getCurrentDateTime(), idRoom, ...saleIds],
      });
    }

    sqlList.push(sqlRoom);

    // 管理期限统一维护(并入下葬例程A):anchorDay 为空(归零)→起止置空且软删活动 adminfee;有收款整链重排、无收款置 startDate=endDate=min 20261018 ④ 新增,
    // 20261021 审查修复中C:剩余活动下葬统计、墓位下葬状态回置、期限重排的读与写收进同一事务(先锁墓位行串行化同墓位费用链),
    // 原先在事务外读计数再事务内写回,并发时后来者拿旧快照全量覆写会丢更新;派生下葬已在同一事务内软删,
    // 因此计数不再需要 idSale 排除条件(与旧口径等价),
    sqlList.push(async (conn) => {
      await public.runFeeChainTx(conn, {
        dataBase,
        idRoom,
        operator: req.data.userName,
        remainSql: `select count(*) as cnt, min(burialDate) as minBurial from ${buriedTable} where idRoom = ? and isDeleted = 0`,
        remainParams: [idRoom],
        onRemain: async (connection, remain) => {
          // 剩余无活动下葬:墓位下葬状态回置未完成(与销带下葬置位互为逆操作) 20261018 ④ 保留,
          if (saleIds.length > 0 && remain === 0) {
            await public.execWith(connection, [public.getUpdateByIdStatement({
              table: dataBase + '.room',
              operator: req.data.userName,
              idfield: 'idRoom',
              idvalue: idRoom,
              intoStatus: 'statusType.intoStatusEnum.incomplet',
            })]);
          }
        },
      });
    });

    // 安葬者聚合:软删派生下葬后按剩余活动下葬 deceased 空格分隔同步 room.deceased 20261018 ④ 新增,
    sqlList.push(public.getRoomDeceasedSyncSql(dataBase, idRoom));

    // 付款人存在时,同步软删 contacts 表中 idRoom 相等且 联系人=付款人 的记录 20260909 新增,
    if (payer !== null && payer !== undefined && String(payer).trim() !== '') {
      sqlList.push(public.getSoftDeleteByConditionStatement({
        table: dataBase + '.contacts',
        condition: { sql: 'idRoom = ? AND contacts = ? AND isDeleted = 0', params: [idRoom, payer] },
        isDeleted: 1,
        operator: req.data.userName,
      }));
      // 联系人软删后同步 room.contacts 聚合字段(全部活动联系人空格分隔) 20260917 新增,
      sqlList.push(public.getRoomContactsSyncSql(dataBase, idRoom));
    }

    return public.Transaction(sqlList, res);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});

