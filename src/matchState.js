import { parse } from '@blastorg/srcds-log-parser';

const WIN_REASON_MAP = {
  sfui_notice_terrorists_win: 'TerroristsWin',
  sfui_notice_cts_win: 'CTsWin',
  sfui_notice_target_bombed: 'TargetBombed',
  sfui_notice_target_saved: 'TargetSaved',
  sfui_notice_bomb_defused: 'BombDefused',
  sfui_notice_hostages_not_rescued: 'HostagesNotRescued',
  sfui_notice_all_hostages_rescued: 'AllHostagesRescued',
  sfui_notice_terrorists_surrender: 'TerroristsSurrender',
  sfui_notice_cts_surrender: 'CTsSurrender',
};

const PRIMARIES = new Set([
  'ak47', 'm4a1', 'm4a1_silencer', 'aug', 'sg556', 'galilar', 'famas',
  'awp', 'ssg08', 'scar20', 'g3sg1',
  'mp9', 'mac10', 'mp7', 'ump45', 'p90', 'bizon', 'mp5sd',
  'nova', 'xm1014', 'sawedoff', 'mag7',
  'm249', 'negev',
]);
const SECONDARIES = new Set([
  'glock', 'usp_silencer', 'hkp2000', 'p250', 'deagle', 'revolver',
  'fiveseven', 'cz75a', 'tec9', 'elite', 'p2000',
]);
const SNIPERS = new Set(['awp', 'ssg08', 'scar20', 'g3sg1']);
const PISTOLS = SECONDARIES;
const GRENADES = new Set([
  'hegrenade', 'flashbang', 'smokegrenade', 'molotov', 'incgrenade',
  'decoy', 'inferno', 'frag_grenade',
]);

const MULTI_KILL_LABELS = {
  1: null,
  2: 'double',
  3: 'triple',
  4: 'quad',
  5: 'ace',
};

// Steam3 account id → SteamID64
const STEAM64_BASE = 76561197960265728n;

function accountIdToSteamId(accountId) {
  if (!accountId || accountId === '0') return null;
  try {
    return (BigInt(accountId) + STEAM64_BASE).toString();
  } catch {
    return null;
  }
}

function stripWeaponPrefix(s) {
  return String(s).replace(/^weapon_/, '');
}

function sideFromTeam(team) {
  if (!team) return 'UNKNOWN';
  if (typeof team === 'string') {
    if (team === 'COUNTER_TERRORISTS' || team === 'CT') return 'CT';
    if (team === 'TERRORISTS' || team === 'TERRORIST') return 'T';
    return team;
  }
  if (team.name === 'COUNTER_TERRORISTS') return 'CT';
  if (team.name === 'TERRORISTS') return 'T';
  if (team.id === 3) return 'CT';
  if (team.id === 2) return 'T';
  return team.name ?? 'UNKNOWN';
}

function emptyTeam(side) {
  return {
    side,
    name: side === 'CT' ? 'Counter-Terrorists' : 'Terrorists',
    score: 0,
    timeoutsRemaining: 4,
    totalMoney: 0,
    avgAdr: 0,
    totalDamage: 0,
  };
}

function emptyRound(number = 0) {
  return {
    number,
    phase: 'Idle',
    bomb: { status: 'carried' },
    kills: [],
    killsBySteamId: {},
    firstKillSteamId: null,
    firstDeathSteamId: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
  };
}

function newPlayer(entity, side) {
  return {
    steamId: entity.steamId ? String(entity.steamId) : null,
    name: entity.name,
    entityId: entity.entityId ?? null,
    isBot: entity.kind === 'bot',
    team: side,
    // Primary stats
    kills: 0,
    deaths: 0,
    assists: 0,
    headshots: 0,
    mvPs: 0,
    // Extended stats from JSON_BEGIN round_stats
    damageDealt: 0,
    adr: 0,
    hsPercent: 0,
    kdr: 0,
    enemiesFlashed: 0,
    utilityDamage: 0,
    tripleKills: 0,
    quadKills: 0,
    aces: 0,
    clutchesWon: 0,
    firstKills: 0,
    pistolKills: 0,
    sniperKills: 0,
    blindKills: 0,
    bombKills: 0,
    fireDamage: 0,
    uniqueKills: 0,
    dinks: 0,
    // Live derived (updated between JSON_BEGIN blocks)
    liveDamageDealt: 0,
    liveDamageThisRound: 0,
    weaponKills: {},
    // Equipment / round state
    health: 100,
    armor: 0,
    hasHelmet: false,
    hasDefuser: false,
    activeWeapon: null,
    secondaryWeapon: null,
    money: 0,
    grenadesThrown: 0,
    isAlive: true,
    connected: true,
  };
}

