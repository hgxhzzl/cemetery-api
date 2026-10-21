const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;


// 按 region 分组构建园区树:label=region,children=park 列表 20260915 抽取,
function buildParkTree(results) {
    let listRegion = [];
    results.forEach((item) => {
        listRegion.push(item.region)
    });
    listRegion = Array.from(new Set(listRegion));
    let listReturn = [];
    listRegion.forEach((itemRegion, index) => {
        let json = {};
        let listChildren = [];
        json.label = itemRegion;
        json.activable = false;
        results.forEach((item, index) => {
            if (item.region === itemRegion) {
                let jsonChildren = {};
                jsonChildren.label = item.park;
                jsonChildren.value = itemRegion + "&" + item.park;
                listChildren.push(jsonChildren);
            }
        });
        json.children = listChildren;
        listReturn.push(json);
    });
    return listReturn;
}

router.get('/parkTree', async (req, res) => {
    const db = req.data.dataBase;
    const table = " SELECT region,park FROM " + db + ".v_region_park";
    // 区域→园区树同样按操作员区域名单收窄,与 /park-query/region、/park-query/park 同源口径,
    // 避开“下拉挡住了但树接口能拿到全区划”的不一致;未配区域/平台管理员返回全量 20261010 硬隔离,
    // 名单取数失败直接回 500:不能落到下方的视图兜底里去(那里空名单等于不过滤,会泄出全区划) 20261021 审查修复二轮 P1-4,
    let allowedRegions;
    try {
        allowedRegions = await rbac.fetchOperatorRegions(req);
    } catch (regionError) {
        return public.handleQueryError(res, regionError);
    }
    try {
        const results = await pool.query(table);
        return public.respondList(res, buildParkTree(rbac.filterByOperatorRegions(results, 'region', allowedRegions)));
    } catch (error) {
        // 视图缺失兑底:直接查 room 表去重,保证存量库无视图时仍可用 20260915 新增,
        try {
            const fallbackSql = "SELECT DISTINCT park AS park, region AS region FROM " + db + ".room ORDER BY region";
            const fallbackResults = await pool.query(fallbackSql);
            return public.respondList(res, buildParkTree(rbac.filterByOperatorRegions(fallbackResults, 'region', allowedRegions)));
        } catch (fallbackError) {
            return public.handleQueryError(res, fallbackError);
        }
    }
});

router.get('/status', async (req, res) => {
    const sql = "SELECT name as label, name as value, type FROM " + req.data.dataBase + ".type";
    try {
        const results = await pool.query(sql);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});

router.get('/room', async (req, res) => {
    // 区域三级菜单进入时仅传区域不传园区，园区参数改为可选，为空时查该区域全部墓位 20260831 修改,
    const conditions = ['isDeleted = 0', 'region = ?'];
    const params = [req.query.region];
    if (req.query.park) {
        conditions.push('park = ?');
        params.push(req.query.park);
    }
    try {
        const results = await pool.query(`SELECT * FROM ${req.data.dataBase}.room WHERE ${conditions.join(' AND ')}`, params);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});

  router.get('/canSale', async (req, res) => {
        // 可售墓位:返回全部记录(含已售),是否可售由前端根据 saleStatus 判断 20260916 修改,
        // 区域三级菜单进入时仅传区域不传园区，园区参数改为可选，为空时查该区域全部墓位 20260831 修改,
        // 活动预定记录带出 liaison/liaisonPhone（预定页卡片“预定人/手机号”行使用），
        // 一穴一条约束下取最新一条防历史数据重复行放大;销售页不消费这两列，属可忽略的额外字段 20261012 新增,
        // 20261021 审查修复二轮 P1-8:改相关子查询取代 LEFT JOIN 派生表——带 GROUP BY 的派生表无法与外层合并,
        // MySQL 每次请求都要先全表扫描 reserve 并落临时表再 JOIN,存量预定越多本页越慢;
        // 改后只对本页墓位行按 idx_reserve_idRoom 取数,数百穴位即数百次索引 lookup,
        const conditions = ['r.isDeleted = 0', 'r.region = ?'];
        const params = [req.query.region];
        if (req.query.park) {
            conditions.push('r.park = ?');
            params.push(req.query.park);
        }
        // 同一穴位多条活动记录时取最新一条(原 MAX 写法取的是字典序最大值,无业务含义),
        const latestReserve = (column) =>
            `(SELECT rs.${column} FROM ${req.data.dataBase}.reserve rs WHERE rs.idRoom = r.idRoom AND rs.isDeleted = 0 ORDER BY rs.idReserve DESC LIMIT 1)`;
        const sql = `SELECT r.*, ${latestReserve('liaison')} AS reserveLiaison, ${latestReserve('liaisonPhone')} AS reserveLiaisonPhone
            FROM ${req.data.dataBase}.room r
            WHERE ${conditions.join(' AND ')}`;
        try {
            const results = await pool.query(sql, params);
            return public.respondList(res, results);
        } catch (error) {
            return public.handleQueryError(res, error);
        }
  });

  

  router.get('/idList', async (req, res) => {
        const idRoom = public.parseNumericParam(req.query.idRoom);
        if (idRoom === null) {
            return res.status(400).json({ error: 'idRoom参数错误!' });
        }

        const table = "SELECT * FROM  " + req.data.dataBase + ".room "
        try {
            const results = await pool.query(`${table} where isDeleted = 0 and idRoom= ?`, [idRoom]);
            return public.respondDetail(res, results);
        } catch (error) {
            return public.handleQueryError(res, error);
        }
  });


