const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

router.get('/tagset', async (req, res) => {
    try {
        const results = await pool.query("SELECT *  FROM " + req.data.dataBase + ".tagset ");
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});

router.get('/taginfo', async (req, res) => {
    try {
        const results = await pool.query("SELECT *  FROM " + req.data.dataBase + ".taginfo ");
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});