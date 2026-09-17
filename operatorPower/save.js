const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

const allowedFields = new Set([
  'useMenu',
  'useCreate',
  'useModify',
  'useDelete',
  'useExamine',
  'useFinish',
  'usePower',
]);

router.post('/power', async (req, res) => {
  const field = req.body.field;
  const idPower = public.parseNumericParam(req.body.idPower);

  if (!allowedFields.has(field)) {
    return res.status(400).json({ error: 'Invalid field' });
  }

  if (idPower === null) {
    return res.status(400).json({ error: 'idPower参数错误!' });
  }

  // 非平台管理员仅可切换本租户操作员的权限 20260917 越权收口,
  const tenantSql = rbac.isPlatformAdmin(req)
    ? 'where idPower = ?'
    : 'where idPower = ? and idOperator in (select idOperator from gm_data_000.operator where dataBaseName = ?)';
  const sqlParams = rbac.isPlatformAdmin(req) ? [idPower] : [idPower, req.data.dataBase];
  const sql = `update gm_data_000.operator_power
    set ${field} = case when ${field} = 1 then 0 else 1 end
    ${tenantSql}`;

  try {
    const results = await pool.query(sql, sqlParams);
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
})
