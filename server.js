const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.SPORTSDATA_API_KEY || '2b0184b2a529419a945e38003ded55f6';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const picksCache = { date: null, picks: null };

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}-${months[d.getMonth()]}-${String(d.getDate()).padStart(2,'0')}`;
}

async function fetchSportsData(endpoint, date) {
  const url = `https://api.sportsdata.io/v3/nba/odds/json/${endpoint}/${fmtDate(date)}?key=${API_KEY}`;
  const res = await fetch(url);
  return res.json();
}

function summarizeOdds(games) {
  return games.map(g => {
    const books = g.PregameOdds || [];
    const homeMLs = books.map(b => b.HomeMoneyLine).filter(v => v !== null && v !== undefined);
    const awayMLs = books.map(b => b.AwayMoneyLine).filter(v => v !== null && v !== undefined);
    const spreads = books.map(b => b.HomePointSpread).filter(v => v !== null && v !== undefined);
    const ous = books.map(b => b.OverUnder).filter(v => v !== null && v !== undefined);
    const avg = arr => arr.length ? arr.reduce((a,b) => a+b,0)/arr.length : null;
    const fmt = v => v === null ? 'N/A' : (v > 0 ? '+' : '') + v;
    return {
      matchup: `${g.AwayTeamName} @ ${g.HomeTeamName}`,
      status: g.Status,
      time: g.DateTime,
      homeMoneylineAvg: fmt(avg(homeMLs) ? Math.round(avg(homeMLs)) : null),
      awayMoneylineAvg: fmt(avg(awayMLs) ? Math.round(avg(awayMLs)) : null),
      homeMoneylineBest: fmt(homeMLs.length ? Math.max(...homeMLs) : null),
      awayMoneylineBest: fmt(awayMLs.length ? Math.max(...awayMLs) : null),
      spreadAvg: avg(spreads) ? avg(spreads).toFixed(1) : 'N/A',
      spreadRange: spreads.length > 1 ? `${Math.min(...spreads).toFixed(1)} to ${Math.max(...spreads).toFixed(1)}` : 'N/A',
      overUnderAvg: avg(ous) ? avg(ous).toFixed(1) : 'N/A',
      bookCount: books.length,
      lineMovement: spreads.length > 1 && (Math.max(...spreads) - Math.min(...spreads)) >= 0.5
        ? `Line has moved ${(Math.max(...spreads) - Math.min(...spreads)).toFixed(1)} points across books — possible sharp action`
        : 'Line is stable across books'
    };
  });
}

async function generatePicks(games) {
  const today = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
  const summary = summarizeOdds(games);

  const systemPrompt = `You are FitzPicks, a sharp NBA betting analyst with a confident, punchy voice. You talk like a real bettor who knows the game — not a robot, not overly formal. You reference sharp money movement, line value, and team narratives. You always give a clear recommendation.

Here is an example of how you talk:
"Hey NBA fans, FitzPicks here with your lock of the night. Detroit is reeling from their game 1 loss. The Magic are finally playing their brand of physical basketball. Sharps moved the line from Detroit -9.5 to -8.5. FitzPicks still sees great value in following the money — we're taking Orlando +9.5 on the road. Good luck!"

Key traits:
- Open with "FitzPicks here" or a variation
- Reference team narratives and momentum
- Always mention line movement if there is any — sharps moving lines is your biggest signal
- Give ONE clear pick per game with a specific bet (spread, moneyline, or over/under)
- End with confidence — "Good luck", "Trust the process", "That's the play"
- Keep each pick to 4-6 sentences max — punchy, not long-winded
- Never say "as an AI" or anything robotic
- Return ONLY a valid JSON array. No markdown, no preamble, no text outside the JSON.`;

  const userPrompt = `Today is ${today}. Here are today's NBA games with odds data. Write a sharp FitzPicks-style analysis and pick for each game.

Games:
${JSON.stringify(summary, null, 2)}

Return ONLY a valid JSON array like this, with absolutely no other text before or after it:
[{"matchup":"AWAY @ HOME","pick":"team and bet e.g. Orlando +9.5","betType":"spread","analysis":"4-6 sentence analysis in FitzPicks voice","confidence":"Lock"}]`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  const data = await response.json();

  if (!data.content || !data.content[0] || !data.content[0].text) {
    throw new Error('Unexpected Claude response: ' + JSON.stringify(data));
  }

  const text = data.content[0].text.trim();
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) throw new Error('Response is not an array');
    return parsed;
  } catch(e) {
    console.error('Parse error. Raw response:', clean);
    throw new Error('Could not parse Claude response as JSON');
  }
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

app.get('/api/picks', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];

    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    if (picksCache.date === date && picksCache.picks) {
      return res.json(picksCache.picks);
    }

    const games = await fetchSportsData('GameOddsByDate', date);

    if (!Array.isArray(games) || !games.length) {
      return res.json([]);
    }

    const picks = await generatePicks(games);

    picksCache.date = date;
    picksCache.picks = picks;

    res.json(picks);
  } catch(e) {
    console.error('Picks error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`FitzPicks running at http://localhost:${PORT}`));
