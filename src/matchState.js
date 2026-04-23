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
const GRENADES = new Set([
  'hegrenade', 'flashbang', 'smokegrenade', 'molotov', 'incgrenade',
  'decoy', 'inferno', 'frag_grenade',
]);

function stripWeaponPrefix(s) {
  return String(s).replace(/^weapon_/, '');
}

function sideFromTeam(team) {
  if (!team) return 'UNKNOWN';
  if (team.name === 'COUNTER_TERRORISTS') return 'CT';
  if (team.name === 'TERRORISTS') return 'T';
  return team.name ?? 'UNKNOWN';
}

function emptyTeam(side) {
  return {
    side,
    name: side === 'CT' ? 'Counter-Terrorists' : 'Terrorists',
    score: 0,
    timeoutsRemaining: 4,
  };
}

function emptyRound(number = 0) {
  return { number, phase: 'Idle', bomb: { status: 'carried' }, kills: [] };
}

function newPlayer(entity, side) {
  return {
    steamId: entity.steamId ? String(entity.steamId) : null,
    name: entity.name,
    entityId: entity.entityId ?? null,
    isBot: entity.kind === 'bot',
    team: side,
    kills: 0,
    deaths: 0,
    assists: 0,
    headshots: 0,
    mvPs: 0,
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
    this.startedAt = null;
    this.lastEventAt = null;
    this.eventsProcessed = 0;
  }

  snapshot() {
    return {
      mapName: this.mapName,
      phase: this.phase,
      roundNumber: this.roundNumber,
      maxRounds: this.maxRounds,
      ct: this.ct,
      t: this.t,
      players: [...this.players.values()],
      currentRound: this.currentRound,
      roundHistory: this.roundHistory,
      timestamp: Date.now(),
    };
  }

  ingestLine(rawLine) {
    const stripped = rawLine.replace(/^L\s+/, '').trim();
    if (!stripped) return null;

    let event;
    try {
      event = parse(stripped);
    } catch {
      return null;
    }
    if (!event) return null;

    this.lastEventAt = Date.now();
    this.eventsProcessed++;
    this.#apply(event);
    return event;
  }

  ingestBatch(body) {
    const lines = body.split(/\r?\n/);
    const events = [];
    for (const line of lines) {
      const ev = this.ingestLine(line);
      if (ev) events.push(ev);
    }
    return events;
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

    if (victim) {
      victim.deaths++;
      victim.health = 0;
      victim.isAlive = false;
    }
    if (attacker && attacker !== victim) {
      attacker.kills++;
      if (headshot) attacker.headshots++;
    }
    this.currentRound.kills.push({
      attacker: attacker?.name ?? event.payload.attacker?.name ?? null,
      attackerSteamId: attacker?.steamId ?? null,
      victim: victim?.name ?? event.payload.victim?.name ?? null,
      victimSteamId: victim?.steamId ?? null,
      weapon: event.payload.weaponName,
      headshot,
      penetrated: modifiers.includes('penetrated'),
      noscope: modifiers.includes('noscope'),
      throughSmoke: modifiers.includes('smoke'),
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
    if (!victim) return;
    if (typeof event.payload.remainingHealth === 'number') {
      victim.health = event.payload.remainingHealth;
      victim.isAlive = victim.health > 0;
    }
    if (typeof event.payload.remainingArmour === 'number') {
      victim.armor = event.payload.remainingArmour;
    }
  }

  #onPurchased(event) {
    const p = this.#player(event.payload.player);
    if (!p) return;
    const item = stripWeaponPrefix(event.payload.weaponName ?? '').toLowerCase();
    if (item === 'vest') {
      p.armor = 100;
      p.hasHelmet = false;
    } else if (item === 'vesthelm') {
      p.armor = 100;
      p.hasHelmet = true;
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

  #onTeamTriggered(event) {
    const reason = WIN_REASON_MAP[event.payload.kind] ?? event.payload.kind;
    const winningSide = sideFromTeam(event.payload.team);
    const ctScore = event.payload.counterTerroristScore ?? this.ct.score;
    const tScore = event.payload.terroristScore ?? this.t.score;
    this.ct.score = ctScore;
    this.t.score = tScore;
    this.roundHistory.push({
      round: this.roundNumber || this.roundHistory.length + 1,
      winner: winningSide,
      reason,
      ctScore,
      tScore,
      endedAt: event.receivedAt,
    });
    this.currentRound.phase = 'Ended';
    if (event.payload.kind === 'sfui_notice_target_bombed') {
      this.currentRound.bomb.status = 'exploded';
    }
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
        this.#onRoundStart();
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

  #onRoundStart() {
    this.roundNumber++;
    this.currentRound = emptyRound(this.roundNumber);
    this.currentRound.phase = 'Live';
    for (const p of this.players.values()) {
      p.health = 100;
      p.isAlive = true;
      p.grenadesThrown = 0;
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

  #matchPhaseFromScores() {
    const total = this.ct.score + this.t.score;
    if (this.maxRounds > 0 && total >= this.maxRounds) return 'Ended';
    if (this.maxRounds > 0 && total === Math.floor(this.maxRounds / 2)) return 'Halftime';
    return 'Live';
  }
}
