const express = require('express');
const router = express.Router();
const public = require('../public');

module.exports = router;

router.post('/insert', async (req, res) => {
    const parklist = req.body;
    const region = parklist[0].region;
    const table = req.data.dataBase + '.park';
    // 插入前按园区名去重(保留首次出现的位置,数组序即页面拖拽结果不能乱):park 表的 (park, region) 没有唯一索引,
    // 写入又是"按区域先删后插",而页面上的 new Set 去重拦不住绕过界面直调本接口的情况。
    // 重名行会让按园区序排序的查询(如下葬查询关联 park 取 idPark)把同一笔记录放大成多行 20261011 新增,
    const seenParks = new Set();
    const uniqueParkList = parklist.filter((item) => {
      if (seenParks.has(item.park)) {
        return false;
      }
      seenParks.add(item.park);
      return true;
    });
    const sqlList = [{
      sql: `delete from ${table} where region = ?`,
      params: [region],
    }];
    uniqueParkList.forEach((item) => {
      sqlList.push({
        sql: `insert into ${table} (park, region) values (?, ?)`,
        params: [item.park, item.region],
      });
    });
  return public.Transaction(sqlList,res);
});