export class MatchState {
  constructor() {
    this.reset();
  }

  reset() {
    this.mapName = null;
    this.phase = 'Idle';
    this.roundNumber = 0;
    this.maxRounds = 24;
    this.ct = emptyTeam('CT');
    this.t = emptyTeam('T');
    this.players = new Map();
    this.currentRound = emptyRound();
    this.roundHistory = [];
    this.chatLog = [];
    this.damageMatrix = {}; // { "attackerSteamId->victimSteamId": { damage, hits } }
    this.startedAt = null;
    this.lastEventAt = null;
    this.eventsProcessed = 0;
  }

  snapshot() {
    const players = [...this.players.values()];
    const ctPlayers = players.filter((p) => p.team === 'CT');
    const tPlayers = players.filter((p) => p.team === 'T');
    this.ct.totalMoney = ctPlayers.reduce((s, p) => s + (p.money || 0), 0);
    this.t.totalMoney = tPlayers.reduce((s, p) => s + (p.money || 0), 0);
    this.ct.totalDamage = ctPlayers.reduce((s, p) => s + (p.damageDealt || p.liveDamageDealt || 0), 0);
    this.t.totalDamage = tPlayers.reduce((s, p) => s + (p.damageDealt || p.liveDamageDealt || 0), 0);
    this.ct.avgAdr = ctPlayers.length ? Math.round(ctPlayers.reduce((s, p) => s + (p.adr || 0), 0) / ctPlayers.length) : 0;
    this.t.avgAdr = tPlayers.length ? Math.round(tPlayers.reduce((s, p) => s + (p.adr || 0), 0) / tPlayers.length) : 0;

    return {
      mapName: this.mapName,
      phase: this.phase,
      roundNumber: this.roundNumber,
      maxRounds: this.maxRounds,
      ct: this.ct,
      t: this.t,
      players,
      currentRound: this.currentRound,
      roundHistory: this.roundHistory,
      chatLog: this.chatLog.slice(-60),
      damageMatrix: this.damageMatrix,
      leaders: this.#computeLeaders(players),
      timestamp: Date.now(),
    };
  }

