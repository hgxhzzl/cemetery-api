const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');

module.exports = router;

// 收据配制查询:按区域名称取单条配置(一个区域一条配置),无配置时返回空 list 20260922 新增,
router.get('/config', async (req, res) => {
    const region = String(req.query.region || '').trim();
    if (!region) {
        return res.status(400).json({ error: 'region参数错误!' });
    }
    const table = req.data.dataBase + '.receipt_config';
    try {
        const results = await pool.query(`SELECT * FROM ${table} WHERE region = ? LIMIT 1`, [region]);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
