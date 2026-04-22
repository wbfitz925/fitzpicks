const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.SPORTSDATA_API_KEY || '2b0184b2a529419a945e38003ded55f6';

app.use(express.static(path.join(__dirname, 'public')));

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}-${months[d.getMonth()]}-${String(d.getDate()).padStart(2,'0')}`;
}

async function fetchSportsData(path, date) {
  const url = `https://api.sportsdata.io/v3/nba/odds/json/${path}/${fmtDate(date)}?key=${API_KEY}`;
  const res = await fetch(url);
  return res.json();
}

app.get('/api/odds', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const data = await fetchSportsData('GameOddsByDate', date);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/props', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const data = await fetchSportsData('PlayerPropsByDate', date);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`FitzPicks running at http://localhost:${PORT}`));
