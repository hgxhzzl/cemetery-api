const express = require('express');
const router = express.Router();
const public = require('../public');
module.exports = router;

// 修改管理期限：period_change 新增变更记录并同步更新 room.endDate，两操作同事务保证一致 20260915 新增
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  const newEndDate = String(req.body.newEndDate || '').trim();
  if (!newEndDate) {
    return res.status(400).json({ error: 'newEndDate参数错误!' });
  }

  const dataBase = req.data.dataBase;

  // 变更记录：idRoom/新旧结束日期/原因，operator 取当前登录操作人名，modifyDate/createDate 由公共函数自动填充 20260915 新增
  const changeBody = {
    table: dataBase + '.period_change',
    idRoom: Number(idRoom),
    oldEndDate: req.body.oldEndDate || null,
    newEndDate,
    isDeleted: 0,
    operator: req.data.userName,
    reason: String(req.body.reason || '').trim(),
  };
  const changeStatement = public.getInsertStatement(changeBody);

  // 同步墓位管理费结束日期为新结束日期 20260915 新增
  const roomSql = 'update ' + dataBase + '.room set endDate = ? where idRoom = ?';
  const roomParams = [newEndDate, idRoom];

  return public.Transaction([changeStatement, { sql: roomSql, params: roomParams }], res);
});
