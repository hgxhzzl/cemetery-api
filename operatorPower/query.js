const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;


//get operator Power
router.get('/power', async (req, res) => {

    const dataBaseName = req.data.dataBase;
    const idOperator = public.parseNumericParam(req.query.idOperator);
    if (idOperator === null) {
        return res.status(400).json({ error: 'idOperator参数错误!' });
    }

    const sqlinsert = `insert into gm_data_000.operator_power (idMenu,idOperator) 
    select idMenu, ? from gm_data_000.account_power b  
    where b.dataBaseName = ? and b.isDeleted = 0 and b.idMenu not in (
        select idMenu from gm_data_000.operator_power c where c.idOperator = ?)`;
    try {
        await pool.query(sqlinsert, [idOperator, dataBaseName, idOperator]);
        const sql = `SELECT * FROM gm_data_000.account_power a, gm_data_000.operator_power b 
        WHERE a.idMenu = b.idMenu and a.useMenu = 1 and a.dataBaseName = ? and b.idOperator = ? and a.isDeleted = 0`;
        const results = await pool.query(sql, [dataBaseName, idOperator]);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
})
