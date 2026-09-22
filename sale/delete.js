const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 删除销售:软删该墓位活动销售记录 + 墓位销售状态回置未销售 + 同步软删 contacts(idRoom 相等且 联系人=付款人),事务一致 20260909 修改,
router.get('/', async (req, res) => {
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  const saleTable = req.data.dataBase + '.sale';
  // 先取活动销售记录的付款人,用于按 idRoom + 联系人=付款人 定位需同步软删的联系人 20260909 新增,
  try {
    const results = await pool.query(`SELECT payer FROM ${saleTable} WHERE idRoom = ? AND isDeleted = 0 LIMIT 1`, [idRoom]);
    const payer = results && results.length > 0 ? results[0].payer : null;

    // 软删除该墓位的活动销售记录(idRoom 已校验为纯数字,参数化传递)
    const saleJson = {
      table: saleTable,
      condition: { sql: 'idRoom = ? AND isDeleted = 0', params: [idRoom] },
      isDeleted: 1,
      operator: req.data.userName,
    };
    const sqlSale = public.getUpdateByConditionStatement(saleJson);

    // 墓位销售状态回置:未销售,与销售开单时的置位互为逆操作;同步清空购买人与卡号 20260916/20260922 修改,
    const roomJson = {
      table: req.data.dataBase + '.room',
      operator: req.data.userName,
      idfield: 'idRoom',
      idvalue: idRoom,
      saleStatus: 'statusType.saleStatusEnum.unsold',
      buyer: '',
      cardno: '',
    };
    const sqlRoom = public.getUpdateByIdStatement(roomJson);

    const sqlList = [sqlSale, sqlRoom];

    // 付款人存在时,同步软删 contacts 表中 idRoom 相等且 联系人=付款人 的记录 20260909 新增,
    if (payer !== null && payer !== undefined && String(payer).trim() !== '') {
      const contactsJson = {
        table: req.data.dataBase + '.contacts',
        condition: { sql: 'idRoom = ? AND contacts = ? AND isDeleted = 0', params: [idRoom, payer] },
        isDeleted: 1,
        operator: req.data.userName,
      };
      sqlList.push(public.getUpdateByConditionStatement(contactsJson));
      // 联系人软删后同步 room.contacts 聚合字段(全部活动联系人空格分隔) 20260917 新增,
      sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
    }

    return public.Transaction(sqlList, res);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});

