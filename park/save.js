const express = require('express');
const router = express.Router();
const public = require('../public');

module.exports = router;

router.post('/insert', async (req, res) => {
    const parklist = req.body;
    const region = parklist[0].region;
    const table = req.data.dataBase + '.park';
    const sqlList = [{
      sql: `delete from ${table} where region = ?`,
      params: [region],
    }];
    parklist.forEach((item) => {
      sqlList.push({
        sql: `insert into ${table} (park, region) values (?, ?)`,
        params: [item.park, item.region],
      });
    });
  return public.Transaction(sqlList,res);
});