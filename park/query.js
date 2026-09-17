const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');

module.exports = router;

router.get('/park', async (req, res) => {
    try {
        const results = await pool.query("SELECT park as label,park as value, region FROM " +req.data.dataBase +".park ");
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});

router.get('/region', async (req, res) => {
    let table = " FROM " + req.data.dataBase +".taginfo  WHERE tagType ='region' ";
    try {
        const results = await pool.query("SELECT  tagName as label,tagName as value " + table);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});