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
        // 功能模板直接取 menu.powerConfig 下发(前端权限页据此渲染功能×动作矩阵,不再维护代码侧目录副本),
        // SELECT a.*, b.* 保留原有权限行字段;menu 仅多取一列别名 menuTemplate,不影响同名覆盖 20261023 改造,
        const sql = `SELECT a.*, b.*, m.powerConfig AS menuTemplate
        FROM gm_data_000.account_power a
        JOIN gm_data_000.operator_power b ON a.idMenu = b.idMenu
        JOIN gm_data_000.menu m ON m.id = b.idMenu
        WHERE a.useMenu = 1 and a.dataBaseName = ? and b.idOperator = ? and a.isDeleted = 0
        ORDER BY a.idMenu ASC`;
        const results = await pool.query(sql, [dataBaseName, idOperator]);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
})
