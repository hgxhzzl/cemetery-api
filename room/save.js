const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const config = require('../config');
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

  // 批量上限(审查修复 20261021 P1-3):排×号的跨度乘积即待建行数由前端任意给定,原写法不设上限,
  // 一次提交数万条语句会打满事务未提交行与内存,超限直接 400 要求分批登记,
  const planCount = (json.yNumTo - json.yNum + 1) * (json.xNumTo - json.xNum + 1);
  if (planCount > config.roomBatch.maxCreate) {
    return res.status(400).json({
      error: `单次新建墓位 ${planCount} 个超过上限 ${config.roomBatch.maxCreate} 个，请缩小范围分批登记!`,
    });
  }

  const summary = { created: 0, skipped: 0 };
  // 已迁出的墓位坐标视为空位，允许新建（迁出后该位置可重新登记墓穴）20260921 新增
  // 审查修复 20261021 P1-3:全量已有坐标的读取与新建语句的生成一并收进同一事务,并先对本区本园区活动墓位 FOR UPDATE,
  // 原「事务外读快照 + 每个待建坐标线性扫描已有行」在万级存量下批量建位直接卡死,
  // 且两个窗口同时提交同一批坐标会双双通过校验造成重复墓位(现在锁后重读,后一个事务看到前一个的结果),
  const sqlList = [async (connection) => {
    const occupiedRows = await public.queryWith(
      connection,
      `select yNum, xNum from ${table}` +
        ` where isDeleted = 0 and region = ? and park = ?` +
        ` and (transferOutStatus IS NULL OR transferOutStatus <> 'statusType.transferOutStatusEnum.out')` +
        ' for update',
      [region, park],
    );
    // 坐标集合一次性建为 Set:待建坐标判定从 O(已有行数) 降为 O(1)
    const occupied = new Set((occupiedRows || []).map((item) => `${item.yNum}:${item.xNum}`));
    // 待建行先攒成数组,再一次生成多值 INSERT(审查修复 20261021 二轮 P1-9):
    // 原写法在双循环内逐行 await execWith,1000 个墓位就是 1000 次网络往返且全部串行,
    const pendingRows = [];

    for (let i = json.yNum; i < json.yNumTo + 1; i++) {
      for (let j = json.xNum; j < json.xNumTo + 1; j++) {
        const coordKey = `${i}:${j}`;
        if (occupied.has(coordKey)) {
          summary.skipped += 1;
          continue;
        }
        occupied.add(coordKey);
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
        pendingRows.push(insertPayload);
        summary.created += 1;
      }
    }

    // 同一批行的列集合由同一个 req.body 展开而来(结构一致),故可合并为多值语句;
    // 每条语句仍是一个事务项,失败时整个事务一起回滚,与逐行写法的安全口径相同,
    if (pendingRows.length > 0) {
      await public.execWith(connection, public.getMultiRowInsertStatements({ table, payloads: pendingRows }));
    }
    // 返回本事务项自己执行的写入行数(withTransaction 不累计函数型事务项的影响行数)
    return summary.created;
  }];

  try {
    const result = await pool.withTransaction(sqlList);
    return public.respondTransaction(res, result, { data: summary });
  } catch (error) {
    // 库层坐标唯一索引 uk_room_coord 作为并发兜底,命中时转友好 400 而非 500(审查修复 20261021 P1-3),
    if (error && error.code === 'ER_DUP_ENTRY' && /uk_room_coord/.test(String(error.message))) {
      return res.status(400).json({ error: '部分墓位坐标已被并发占用，请刷新墓位列表后重新提交!' });
    }
    return public.handleQueryError(res, error);
  }
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
    try {
      // 语句构造纳入 try：body 含非法键名时 assertIdentifier 抛错转 500 应答而非悬空请求（审查修复 20261021 ②）
      const statement = public.getUpdateByIdStatement(req.body);
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
    updatePayload.operator = operator;

    // 批量上限同样适用于范围修改(审查修复 20261021 二轮 P1-10):原写法这条 UPDATE 对跨度不作限制,
    // 排/号从 1 填到 99999 相当于一条语句锁住并改写全库活动墓位,
    // 事务时长、binlog 体量与行锁范围都不可控,超限直接 400 要求缩小范围分批提交,
    const spanCount = (json.yNumTo - json.yNum + 1) * (json.xNumTo - json.xNum + 1);
    if (spanCount > config.roomBatch.maxCreate) {
      return res.status(400).json({
        error: `单次修改墓位范围 ${spanCount} 个超过上限 ${config.roomBatch.maxCreate} 个，请缩小范围分批提交!`,
      });
    }

    try {
      // 改走公共语句构造：原手写 SET 把请求体键名与 table 直接插进 SQL（值参数化了但标识符裸拼，
      // 可改写任意列/任意表），getUpdateByConditionStatement 内部对表名/列名做白名单校验，
      // 并自动补 modifyDate（审查修复 20261021 ①）
      const statement = public.getUpdateByConditionStatement({
        ...updatePayload,
        table,
        condition: {
          sql: 'xNum >= ? and xNum <= ? and yNum >= ? and yNum <= ? and region = ? and park = ?',
          params: [json.xNum, json.xNumTo, json.yNum, json.yNumTo, region, park],
        },
      });
      const results = await pool.query(statement.sql, statement.params);
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