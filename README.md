# cs2-log-backend

Rewrite of [primitifcsgo/CS2-GOTV-live-backend](https://github.com/primitifcsgo/CS2-GOTV-live-backend) that drops the GOTV broadcast fragment pipeline and uses the CS2 server log stream instead.

- **Ingest:** CS2 `logaddress_add_http` POSTs log lines to the backend.
- **Parser:** [@blastorg/srcds-log-parser](https://github.com/blastorg/srcds-log-parser) converts each line into a typed event.
- **Output:** REST endpoints expose live scores, round history, kills, and player K/D/A.

## What changed vs. the original

| Aspect | Original (GOTV) | This rewrite (logs) |
| --- | --- | --- |
| Language | C# / .NET 8 | Node.js 18+ |
| Ingestion | `tv_broadcast_url` → POST demo fragments | `logaddress_add_http` → POST log lines |
| Parser | DemoFile.Net | @blastorg/srcds-log-parser |
| Live player HP / armor / money / positions | Yes (from demo) | **No** (not present in logs) |
| Live bomb timer / planted site coords | Yes | Partial (planted/defused events only) |
| Scores, round history, kills, K/D/A | Yes | Yes |

Text-based SRCDS logs carry a smaller slice of match state than GOTV demo fragments — this backend reflects that.

## Run locally

```bash
npm install
npm start
```

Server listens on `PORT` (default `5000`).

Environment variables:

| Name | Purpose |
| --- | --- |
| `PORT` | Listen port (default `5000`) |
| `LOG_AUTH` | If set, requests must send `Authorization: <value>` |
| `LOG_TOKEN` | If set, URL must be `/log/<LOG_TOKEN>` |

## Docker

```bash
docker build -t cs2-log-backend .
docker run -p 5000:5000 -e LOG_TOKEN=secret cs2-log-backend
```

## Point CS2 at it

In `csgo/cfg/autoexec.cfg` (or run from console):

```
log on
mp_logdetail 3
logaddress_add_http "https://your-host/log/secret"
```

See [`server-config/cs2_logaddress.cfg`](server-config/cs2_logaddress.cfg).

## Endpoints

- `POST /log/:token` — CS2 posts raw log bodies here.
- `GET /state` — full match snapshot.
- `GET /players` — player list with kills / deaths / assists / headshots.
- `GET /score` — `{ ct, t, round }`.
- `GET /round` — current round number, phase, bomb status, kills so far.
- `GET /teams` — CT and T team state.
- `GET /history` — finished-round entries.
- `GET /health` — liveness + `eventsProcessed`, `lastReceivedAgoMs`.
- `POST /reset` — clear state for a new match.
- `GET /ui/` — bundled dashboard (same origin, no CORS setup needed).

## Deploy to Render

`render.yaml` is included as a blueprint. Push this repo to GitHub, click **New → Blueprint** on render.com, select the repo. Render reads `render.yaml`, creates a web service, auto-generates `LOG_TOKEN`, and asks for `LOG_AUTH` (optional).

Once live:

- Dashboard: `https://<yourapp>.onrender.com/ui/` — open it, paste the same URL into the prompt, click **Connect**.
- Point CS2 at the backend:

  ```
  logaddress_add_http "https://<yourapp>.onrender.com/log/<LOG_TOKEN>"
  log on
  mp_logdetail 3
  ```

The dashboard shows scores, round history, kill feed, K/D/A, headshots, bomb planted/defused status. Fields that depend on demo telemetry (live HP, armor, money, held weapon, positions, bomb timer countdown) stay empty because SRCDS text logs don't carry them — players will render as `DEAD` with `$0` until the next hit/buy event you care about lands. That's a limitation of the log stream, not a bug.
