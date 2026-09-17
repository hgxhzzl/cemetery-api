const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 删除管理费收款:软删除选中的收款记录(按 idAdminfee 置 isDeleted=1);
// 删除后按剩余活动收款记录重算墓位管理费结束日期(无剩余则回退为开始日期) 20260910 修改,
router.get('/', async (req, res) => {
  const idAdminfee = public.parseNumericParam(req.query.idAdminfee);
  if (idAdminfee === null) {
    return res.status(400).json({ error: 'idAdminfee参数错误!' });
  }

  // 先取该收款记录所属墓位,供删除后重算 room 管理费结束日期 20260910 新增,
  const roomSql = `select idRoom from ${req.data.dataBase}.adminfee where idAdminfee = ?`;
  try {
    const results = await pool.query(roomSql, [idAdminfee]);

    const idRoom = results && results.length > 0 ? public.parseNumericParam(results[0].idRoom) : null;
    if (idRoom === null) {
      return res.status(400).json({ error: 'idRoom参数错误!' });
    }

    // 软删除选中的收款记录(idAdminfee 已校验为纯数字,拼接安全)
    const json = {
      table: req.data.dataBase + '.adminfee',
      idfield: 'idAdminfee',
      idvalue: idAdminfee,
      isDeleted: 1,
      operator: req.data.userName,
    };
    const statement = public.getUpdateByIdStatement(json);

    // 结束日期=剩余活动收款记录最大结束日期;无剩余记录回退为开始日期(旧值) 20260910 新增,
    const endDateSql =
      `update ${req.data.dataBase}.room set endDate = coalesce(` +
      `(select max(endDate) from ${req.data.dataBase}.adminfee where idRoom = ? and isDeleted = 0), ` +
      `startDate) where idRoom = ?`;

    return public.Transaction([statement, { sql: endDateSql, params: [idRoom, idRoom] }], res);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
