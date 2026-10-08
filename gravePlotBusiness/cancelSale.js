const express = require('express');
const router = express.Router();
const public = require('../public');
module.exports = router;

// 销售取消：平台管理员作废某墓位的销售业务。按 idRoom 软删该墓位关联的 6 张业务表活动记录
// (sale/buried/contacts/adminfee/burial_cert/period_change，条件 isDeleted=0)，
// 并将 room 回置为未销售/未下葬、清空编号/管理费起止日期/购墓人/安葬者/联系人/备注，
// 全部语句单事务执行保证多表一致 20261008 新增,
router.get('/', async (req, res) => {
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  const dataBase = req.data.dataBase;
  const operator = req.data.userName;

  // 关联业务表软删：逐表按 idRoom 且 isDeleted=0 置 isDeleted=1 20261008 新增,
  const softDeleteTables = ['sale', 'buried', 'contacts', 'adminfee', 'burial_cert', 'period_change'];
  const sqlList = softDeleteTables.map((table) =>
    public.getUpdateByConditionStatement({
      table: `${dataBase}.${table}`,
      condition: { sql: 'idRoom = ? AND isDeleted = 0', params: [idRoom] },
      isDeleted: 1,
      operator,
    }),
  );

  // room 回置：销售状态未售、下葬状态未完成，清空编号/购墓人/安葬者/联系人/备注；
  // startDate/endDate 传 null 由公共函数参数化写入 NULL 20261008 新增,
  sqlList.push(
    public.getUpdateByIdStatement({
      table: `${dataBase}.room`,
      idfield: 'idRoom',
      idvalue: idRoom,
      operator,
      saleStatus: 'statusType.saleStatusEnum.unsold',
      intoStatus: 'statusType.intoStatusEnum.incomplet',
      serialNo: '',
      startDate: null,
      endDate: null,
      buyer: '',
      deceased: '',
      contacts: '',
      remark: '',
    }),
  );

  return public.Transaction(sqlList, res);
});

