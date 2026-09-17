const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 删除迁出:软删除选中的迁出记录(按 idTransfer);若该墓位已无其他活动迁出记录,
// 则把墓位迁出状态回置为未迁出,事务保证两表一致 20260916 新增,
router.get('/', async (req, res) => {
  const idTransfer = public.parseNumericParam(req.query.idTransfer);
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idTransfer === null) {
    return res.status(400).json({ error: 'idTransfer参数错误!' });
  }
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 软删除选中的迁出记录(idTransfer 已校验为纯数字,拼接安全)
  const transferJson = {
    table: req.data.dataBase + '.transfer_out',
    idfield: 'idTransfer',
    idvalue: idTransfer,
    isDeleted: 1,
    operator: req.data.userName,
  };
  const sqlTransfer = public.getUpdateByIdStatement(transferJson);
  const sqlList = [sqlTransfer];

  // 查询删除后该墓位是否仍有其他活动迁出记录,无则回置墓位为未迁出
  const countSql =
    `select count(*) as cnt from ${req.data.dataBase}.transfer_out ` +
    `where isDeleted = 0 and idRoom = ? and idTransfer <> ?`;

  try {
    const results = await pool.query(countSql, [idRoom, idTransfer]);

    const remain = results && results.length > 0 ? Number(results[0].cnt) : 0;
    if (remain === 0) {
      const roomJson = {
        table: req.data.dataBase + '.room',
        operator: req.data.userName,
        idfield: 'idRoom',
        idvalue: idRoom,
        transferOutStatus: 'statusType.transferOutStatusEnum.notOut',
      };
      sqlList.push(public.getUpdateByIdStatement(roomJson));
    }

    return public.Transaction(sqlList, res);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
