const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');

module.exports = router;

// 卡片配色查询:整库一套(同库多区域共用),库里恒一条初始化记录,无记录时返回空 list 由前端走默认色 20261011 新增,
router.get('/color', async (req, res) => {
    const table = req.data.dataBase + '.card_color';
    try {
        const results = await pool.query(`SELECT * FROM ${table} LIMIT 1`);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
