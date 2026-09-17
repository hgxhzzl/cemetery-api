const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

// 全局管理接口:账户查询仅平台管理员可操作 20260917 越权收口,
router.use(rbac.requirePlatformAdmin);

async function fetchItems(table, idAccount, account) {
    if (idAccount !== undefined) {
        return pool.query(`${table} and idAccount = ?`, [idAccount]);
    }
    if (account !== undefined) {
        const likeAccount = '%' + account + '%'
        return pool.query(`${table} and account like ? order by modifyDate desc`, [likeAccount]);
    }
    return pool.query(`${table} order by modifyDate desc`);
}

async function all(table, idAccount, account) {
    const items = await fetchItems(table, idAccount, account);
    return items;
}

router.get('/', async (req, res,next) => {
    try {
        const hasIdAccount = Object.prototype.hasOwnProperty.call(req.query, 'idAccount');
        const idAccount = hasIdAccount ? public.parseNumericParam(req.query.idAccount) : undefined;
        if (hasIdAccount && idAccount === null) {
            return res.status(400).json({ error: 'idAccount参数错误!' });
        }

        const account = req.query.account;
        const table = "SELECT idAccount, account, head, phone, enterpriseType, useStatus, startDate, endDate, address, dataBaseName, operator, modifyDate, createDate, isDeleted, uuid FROM gm_data_000.account Where isDeleted = 0 ";
        const items = await all(table, idAccount, account);
        return public.respondList(res, items);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});

