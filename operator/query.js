const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

router.get('/', async (req, res) => {
    let dataBaseName = req.data.dataBase;
    // 列清单不含 password,避免密码哈希随接口泄露 20260917 越权收口,
    let sql = ' SELECT idOperator, name, phone, duties, team, useStatus, remark, operator, modifyDate, createDate, isDeleted, isAccount, dataBaseName, joinDate, isMaintenance FROM  gm_data_000.operator Where isDeleted = 0 and dataBaseName = ?';
    try {
        const results = await pool.query(sql, [dataBaseName]);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});

router.get('/id', async (req, res) => {
    const idOperator = public.parseNumericParam(req.query.idOperator);
    if (idOperator === null) {
        return res.status(400).json({ error: 'idOperator参数错误!' });
    }

    // 列清单不含 password;非平台管理员仅可查本租户操作员 20260917 越权收口,
    let sql = ' SELECT idOperator, name, phone, duties, team, useStatus, remark, operator, modifyDate, createDate, isDeleted, isAccount, dataBaseName, joinDate, isMaintenance FROM  gm_data_000.operator Where isDeleted = 0 and idOperator = ?';
    if (!rbac.isPlatformAdmin(req)) {
        sql += ' and dataBaseName = ?';
    }
    try {
        const params = rbac.isPlatformAdmin(req) ? [idOperator] : [idOperator, req.data.dataBase];
        const results = await pool.query(sql, params);
        return public.respondDetail(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
router.get('/duties', async (req, res) => {
    const table = " SELECT tagName as label,tagName as value FROM " + req.data.dataBase + ".taginfo WHERE";
    try {
        const results = await pool.query(table + " tagType ='duties'");
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
router.get('/team', async (req, res) => {
    const table = " SELECT tagName as label,tagName as value FROM " + req.data.dataBase + ".taginfo WHERE";
    try {
        const results = await pool.query(table + " tagType ='team'");
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
})

router.get('/maintenance', async (req, res) => {
   
    const table = 'SELECT name,phone,team,duties FROM gm_data_000.operator WHERE dataBaseName = ? and isDeleted = 0 and isMaintenance = 1';
    try {
        const results = await pool.query(table, ['gm_data_000']);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
})
router.get('/havePhone', async (req, res) => {
    const idOperator = public.parseNumericParam(req.query.idOperator);
    if (idOperator === null) {
        return res.status(400).json({ error: 'idOperator参数错误!' });
    }

    const dataBaseName = req.data.dataBase;
    let phone = req.query.phone;
    let sql  ='SELECT count(*) as havePhone FROM gm_data_000.operator WHERE dataBaseName = ? and isDeleted = 0 and idOperator <> ? and phone = ?';
    try {
        const results = await pool.query(sql, [dataBaseName, idOperator, phone]);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
})
