import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatchState } from './matchState.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 5000);
const LOG_AUTH = process.env.LOG_AUTH ?? '';
const LOG_TOKEN = process.env.LOG_TOKEN ?? '';

const match = new MatchState();
let lastIngestAt = null;
const rawBuffer = [];
const RAW_BUFFER_MAX = 20;

const app = express();
app.use(express.text({ type: '*/*', limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function checkAuth(req) {
  if (!LOG_AUTH) return true;
  return req.get('authorization') === LOG_AUTH;
}

function ingestHandler(req, res) {
  if (!checkAuth(req)) return res.sendStatus(403);
  if (LOG_TOKEN && req.params.token !== LOG_TOKEN) return res.sendStatus(403);

  const body = typeof req.body === 'string' ? req.body : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
  rawBuffer.push({ at: new Date().toISOString(), bytes: body.length, body: body.slice(0, 4000) });
  while (rawBuffer.length > RAW_BUFFER_MAX) rawBuffer.shift();
  const events = match.ingestBatch(body);
  lastIngestAt = Date.now();
  res.json({ accepted: events.length });
}

app.post('/log/:token', ingestHandler);
app.post('/log', ingestHandler);

app.use('/ui', express.static(path.join(__dirname, 'public')));

app.get('/state', (req, res) => res.json(match.snapshot()));

app.get('/players', (req, res) => res.json(match.snapshot().players));

app.get('/score', (req, res) => {
  const s = match.snapshot();
  res.json({ ct: s.ct.score, t: s.t.score, round: s.roundNumber });
});

app.get('/round', (req, res) => res.json(match.snapshot().currentRound));

app.get('/teams', (req, res) => {
  const s = match.snapshot();
  res.json({ ct: s.ct, t: s.t });
});

app.get('/history', (req, res) => res.json(match.snapshot().roundHistory));

app.get('/health', (req, res) => {
  const active = Boolean(lastIngestAt);
  res.json({
    status: active ? 'active' : 'waiting',
    version: 'cs2-log-backend-1.0',
    broadcastActive: active,
    lastReceivedAgoMs: lastIngestAt ? Date.now() - lastIngestAt : -1,
    eventsProcessed: match.eventsProcessed,
    connectedPlayers: match.snapshot().players.filter((p) => p.connected).length,
    timestamp: Date.now(),
  });
});

app.post('/reset', (req, res) => {
  match.reset();
  lastIngestAt = null;
  res.json({ message: 'Reset complete' });
});

app.get('/debug/last', (req, res) => {
  res.json({
    totalReceived: rawBuffer.length,
    entries: rawBuffer,
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'CS2 Log Backend',
    status: lastIngestAt ? 'ingesting' : 'waiting_for_logs',
    parser: '@blastorg/srcds-log-parser',
    endpoints: [
      'POST /log/{token}  — CS2 logaddress_add_http posts here',
      'GET  /state        — full match state',
      'GET  /players      — player list with K/D/A',
      'GET  /score        — CT/T score + round number',
      'GET  /round        — current round + bomb status',
      'GET  /teams        — team info',
      'GET  /history      — finished rounds',
      'GET  /health       — health check',
      'POST /reset        — reset state for new match',
    ],
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[cs2-log-backend] listening on :${PORT}`);
  if (LOG_AUTH) console.log('[cs2-log-backend] Authorization header required');
  if (LOG_TOKEN) console.log('[cs2-log-backend] token required in URL path');
});
