const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');

module.exports = router;

// 全局管理接口:账户权限切换仅平台管理员可操作 20260917 越权收口,
router.use(rbac.requirePlatformAdmin);

router.post('/power', async (req, res) => {
  const idMenu = public.parseNumericParam(req.body.idMenu);
  if (idMenu === null) {
    return res.status(400).json({ error: 'idMenu参数错误!' });
  }

  const sql = `update gm_data_000.account_power
    set useMenu = case when useMenu = 1 then 0 else 1 end
    where dataBaseName = ? and idMenu = ? and isDeleted = 0`;

  try {
    const results = await pool.query(sql, [req.body.dataBaseName, idMenu]);
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
})
