const express = require('express');
const router = express.Router();
const public = require('../public');
const pool = require('../database');

module.exports = router;

router.post('/insert', async (req, res) => {
  const taglist = req.body;
  const table = req.data.dataBase + '.taginfo';
  const sqlList = [{ sql: `delete from ${table}` }];
  taglist.forEach((item) => {
    sqlList.push({
      sql: `insert into ${table} (tagName, tagType) values (?, ?)`,
      params: [item.tagName, item.tagType],
    });
  });
  return public.Transaction(sqlList, res);
});