  #computeLeaders(players) {
    const byKills = [...players].sort((a, b) => b.kills - a.kills).slice(0, 3);
    const byAdr = [...players].sort((a, b) => (b.adr || 0) - (a.adr || 0)).slice(0, 3);
    const byHs = [...players].filter((p) => p.kills >= 3).sort((a, b) => (b.hsPercent || 0) - (a.hsPercent || 0)).slice(0, 3);
    const byDmg = [...players].sort((a, b) => (b.damageDealt || b.liveDamageDealt || 0) - (a.damageDealt || a.liveDamageDealt || 0)).slice(0, 3);
    const byClutches = [...players].filter((p) => (p.clutchesWon || 0) > 0).sort((a, b) => b.clutchesWon - a.clutchesWon).slice(0, 3);
    const byFirstKills = [...players].filter((p) => (p.firstKills || 0) > 0).sort((a, b) => b.firstKills - a.firstKills).slice(0, 3);
    const byUtil = [...players].filter((p) => (p.utilityDamage || 0) > 0).sort((a, b) => b.utilityDamage - a.utilityDamage).slice(0, 3);
    const byMvps = [...players].filter((p) => (p.mvPs || 0) > 0).sort((a, b) => b.mvPs - a.mvPs).slice(0, 3);
    const shape = (arr, field) => arr.map((p) => ({ name: p.name, team: p.team, value: p[field] ?? 0 }));
    return {
      kills: shape(byKills, 'kills'),
      adr: shape(byAdr, 'adr'),
      hs: byHs.map((p) => ({ name: p.name, team: p.team, value: p.hsPercent })),
      damage: byDmg.map((p) => ({ name: p.name, team: p.team, value: p.damageDealt || p.liveDamageDealt || 0 })),
      clutches: shape(byClutches, 'clutchesWon'),
      firstKills: shape(byFirstKills, 'firstKills'),
      utility: shape(byUtil, 'utilityDamage'),
      mvps: shape(byMvps, 'mvPs'),
    };
  }

  ingestBatch(body) {
    const rawLines = body.split(/\r?\n/);
    const events = [];
    let jsonBlock = null;

    for (const rawLine of rawLines) {
      const content = rawLine
        .replace(/^L\s+/, '')
        .replace(/^(\d{2}\/\d{2}\/\d{4}) - (\d{2}:\d{2}:\d{2})(?:\.\d+)? - /, '')
        .trim();

      if (jsonBlock) {
        jsonBlock.push(content);
        if (content.includes('JSON_END')) {
          this.#applyRoundStatsBlock(jsonBlock);
          jsonBlock = null;
        }
        continue;
      }
      if (content.startsWith('JSON_BEGIN')) {
        jsonBlock = [content];
        continue;
      }

      const ev = this.ingestLine(rawLine);
      if (ev) events.push(ev);
    }

    return events;
  }

  ingestLine(rawLine) {
    let stripped = rawLine.replace(/^L\s+/, '').trim();
    if (!stripped) return null;
    stripped = stripped.replace(
      /^(\d{2}\/\d{2}\/\d{4}) - (\d{2}:\d{2}:\d{2})(?:\.\d+)? - /,
      '$1 - $2: ',
    );

    let bombsite = null;
    const siteMatch = stripped.match(/ at bombsite ([A-Za-z0-9]+)\s*$/);
    if (siteMatch) {
      bombsite = siteMatch[1];
      stripped = stripped.replace(/ at bombsite [A-Za-z0-9]+\s*$/, '');
    }

    let event;
    try {
      event = parse(stripped);
    } catch {
      return null;
    }
    if (!event) return null;
    if (bombsite && event.payload) event.payload._bombsite = bombsite;

    this.lastEventAt = Date.now();
    this.eventsProcessed++;
    this.#apply(event);
    return event;
  }

  #player(entity) {
    if (!entity || (entity.kind !== 'player' && entity.kind !== 'bot')) return null;
    const key = entity.steamId ? String(entity.steamId) : `name:${entity.name}`;
    let p = this.players.get(key);
    const side = sideFromTeam(entity.team);
    if (!p) {
      p = newPlayer(entity, side);
      this.players.set(key, p);
    } else {
      if (entity.name) p.name = entity.name;
      if (side !== 'UNKNOWN') p.team = side;
    }
    return p;
  }

  #apply(event) {
    switch (event.type) {
      case 'connection': return this.#onConnection(event);
      case 'switched_team': return this.#onSwitchedTeam(event);
      case 'team_name': return this.#onTeamName(event);
      case 'killed': return this.#onKilled(event);
      case 'assist': return this.#onAssist(event);
      case 'suicide': return this.#onSuicide(event);
      case 'attacked': return this.#onAttacked(event);
      case 'purchased': return this.#onPurchased(event);
      case 'left_buyzone_with': return this.#onLeftBuyzone(event);
      case 'threw': return this.#onThrew(event);
      case 'say': return this.#onSay(event);
      case 'team_triggered': return this.#onTeamTriggered(event);
      case 'entity_triggered': return this.#onEntityTriggered(event);
      case 'scored': return this.#onScored(event);
      case 'server_cvar': return this.#onServerCvar(event);
      case 'server_log': return this.#onServerLog(event);
      default: return null;
    }
  }

  #onConnection(event) {
    const p = this.#player(event.payload.player);
    if (!p) return;
    p.connected = event.payload.kind !== 'disconnected';
  }

  #onSwitchedTeam(event) {
    const p = this.#player(event.payload.player);
    if (!p) return;
    p.team = sideFromTeam(event.payload.toTeam);
  }

  #onTeamName(event) {
    const side = sideFromTeam(event.payload.team);
    if (side === 'CT') this.ct.name = event.payload.name;
    else if (side === 'T') this.t.name = event.payload.name;
  }

  #onKilled(event) {
    const attacker = this.#player(event.payload.attacker);
    const victim = this.#player(event.payload.victim);
    const modifiers = event.payload.modifiers ?? [];
    const headshot = modifiers.includes('headshot');
    const weapon = stripWeaponPrefix(event.payload.weaponName ?? '').toLowerCase();

    if (victim) {
      victim.deaths++;
      victim.health = 0;
      victim.isAlive = false;
    }
    if (attacker && attacker !== victim) {
      attacker.kills++;
      if (headshot) attacker.headshots++;
      attacker.weaponKills[weapon] = (attacker.weaponKills[weapon] ?? 0) + 1;
    }

    // Per-round multi-kill + first blood tracking
    const atkId = attacker?.steamId ?? (attacker ? `name:${attacker.name}` : null);
    let multiKillLabel = null;
    if (atkId) {
      const count = (this.currentRound.killsBySteamId[atkId] ?? 0) + 1;
      this.currentRound.killsBySteamId[atkId] = count;
      multiKillLabel = MULTI_KILL_LABELS[Math.min(count, 5)];
    }
    const isFirstKill = this.currentRound.kills.length === 0;
    if (isFirstKill) {
      this.currentRound.firstKillSteamId = attacker?.steamId ?? null;
      this.currentRound.firstDeathSteamId = victim?.steamId ?? null;
    }

    this.currentRound.kills.push({
      attacker: attacker?.name ?? event.payload.attacker?.name ?? null,
      attackerSteamId: attacker?.steamId ?? null,
      attackerTeam: attacker?.team ?? null,
      victim: victim?.name ?? event.payload.victim?.name ?? null,
      victimSteamId: victim?.steamId ?? null,
      victimTeam: victim?.team ?? null,
      weapon,
      headshot,
      penetrated: modifiers.includes('penetrated'),
      noscope: modifiers.includes('noscope'),
      throughSmoke: modifiers.includes('smoke'),
      attackerBlind: modifiers.includes('attackerblind'),
      isFirstKill,
      multiKill: multiKillLabel,
      at: event.receivedAt,
    });
  }

  #onAssist(event) {
    const assister = this.#player(event.payload.assistant);
    if (assister) assister.assists++;
  }

  #onSuicide(event) {
    const victim = this.#player(event.payload.player ?? event.payload.entity);
    if (!victim) return;
    victim.deaths++;
    victim.health = 0;
    victim.isAlive = false;
  }

  #onAttacked(event) {
    const victim = this.#player(event.payload.victim);
    const attacker = this.#player(event.payload.attacker);
    const dmg = Math.max(0, Number(event.payload.damageAmount) || 0);

    if (victim) {
      if (typeof event.payload.remainingHealth === 'number') {
        victim.health = event.payload.remainingHealth;
        victim.isAlive = victim.health > 0;
      }
      if (typeof event.payload.remainingArmour === 'number') {
        victim.armor = event.payload.remainingArmour;
      }
    }
    if (attacker && attacker !== victim && dmg > 0) {
      attacker.liveDamageDealt += dmg;
      attacker.liveDamageThisRound += dmg;

      const atkId = attacker.steamId ?? `name:${attacker.name}`;
      const vicId = victim?.steamId ?? `name:${victim?.name ?? 'unknown'}`;
      const key = `${atkId}->${vicId}`;
      if (!this.damageMatrix[key]) {
        this.damageMatrix[key] = {
          attackerName: attacker.name, attackerSteamId: attacker.steamId,
          victimName: victim?.name ?? null, victimSteamId: victim?.steamId ?? null,
          damage: 0, hits: 0,
        };
      }
      this.damageMatrix[key].damage += dmg;
      this.damageMatrix[key].hits += 1;
    }
  }

  #onPurchased(event) {
    const p = this.#player(event.payload.player);
    if (!p) return;
    const item = stripWeaponPrefix(event.payload.weaponName ?? '').toLowerCase();
    if (item === 'vest') {
      p.armor = 100; p.hasHelmet = false;
    } else if (item === 'vesthelm') {
      p.armor = 100; p.hasHelmet = true;
    } else if (item === 'defuser') {
      p.hasDefuser = true;
    } else if (PRIMARIES.has(item)) {
      p.activeWeapon = item;
    } else if (SECONDARIES.has(item)) {
      p.secondaryWeapon = item;
      if (!p.activeWeapon || !PRIMARIES.has(p.activeWeapon)) p.activeWeapon = item;
    }
  }

  #onLeftBuyzone(event) {
    const p = this.#player(event.payload.entity);
    if (!p) return;
    const items = event.payload.value ?? [];
    let primary = null;
    let secondary = null;
    for (const raw of items) {
      const it = stripWeaponPrefix(raw).toLowerCase();
      const kev = it.match(/^kevlar\((\d+)\)$/);
      if (kev) { p.armor = Number(kev[1]); continue; }
      if (it === 'helmet') { p.hasHelmet = true; continue; }
      if (it === 'defuser') { p.hasDefuser = true; continue; }
      if (PRIMARIES.has(it)) primary = it;
      else if (SECONDARIES.has(it) && !secondary) secondary = it;
    }
    p.activeWeapon = primary ?? secondary ?? p.activeWeapon;
    p.secondaryWeapon = secondary ?? p.secondaryWeapon;
  }

  #onThrew(event) {
    const p = this.#player(event.payload.player);
    if (!p) return;
    const item = stripWeaponPrefix(event.payload.item ?? '').toLowerCase();
    if (GRENADES.has(item)) p.grenadesThrown++;
  }

  #onSay(event) {
    const player = event.payload.player;
    const msg = String(event.payload.message ?? '').trim();
    if (!msg) return;
    this.chatLog.push({
      name: player?.name ?? 'unknown',
      steamId: player?.steamId ? String(player.steamId) : null,
      team: sideFromTeam(player?.team),
      to: event.payload.to ?? 'global',
      message: msg,
      at: event.receivedAt,
    });
    if (this.chatLog.length > 200) this.chatLog.shift();
  }

  #onTeamTriggered(event) {
    const reason = WIN_REASON_MAP[event.payload.kind] ?? event.payload.kind;
    const winningSide = sideFromTeam(event.payload.team);
    const ctScore = event.payload.counterTerroristScore ?? this.ct.score;
    const tScore = event.payload.terroristScore ?? this.t.score;
    this.ct.score = ctScore;
    this.t.score = tScore;

    // Round history entry
    const round = this.currentRound;
    const killsByPlayer = {};
    for (const k of round.kills) {
      if (!k.attackerSteamId && !k.attacker) continue;
      const id = k.attackerSteamId ?? `name:${k.attacker}`;
      killsByPlayer[id] = (killsByPlayer[id] ?? 0) + 1;
    }
    let topFragger = null;
    let topFraggerKills = 0;
    for (const [id, n] of Object.entries(killsByPlayer)) {
      if (n > topFraggerKills) {
        topFraggerKills = n;
        const p = this.players.get(id);
        topFragger = p ? { name: p.name, team: p.team, kills: n } : null;
      }
    }
    const firstKiller = round.firstKillSteamId ? this.players.get(round.firstKillSteamId) : null;

    round.endedAt = event.receivedAt;
    round.durationMs = round.startedAt ? (Date.parse(event.receivedAt) - Date.parse(round.startedAt)) : null;
    round.phase = 'Ended';
    if (event.payload.kind === 'sfui_notice_target_bombed') {
      round.bomb.status = 'exploded';
    }

    this.roundHistory.push({
      round: this.roundNumber || this.roundHistory.length + 1,
      winner: winningSide,
      reason,
      ctScore,
      tScore,
      bombSite: round.bomb.site ?? null,
      bombStatus: round.bomb.status,
      planter: round.bomb.planter ?? null,
      defuser: round.bomb.defuser ?? null,
      topFragger,
      firstKiller: firstKiller ? { name: firstKiller.name, team: firstKiller.team } : null,
      kills: round.kills.length,
      durationMs: round.durationMs,
      endedAt: event.receivedAt,
    });

    // Reset live per-round damage
    for (const p of this.players.values()) p.liveDamageThisRound = 0;

    this.phase = this.#matchPhaseFromScores();
  }

  #onEntityTriggered(event) {
    const kind = event.payload.kind;
    const bomb = this.currentRound.bomb;
    const entName = event.payload.entity?.name ?? null;
    switch (kind) {
      case 'planted_the_bomb':
        bomb.status = 'planted';
        bomb.planter = entName;
        bomb.plantedAt = Date.now();
        if (event.payload._bombsite) bomb.site = event.payload._bombsite;
        break;
      case 'bomb_begin_plant':
        bomb.status = 'planting';
        bomb.planter = entName;
        if (event.payload._bombsite) bomb.site = event.payload._bombsite;
        break;
      case 'defused_the_bomb':
        bomb.status = 'defused';
        bomb.defuser = entName;
        break;
      case 'begin_bomb_defuse_with_kit':
      case 'begin_bomb_defuse_without_kit':
        bomb.status = 'defusing';
        bomb.defuser = entName;
        break;
      case 'dropped_the_bomb':
        bomb.status = 'dropped';
        bomb.carrier = null;
        break;
      case 'got_the_bomb':
        bomb.status = 'carried';
        bomb.carrier = entName;
        break;
      case 'round_start':
        this.#onRoundStart(event.receivedAt);
        break;
      case 'round_end':
        this.currentRound.phase = 'Ended';
        break;
      case 'match_start':
        this.phase = 'Live';
        this.startedAt = event.receivedAt;
        if (event.payload.value) this.mapName = event.payload.value;
        break;
      case 'game_commencing':
        this.phase = 'Warmup';
        break;
      default:
        break;
    }
  }

  #onRoundStart(timestamp) {
    this.roundNumber++;
    this.currentRound = emptyRound(this.roundNumber);
    this.currentRound.phase = 'Live';
    this.currentRound.startedAt = timestamp;
    for (const p of this.players.values()) {
      p.health = 100;
      p.isAlive = true;
      p.liveDamageThisRound = 0;
      // grenadesThrown stays as match-total
    }
    if (this.phase === 'Idle' || this.phase === 'Warmup') this.phase = 'Live';
  }

  #onScored(event) {
    const side = sideFromTeam(event.payload.team);
    if (side === 'CT') this.ct.score = event.payload.score;
    else if (side === 'T') this.t.score = event.payload.score;
  }

  #onServerCvar(event) {
    if (event.payload.name === 'mp_maxrounds') {
      const n = Number(event.payload.value);
      if (!Number.isNaN(n)) this.maxRounds = n;
    }
  }

  #onServerLog(event) {
    const p = event.payload ?? {};
    if (p.kind === 'map' && p.state === 'loading' && p.map) {
      this.mapName = p.map;
    }
  }

  #applyRoundStatsBlock(lines) {
    const joined = lines.join('\n');
    const fieldsMatch = joined.match(/"fields"\s*:\s*"([^"]+)"/);
    if (!fieldsMatch) return;
    const fieldNames = fieldsMatch[1].split(',').map((s) => s.trim());
    const playerRe = /"player_\d+"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = playerRe.exec(joined))) {
      const values = m[1].split(',').map((s) => s.trim());
      const row = Object.fromEntries(fieldNames.map((k, i) => [k, values[i]]));
      const accountId = row.accountid;
      const steamId = accountIdToSteamId(accountId);
      if (!steamId) continue; // bot
      let p = this.players.get(steamId);
      if (!p) {
        p = newPlayer({ steamId, name: 'Unknown', kind: 'player' }, 'UNKNOWN');
        this.players.set(steamId, p);
      }
      if (row.team === '3') p.team = 'CT';
      else if (row.team === '2') p.team = 'T';
      p.money = Number(row.money) || 0;
      p.damageDealt = Number(row.dmg) || 0;
      p.adr = Number(row.adr) || 0;
      p.hsPercent = Number(row.hsp) || 0;
      p.kdr = Number(row.kdr) || 0;
      p.mvPs = Number(row.mvp) || 0;
      p.enemiesFlashed = Number(row.ef) || 0;
      p.utilityDamage = Number(row.ud) || 0;
      p.tripleKills = Number(row['3k']) || 0;
      p.quadKills = Number(row['4k']) || 0;
      p.aces = Number(row['5k']) || 0;
      p.clutchesWon = Number(row.clutchk) || 0;
      p.firstKills = Number(row.firstk) || 0;
      p.pistolKills = Number(row.pistolk) || 0;
      p.sniperKills = Number(row.sniperk) || 0;
      p.blindKills = Number(row.blindk) || 0;
      p.bombKills = Number(row.bombk) || 0;
      p.fireDamage = Number(row.firedmg) || 0;
      p.uniqueKills = Number(row.uniquek) || 0;
      p.dinks = Number(row.dinks) || 0;
      // Authoritative K/D/A from server stats block
      if (row.kills !== undefined) p.kills = Number(row.kills) || p.kills;
      if (row.deaths !== undefined) p.deaths = Number(row.deaths) || p.deaths;
      if (row.assists !== undefined) p.assists = Number(row.assists) || p.assists;
    }
  }

  #matchPhaseFromScores() {
    const total = this.ct.score + this.t.score;
    if (this.maxRounds > 0 && total >= this.maxRounds) return 'Ended';
    if (this.maxRounds > 0 && total === Math.floor(this.maxRounds / 2)) return 'Halftime';
    return 'Live';
  }
}
