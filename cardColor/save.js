const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');

module.exports = router;

// 四个卡片状态 key 固定,与前端 utils/cardTheme.ts 的 CARD_COLOR_STATES 一一对应 20261011 新增,
const CARD_COLOR_STATES = ['unsold', 'sold', 'buried', 'expired'];
// 色值只接受 6 位十六进制:该值最终会写进 CSS 变量,放宽格式等于放开样式注入 20261011 新增,
const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

// 逐态校验并规整为大写十六进制,返回错误文案(null 表示通过) 20261011 新增,
function validateConfig(config) {
    if (!config || typeof config !== 'object') {
        return 'config参数错误!';
    }
    for (const state of CARD_COLOR_STATES) {
        const item = config[state];
        if (!item || typeof item !== 'object') {
            return `缺少${state}配色!`;
        }
        if (!HEX_PATTERN.test(String(item.color)) || !HEX_PATTERN.test(String(item.border))) {
            return `${state}颜色值格式错误!`;
        }
        if (typeof item.isEnabled !== 'boolean') {
            return `${state}着色状态参数错误!`;
        }
    }
    return null;
}

// 卡片配色保存:整库一套、库里恒一条记录,故只做更新;初始化行被误删时补插一条(幂等,避免保存失败) 20261011 新增,
router.post('/color', async (req, res) => {
    const table = req.data.dataBase + '.card_color';
    const config = req.body.config;
    const errorMessage = validateConfig(config);
    if (errorMessage) {
        return res.status(400).json({ error: errorMessage });
    }
    // 入库前统一大写并按固定键序序列化,便于人工比对与 diff 20261011 新增,
    const normalized = {};
    CARD_COLOR_STATES.forEach((state) => {
        normalized[state] = {
            color: String(config[state].color).toUpperCase(),
            border: String(config[state].border).toUpperCase(),
            isEnabled: config[state].isEnabled,
        };
    });
    const configJson = JSON.stringify(normalized);
    try {
        const rows = await pool.query(`SELECT idConfig FROM ${table} LIMIT 1`);
        let result;
        if (Array.isArray(rows) && rows.length > 0) {
            result = await pool.query(`UPDATE ${table} SET configJson = ? WHERE idConfig = ?`, [configJson, rows[0].idConfig]);
        } else {
            result = await pool.query(`INSERT INTO ${table} (idConfig, configJson) VALUES (1, ?)`, [configJson]);
        }
        // 用 respondTransaction 而非 respondAffectedRows:配色与库中现值完全相同时 affectedRows 为 0,
        // 后者会回 404 让前端提示"修改失败",而重复点确定属正常操作 20261011 新增,
        return public.respondTransaction(res, result);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
