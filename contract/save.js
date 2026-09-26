const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

router.put('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  var idvalue = public.parseNumericParam(req.body.idContract);
  if (idvalue === null) {
    return res.status(400).json({ error: 'idContract参数错误!' });
  }

  var idfield = "idContract";
  // 合同改为全局共享(仅平台账户有合同权限,分库用户不授予),表固定 gm_data_000.contract 20260926 修正,
  var table = "gm_data_000.contract"
  req.body.idvalue = idvalue;
  req.body.idfield = idfield;
  req.body.table = table;
  delete req.body.idContract;
  const statement = public.getUpdateByIdStatement(req.body);
  try {
    const results = await pool.query(statement.sql, statement.params);
    return public.respondAffectedRows(res, results, { successStatus: 201 });
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});

router.post('/insert', async (req, res) => {

  public.normalizeBodyDates(req.body);
  req.body.operator = req.data.userName;
  req.body.table = "gm_data_000.contract";
  //处理千分位格式(contractAmount 为 varchar,存显示字符串);未传金额时不写入,避免存入'undefined' 20260915 修复,
  let amount;
  if (req.body.contractAmount !== undefined && req.body.contractAmount !== null && req.body.contractAmount !== '') {
    amount = public.format(req.body.contractAmount);
  }
  delete req.body.contractAmount;
  if (amount !== undefined) {
    req.body.contractAmount = amount;
  }
  delete req.body.idContract;

  const statement = public.getInsertStatement(req.body);
  try {
    const results = await pool.query(statement.sql, statement.params);
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idContract = public.parseNumericParam(req.body.idContract);
  if (idContract === null) {
    return res.status(400).json({ error: 'idContract参数错误!' });
  }

  req.body.operator = req.data.userName;
  req.body.table = "gm_data_000.contract";

  //处理千分位格式(contractAmount 为 varchar,存显示字符串);未传金额时不写入,避免存入'undefined' 20260915 修复,
  let amount;
  if (req.body.contractAmount !== undefined && req.body.contractAmount !== null && req.body.contractAmount !== '') {
    amount = public.format(req.body.contractAmount);
  }
  delete req.body.contractAmount;
  if (amount !== undefined) {
    req.body.contractAmount = amount;
  }
  //处理id
  req.body.idfield ="idContract";
  req.body.idvalue = idContract;
  delete req.body.idContract;
  //
  const statement = public.getUpdateByIdStatement(req.body);
  try {
    const results = await pool.query(statement.sql, statement.params);
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});