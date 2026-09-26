const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

async function fetchItems(table, idContract, contractName) {
    if (idContract !== undefined) {
        return pool.query(`${table} and idContract = ?`, [idContract]);
    }
    if (contractName !== undefined) {
        const likeContractName = '%' + contractName + '%'
        return pool.query(`${table} and contractName like ? order by modifyDate desc`, [likeContractName]);
    }
    return pool.query(`${table} order by modifyDate desc`);
}

async function all(table, idContract, contractName) {
    const contractItems = await fetchItems(table, idContract, contractName);
    return contractItems;
}

router.get('/', async (req, res,next) => {
    try {
        const hasIdContract = Object.prototype.hasOwnProperty.call(req.query, 'idContract');
        const idContract = hasIdContract ? public.parseNumericParam(req.query.idContract) : undefined;
        if (hasIdContract && idContract === null) {
            return res.status(400).json({ error: 'idContract参数错误!' });
        }

        const contractName = req.query.contractName;
        // 合同改为全局共享,表固定 gm_data_000.contract 20260926 修正,
        const table = "SELECT *  FROM gm_data_000.contract Where isDeleted = 0 ";
        const contractItems = await all(table, idContract, contractName);
        return public.respondList(res, contractItems);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});

router.get('/partyA', async (req, res) => {

    // account 为全局表且业务库不复制,改为查 gm_data_000.account 并按租户过滤 20260917 修复,
    let sql = "SELECT account as label,account as value FROM gm_data_000.account Where isDeleted = 0 and dataBaseName = ?" + ' and head <> ?'; 
    try {
        const results = await pool.query(sql, [req.data.dataBase, 'admin']);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
router.get('/partyB', async (req, res) => {
    // account 为全局表且业务库不复制,改为查 gm_data_000.account 并按租户过滤 20260917 修复,
    let sql = "SELECT account as label,account as value FROM gm_data_000.account Where isDeleted = 0 and dataBaseName = ?" + ' and head = ?'; 
    try {
        const results = await pool.query(sql, [req.data.dataBase, 'admin']);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
})