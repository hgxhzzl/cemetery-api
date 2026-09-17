const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

router.post('/insert', async (req, res) => {

  public.normalizeBodyDates(req.body);
  let json= all(req);
  if (json === null) {
    return res.status(400).json({ error: '房位坐标参数错误!' });
  }
  delete req.body.idRoom;
  let table = req.data.dataBase+".room";
  let region = req.body.region;
  let park = req.body.park;
  let sqlhave = `select yNum,xNum from ${table} where isDeleted = 0 and region = ? and park = ?`
  let sqlList = [];
  try {
    const resultshave = await pool.query(sqlhave, [region, park]);
    for (let i = json.yNum; i < json.yNumTo + 1; i++) {
      for (let j = json.xNum; j < json.xNumTo + 1; j++) {
        let have = 0;
        if (resultshave.length > 0) {
          resultshave.forEach((item) => {  
            if (item.yNum === i) {
              if (item.xNum === j) {
                have = 1;
              }
            }
          });
        }     
        if (have === 0) {
          const insertPayload = {
            ...req.body,
            yNum: i,
            xNum: j,
            table,
          };
          //新增时xyNumber默认值为 yNum排xNum号,前端已填写则以前端为准 20260831,
          if (insertPayload.xyNumber === undefined || insertPayload.xyNumber === null || insertPayload.xyNumber === '') {
            insertPayload.xyNumber = `${i}排${j}号`;
          }
          const statement = public.getInsertStatement(insertPayload);
          sqlList.push(statement);

        }
      }
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }
  return public.Transaction(sqlList, res);
});

router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  let idRoom = req.body.idRoom
  let modify =req.body.modify
  let json= all(req);
  if (json === null) {
    return res.status(400).json({ error: '房位坐标参数错误!' });
  }

  if (modify==='1'){
    idRoom = public.parseNumericParam(idRoom);
    if (idRoom === null) {
      return res.status(400).json({ error: 'idRoom参数错误!' });
    }

    req.body.idfield ="idRoom";
    req.body.idvalue =idRoom;
    const statement = public.getUpdateByIdStatement(req.body);
    try {
      const results = await pool.query(statement.sql, statement.params);
      return public.respondAffectedRows(res, results);
    } catch (error) {
      return public.handleQueryError(res, error);
    }
  }
  if (modify==='2'){

    const region = req.body.region;
    const park = req.body.park;
    const table = req.body.table;
    const operator = req.body.operator;
    const updatePayload = { ...req.body };
    delete updatePayload.region;
    delete updatePayload.park;
    delete updatePayload.yNum;
    delete updatePayload.xNum;
    delete updatePayload.table;
    delete updatePayload.operator;
    // 多条修改不更新编号，避免范围内墓位被覆写为同一编号 20260831 新增,
    delete updatePayload.xyNumber;

    const currentTime = public.getCurrentDateTime();
    updatePayload.modifyDate = currentTime;
    updatePayload.operator = operator;

    const fields = Object.keys(updatePayload);
    const assignments = fields.map((field) => `${field} = ?`).join(', ');
    const values = fields.map((field) => updatePayload[field]);
    const sql = `update ${table} set ${assignments} where xNum >= ? and xNum <= ? and yNum >= ? and yNum <= ? and region = ? and park = ?`;

    try {
      const results = await pool.query(sql, [...values, json.xNum, json.xNumTo, json.yNum, json.yNumTo, region, park]);
      return public.respondAffectedRows(res, results);
    } catch (error) {
      return public.handleQueryError(res, error);
    }
  }
  return res.status(400).json({ error: 'modify参数错误!' });
});



function all(req) {
  let xNum = public.parseNumericParam(req.body.xNum);
  let xNumTo = public.parseNumericParam(req.body.xNumTo);
  let yNum = public.parseNumericParam(req.body.yNum);
  let yNumTo = public.parseNumericParam(req.body.yNumTo);

  if (xNum === null || xNumTo === null || yNum === null || yNumTo === null) {
    return null;
  }

  xNum = Number(xNum);
  xNumTo = Number(xNumTo);
  yNum = Number(yNum);
  yNumTo = Number(yNumTo);
  

  if (xNum > xNumTo) {
      let temp = xNumTo;
      xNumTo = xNum;
      xNum = temp;
  }
  if (yNum > yNumTo) {
    let temp = yNumTo;
    yNumTo = yNum;
    yNum = temp;
  }
  req.body.table = req.data.dataBase+".room";
  req.body.operator = req.data.userName;

  // price 可能为空(未填写时前端不传),判空守卫避免对 undefined 调 toString 使 async 路由崩溃 20260910 修复
  if (req.body.price !== undefined && req.body.price !== null && req.body.price !== '') {
    req.body.price = String(req.body.price).replace(/,/g, '');
  } else {
    delete req.body.price;
  }
 

  delete req.body.idRoom;
  delete req.body.yNumTo;
  delete req.body.modify;
  delete req.body.xNumTo;
  let json= {};

  json.xNum=xNum;
  json.xNumTo=xNumTo;
  json.yNum=yNum;
  json.yNumTo=yNumTo;

  return json;

}