# cs2-log-backend

Rewrite of [primitifcsgo/CS2-GOTV-live-backend](https://github.com/primitifcsgo/CS2-GOTV-live-backend) that drops the GOTV broadcast fragment pipeline and uses the CS2 server log stream instead.

- **Ingest:** CS2 `logaddress_add_http` POSTs log lines to the backend.
- **Parser:** [@blastorg/srcds-log-parser](https://github.com/blastorg/srcds-log-parser) converts each line into a typed event.
- **Output:** REST endpoints + bundled dashboard at `/ui/` with live scores, kill feed, K/D/A, HP, armor, weapons, bomb status.

## What the logs actually carry

With `mp_logdetail 3` + `mp_logdetail_items 1` the backend reconstructs live state from these events:

| Tracked | Source event |
| --- | --- |
| Scores, round number, round history, win reason | `team_triggered`, `scored`, `entity_triggered` |
| Kills, assists, deaths, headshots, kill feed | `killed`, `assist`, `suicide` |
| **Live HP + armor** (post-hit values) | `attacked` |
| **Held weapon, helmet, defuser** | `purchased`, `left_buyzone_with` |
| `isAlive` flag | derived from HP == 0 / kill / suicide |
| Bomb: planted/defused/dropped/carried + site + plantedAt | `entity_triggered` (`planted_the_bomb`, `defused_the_bomb`, `bomb_begin_plant`, `got_the_bomb`, `dropped_the_bomb`) |
| Grenades thrown per round | `threw` |
| Map name, phase (Warmup/Live/Halftime/Ended) | `server_log`, `entity_triggered match_start` |
| Connects / disconnects, team switches | `connection`, `switched_team` |

## What the logs do NOT carry

| Not tracked | Why |
| --- | --- |
| Tick-by-tick positions | Only kill/attack/grenade events include coordinates |
| Live money | Would require reconstructing economy rules from purchases + round rewards (not implemented) |
| Bomb timer countdown | Only plant time is logged — dashboard computes remaining time client-side from `bomb.plantedAt` |
| Continuous HP between hits | Logs only update HP on `attacked` events (damage tick), which is close enough in practice |
| Active weapon between switches mid-round | Purchased / buyzone snapshot is used; knife-out mid-round isn't logged |

If you need full telemetry (live positions, economy, per-tick player state) use the GOTV fork instead — it parses demo fragments.

## CS2 log format notes (handled by this backend)

CS2 log lines as of 2026 look like:

```
04/23/2026 - 09:30:55.770 - "PRIMITIF<2><[U:1:190904238]><TERRORIST>" triggered "Planted_The_Bomb" at bombsite A
```

Differences from the classic SRCDS format that `@blastorg/srcds-log-parser` expects:

- Millisecond suffix on the timestamp (`.770`)
- Dash separator between timestamp and body (` - ` instead of `: `)
- Bomb-plant lines get an `at bombsite <X>` trailing clause

`src/matchState.js` normalizes all of these before handing the line to the parser.

## Run locally

```bash
npm install
npm start
```

Server listens on `PORT` (default `5000`). Dashboard at `http://localhost:5000/ui/`.

Environment variables:

| Name | Purpose |
| --- | --- |
| `PORT` | Listen port (default `5000`) |
| `LOG_AUTH` | If set, requests must send `Authorization: <value>` |
| `LOG_TOKEN` | If set, URL must be `/log/<LOG_TOKEN>`. Use a URL-safe value (hex), not raw base64 — slashes break route matching. |

## Docker

```bash
docker build -t cs2-log-backend .
docker run -p 5000:5000 -e LOG_TOKEN=abc123 cs2-log-backend
```

## Deploy to Render

`render.yaml` is included as a blueprint:

1. Push this repo to GitHub.
2. Render.com → **New → Blueprint** → select the repo.
3. Render auto-generates `LOG_TOKEN`. If the generated value contains `/` or `+`, edit it to a URL-safe hex (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`).
4. `LOG_AUTH` is optional (prompt on first deploy).

Once live:

- Dashboard: `https://<yourapp>.onrender.com/ui/` — open it, paste the same URL into the prompt, **Connect**.
- `curl https://<yourapp>.onrender.com/health` → sanity check.

### Free-tier caveat

Render free dynos sleep after 15 min of inactivity. The first POST after sleep takes ~30 s (cold start) and may be dropped. For continuous play, either pay for Starter ($7/mo, no sleep) or ping `/health` every 10 min from uptimerobot.com (free).

## Point CS2 at it

In `csgo/cfg/autoexec.cfg` (or run from console):

```
log on
mp_logdetail 3
mp_logdetail_items 1
sv_log_onefile 0
logaddress_delall_http
logaddress_add_http "https://<yourapp>.onrender.com/log/<LOG_TOKEN>"
```

Reload with `exec autoexec` or restart the server. See also [`server-config/cs2_logaddress.cfg`](server-config/cs2_logaddress.cfg).

## Endpoints

- `POST /log/:token` — CS2 posts raw log bodies here.
- `GET /state` — full match snapshot.
- `GET /players` — player list with K/D/A, HP, armor, weapon, helmet, defuser, isAlive.
- `GET /score` — `{ ct, t, round }`.
- `GET /round` — current round number, phase, bomb status, kills so far.
- `GET /teams` — CT and T team state.
- `GET /history` — finished-round entries.
- `GET /health` — liveness + `eventsProcessed`, `lastReceivedAgoMs`, `connectedPlayers`, `broadcastActive`.
- `POST /reset` — clear state for a new match.
- `GET /debug/last` — last 20 raw POST bodies (for troubleshooting log format).
- `GET /ui/` — bundled dashboard (same origin, no CORS setup needed).
