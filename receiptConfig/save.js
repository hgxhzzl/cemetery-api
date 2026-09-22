const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');

module.exports = router;

// 收据配制保存:idConfig 为空时新增,有值(非0)时修改;
// 表无 createDate/modifyDate 审计字段,故手写 SQL,不依赖公共 getInsertStatement 的审计字段注入 20260922 新增,
router.post('/config', async (req, res) => {
    const table = req.data.dataBase + '.receipt_config';
    const idConfig = public.parseNumericParam(req.body.idConfig);
    const prefix = String(req.body.prefix || '').trim();
    const region = String(req.body.region || '').trim();
    const phone = String(req.body.phone || '').trim();
    const address = String(req.body.address || '').trim();
    if (!region) {
        return res.status(400).json({ error: 'region参数错误!' });
    }
    try {
        let result;
        if (idConfig === null || idConfig === '0') {
            result = await pool.query(
                `insert into ${table} (prefix, region, phone, address) values (?, ?, ?, ?)`,
                [prefix, region, phone, address],
            );
        } else {
            result = await pool.query(
                `update ${table} set prefix = ?, region = ?, phone = ?, address = ? where idConfig = ?`,
                [prefix, region, phone, address, idConfig],
            );
        }
        return public.respondAffectedRows(res, result);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});