require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM_PIN = process.env.ROOM_PIN || null;

const WORLD = { width: 4200, height: 4200 };
const BASE_MASS = 20;
const MIN_MASS = 12;
const MAX_MASS = 160;
const MASS_DECAY_PER_SECOND = 2.5;
const BASE_SPEED = 190;
const MASS_SPEED_SLOW_FACTOR = 0.45;
const OSTEOBLAST_SPEED_FACTOR = 0.8;
const MASS_EAT_RATIO = 1.4;
const INVULNERABLE_MS = 2500;
const PELLET_TARGET = 180;

const DEFAULT_CELL_TYPE = 'progenitor';

const CELL_ARCHETYPES = Object.freeze({
  progenitor: {
    id: 'progenitor',
    label: 'Mesenchymal Capsule',
    description: 'Balanced starter cell that adapts quickly to any cue.',
    color: 0x7fd1b9,
    shape: 'capsule',
    modifiers: { speed: 1.0, decay: 1.0, mineral: 1.0, diff: 1.0, capture: 1.0, radius: 1.0, diagonal: 1.0 },
  },
  osteoblast: {
    id: 'osteoblast',
    label: 'Osteoblast Prism',
    description: 'Matrix-secreting specialist that excels at biomineralization.',
    color: 0xf4a261,
    shape: 'square',
    modifiers: { speed: 0.95, decay: 0.88, mineral: 1.45, diff: 1.3, capture: 1.05, radius: 1.08, diagonal: 1.0 },
  },
  osteocyte: {
    id: 'osteocyte',
    label: 'Osteocyte Dendrite',
    description: 'Embedded sensor that thrives on mechanical signals and flow.',
    color: 0x90be6d,
    shape: 'star',
    modifiers: { speed: 1.05, decay: 0.95, mineral: 1.2, diff: 1.1, capture: 1.1, radius: 0.95, diagonal: 1.25 },
  },
  osteoclast: {
    id: 'osteoclast',
    label: 'Osteoclast Apex',
    description: 'Aggressive resorber that trades stability for bursts of power.',
    color: 0xe63946,
    shape: 'triangle',
    modifiers: { speed: 1.2, decay: 1.32, mineral: 0.65, diff: 0.92, capture: 1.4, radius: 1.12, diagonal: 0.9 },
  },
});

const CELL_ARCHETYPE_LIST = Object.freeze(
  Object.values(CELL_ARCHETYPES).map((arc) => ({
    id: arc.id,
    label: arc.label,
    description: arc.description,
    color: arc.color,
    shape: arc.shape,
    modifiers: arc.modifiers,
  }))
);

const EFFECTS = Object.freeze({
  vitamin_c: { id: 'vitamin_c', speed: 1.35, diagonal: 1.2, durationMs: 5500 },
  vitamin_d: { id: 'vitamin_d', mineral: 1.6, diff: 1.2, durationMs: 6200 },
  vitamin_k: { id: 'vitamin_k', decay: 0.55, diagonal: 1.35, durationMs: 5200 },
  steroid: { id: 'steroid', speed: 0.75, capture: 1.5, radius: 1.08, durationMs: 6800 },
  flow_shear: { id: 'flow_shear', speed: 1.12, decay: 0.7, durationMs: 4200 },
});

const PELLET_TYPES = Object.freeze([
  {
    id: 'vitamin_c',
    label: 'Vitamin C',
    description: 'Collagen boost that sharpens motility and diagonal bursts.',
    shape: 'triangle',
    color: 0xffad69,
    massGain: 1.6,
    mineralPulse: 0,
    effect: 'vitamin_c',
  },
  {
    id: 'vitamin_d',
    label: 'Vitamin D',
    description: 'Calcification spark that amplifies biomineral deposition.',
    shape: 'diamond',
    color: 0xffd166,
    massGain: 1.8,
    mineralPulse: 2.4,
    effect: 'vitamin_d',
  },
  {
    id: 'vitamin_k',
    label: 'Vitamin K',
    description: 'Matrix modifier that steadies drift and rewards diagonals.',
    shape: 'hex',
    color: 0x80ed99,
    massGain: 1.2,
    mineralPulse: 0.6,
    effect: 'vitamin_k',
  },
  {
    id: 'steroid',
    label: 'Steroid',
    description: 'Power anabolic that bulks mass but dampens agility.',
    shape: 'square',
    color: 0xb388eb,
    massGain: 3.4,
    mineralPulse: 1.2,
    effect: 'steroid',
  },
]);

const PELLET_TYPE_MAP = Object.freeze(
  Object.fromEntries(PELLET_TYPES.map((pt) => [pt.id, pt]))
);

const CUE_TEMPLATES = Object.freeze([
  { id: 'growth', shape: 'circle', count: 12, radius: [140, 240], props: { strength: [0.6, 1.4] } },
  { id: 'nutrient', shape: 'hex', count: 12, radius: [120, 210], props: { rate: [1.4, 2.2] } },
  { id: 'mineral', shape: 'square', count: 10, radius: [120, 190], props: { rate: [0.7, 1.3] } },
  { id: 'mechanical', shape: 'diamond', count: 10, radius: [130, 220], props: { intensity: [0.6, 1.1] } },
  { id: 'hormonal', shape: 'triangle', count: 8, radius: [140, 210], props: { potency: [0.8, 1.4] } },
  { id: 'flow', shape: 'capsule', count: 8, radius: [160, 230], props: { shear: [0.5, 1.0] } },
]);

const CUE_TYPE_MAP = Object.freeze(
  Object.fromEntries(CUE_TEMPLATES.map((cfg) => [cfg.id, cfg]))
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function randomPoint() {
  return {
    x: rand(200, WORLD.width - 200),
    y: rand(200, WORLD.height - 200),
  };
}

function randomFrom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function sanitizeCellType(raw) {
  if (raw && CELL_ARCHETYPES[raw]) return raw;
  return DEFAULT_CELL_TYPE;
}

function manifestPayload() {
  return {
    cellArchetypes: CELL_ARCHETYPE_LIST,
    pelletTypes: PELLET_TYPES.map((pt) => ({
      id: pt.id,
      label: pt.label,
      description: pt.description,
      shape: pt.shape,
      color: pt.color,
      effect: pt.effect ? { kind: pt.effect, durationMs: EFFECTS[pt.effect]?.durationMs || 0 } : null,
      mineralPulse: pt.mineralPulse,
      massGain: pt.massGain,
    })),
  };
}

function ensurePlayerState(player) {
  if (!Array.isArray(player.effects)) player.effects = [];
  if (!player.activeModifiers) player.activeModifiers = { ...CELL_ARCHETYPES[sanitizeCellType(player.cellType)].modifiers };
  return player;
}

function applyEffect(player, kind, now, { durationFactor = 1 } = {}) {
  const effect = EFFECTS[kind];
  if (!effect) return null;
  const duration = Math.max(0, Math.round((effect.durationMs || 0) * durationFactor));
  if (duration <= 0) return null;
  ensurePlayerState(player);
  player.effects = player.effects.filter((e) => e.kind !== kind);
  const expiresAt = now + duration;
  player.effects.push({ kind, expiresAt });
  return expiresAt;
}

function resolveModifiers(player, now = Date.now()) {
  ensurePlayerState(player);
  const archetype = CELL_ARCHETYPES[sanitizeCellType(player.cellType)];
  const mods = { ...archetype.modifiers };
  player.effects = player.effects.filter((effect) => effect.expiresAt > now);
  for (const effect of player.effects) {
    const cfg = EFFECTS[effect.kind];
    if (!cfg) continue;
    if (typeof cfg.speed === 'number') mods.speed *= cfg.speed;
    if (typeof cfg.decay === 'number') mods.decay *= cfg.decay;
    if (typeof cfg.mineral === 'number') mods.mineral *= cfg.mineral;
    if (typeof cfg.diff === 'number') mods.diff *= cfg.diff;
    if (typeof cfg.capture === 'number') mods.capture *= cfg.capture;
    if (typeof cfg.radius === 'number') mods.radius *= cfg.radius;
    if (typeof cfg.diagonal === 'number') mods.diagonal *= cfg.diagonal;
  }
  player.activeModifiers = mods;
  return mods;
}

function calcRadius(player) {
  const mods = player.activeModifiers || resolveModifiers(player);
  const base = 12 + Math.sqrt(player.mass);
  let radius = base * (mods.radius || 1);
  if (player.morph === 'elongated') radius *= 1.25;
  else if (player.morph === 'hypertrophic') radius *= 1.1;
  return radius;
}

function calcSpeed(player, modsOverride) {
  const massPenalty = 1 - Math.min(0.6, (player.mass - BASE_MASS) / (MAX_MASS * MASS_SPEED_SLOW_FACTOR));
  const stateFactor = player.state === 'osteoblast' ? OSTEOBLAST_SPEED_FACTOR : 1;
  const mods = modsOverride || player.activeModifiers || resolveModifiers(player);
  let speed = BASE_SPEED * Math.max(0.35, massPenalty) * stateFactor * (mods.speed || 1);
  if (mods.diagonal && Math.abs(player.input.dx) > 0 && Math.abs(player.input.dy) > 0) {
    speed *= mods.diagonal;
  }
  return speed;
}

function createPellet(opts = {}) {
  const { x, y, type: explicitType } = opts;
  const typeId = sanitizePelletType(explicitType);
  const type = PELLET_TYPE_MAP[typeId];
  const spawnPoint = typeof x === 'number' && typeof y === 'number' ? { x, y } : randomPoint();
  return {
    id: randomUUID().slice(0, 8),
    x: spawnPoint.x,
    y: spawnPoint.y,
    type: type.id,
  };
}

function sanitizePelletType(typeId) {
  if (typeId && PELLET_TYPE_MAP[typeId]) return typeId;
  return randomFrom(PELLET_TYPES).id;
}

function createRoom({ pin = DEFAULT_ROOM_PIN } = {}) {
  const id = randomUUID().slice(0, 6).toUpperCase();
  const now = Date.now();
  const room = {
    id,
    pin: pin || null,
    createdAt: now,
    lastTick: now,
    players: new Map(),
    cues: generateCues(),
    pellets: Array.from({ length: PELLET_TARGET }, () => createPellet()),
    scoreboard: {},
    maxPlayers: 48,
    round: {
      phase: 'lobby', // lobby | countdown | playing | ended
      countdownMs: 5000,
      durationMs: 180000,
      remainingMs: 0,
      startedAt: 0,
      endedAt: 0,
    },
  };
  rooms.set(id, room);
  // Seed a pellet cluster near the center for immediate interaction
  const cx = WORLD.width / 2, cy = WORLD.height / 2;
  for (let i = 0; i < 80; i++) {
    const px = cx + rand(-220, 220);
    const py = cy + rand(-220, 220);
    room.pellets.push(createPellet({ x: px, y: py }));
  }
  return room;
}

function generateCues() {
  const cues = [];
  for (const cfg of CUE_TEMPLATES) {
    for (let i = 0; i < cfg.count; i++) {
      const { x, y } = randomPoint();
      const cue = {
        id: `${cfg.id}-${i}-${randomUUID().slice(0, 4)}`,
        type: cfg.id,
        shape: cfg.shape,
        x,
        y,
        r: rand(cfg.radius[0], cfg.radius[1]),
      };
      if (cfg.props) {
        for (const [key, range] of Object.entries(cfg.props)) {
          cue[key] = rand(range[0], range[1]);
        }
      }
      cues.push(cue);
    }
  }
  // Ensure some cues are visible near the world center
  const cx = WORLD.width / 2, cy = WORLD.height / 2;
  cues.push({ id: 'center-growth', type: 'growth', shape: 'circle', x: cx - 200, y: cy, r: 180, strength: 1.2 });
  cues.push({ id: 'center-nutrient', type: 'nutrient', shape: 'hex', x: cx + 220, y: cy, r: 160, rate: 1.9 });
  cues.push({ id: 'center-mineral', type: 'mineral', shape: 'square', x: cx, y: cy - 240, r: 150, rate: 1.1 });
  cues.push({ id: 'center-mech', type: 'mechanical', shape: 'diamond', x: cx, y: cy + 240, r: 170, intensity: 0.95 });
  cues.push({ id: 'center-hormone', type: 'hormonal', shape: 'triangle', x: cx - 120, y: cy - 260, r: 150, potency: 1.2 });
  cues.push({ id: 'center-flow', type: 'flow', shape: 'capsule', x: cx + 160, y: cy + 260, r: 190, shear: 0.9 });
  return cues;
}

function spawnPlayer(opts) {
  const { x, y } = randomPoint();
  const now = Date.now();
  const cellType = sanitizeCellType(opts.cellType);
  const archetype = CELL_ARCHETYPES[cellType] || CELL_ARCHETYPES[DEFAULT_CELL_TYPE];
  return {
    id: opts.id,
    name: opts.name,
    cellType,
    x,
    y,
    vx: 0,
    vy: 0,
    input: { dx: 0, dy: 0 },
    state: 'progenitor',
    diffProgress: 0,
    mineralized: 0,
    mass: BASE_MASS,
    captures: 0,
    elongation: 0,
    morph: 'round',
    invulnerableUntil: now + INVULNERABLE_MS,
    lastEatenAt: 0,
    effects: [],
    activeModifiers: { ...archetype.modifiers },
    lastPellet: null,
  };
}

function respawnPlayer(player) {
  const { x, y } = randomPoint();
  const now = Date.now();
  player.x = x;
  player.y = y;
  player.vx = 0;
  player.vy = 0;
  player.input.dx = 0;
  player.input.dy = 0;
  player.state = 'progenitor';
  player.diffProgress = 0;
  player.mineralized = 0;
  player.mass = BASE_MASS;
  player.elongation = 0;
  player.morph = 'round';
  player.invulnerableUntil = now + INVULNERABLE_MS;
  player.lastEatenAt = now;
  player.effects = [];
  player.activeModifiers = { ...CELL_ARCHETYPES[sanitizeCellType(player.cellType)].modifiers };
  player.lastPellet = null;
}

function applyCues(player, room, dt, now) {
  if (room.round.phase !== 'playing') return; // no cue effects outside play
  const mods = player.activeModifiers || resolveModifiers(player, now);
  for (const cue of room.cues) {
    const dx = cue.x - player.x;
    const dy = cue.y - player.y;
    if ((dx * dx + dy * dy) > cue.r * cue.r) continue;
    switch (cue.type) {
      case 'growth':
        player.diffProgress += (cue.strength || 1) * dt * (mods.diff || 1);
        break;
      case 'nutrient':
        player.mass = Math.min(MAX_MASS, player.mass + (cue.rate || 1.5) * dt * (mods.mineral || 1));
        break;
      case 'mineral':
        if (player.state === 'osteoblast') {
          const gain = (cue.rate || 0.8) * dt * (mods.mineral || 1);
          player.mineralized += gain;
          player.mass = Math.min(MAX_MASS, player.mass + gain * 0.45);
        }
        break;
      case 'mechanical':
        player.elongation = Math.min(12, player.elongation + (cue.intensity || 0.6) * dt * (mods.diagonal || 1));
        break;
      case 'hormonal': {
        const durationFactor = (cue.potency || 1);
        applyEffect(player, 'vitamin_d', now, { durationFactor });
        player.diffProgress += 0.4 * durationFactor * dt * (mods.diff || 1);
        break;
      }
      case 'flow':
        applyEffect(player, 'flow_shear', now, { durationFactor: cue.shear || 1 });
        break;
      default:
        break;
    }
  }
}

function applyPellets(player, room, now) {
  if (room.round.phase !== 'playing') return; // only absorb pellets during play
  const radius = calcRadius(player);
  const mods = player.activeModifiers || resolveModifiers(player, now);
  for (let i = room.pellets.length - 1; i >= 0; i--) {
    const pellet = room.pellets[i];
    const dx = pellet.x - player.x;
    const dy = pellet.y - player.y;
    if ((dx * dx + dy * dy) <= (radius + 12) * (radius + 12)) {
      const type = PELLET_TYPE_MAP[pellet.type];
      if (type) {
        player.mass = Math.min(MAX_MASS, player.mass + type.massGain);
        if (type.mineralPulse) {
          player.mineralized += type.mineralPulse * (mods.mineral || 1);
        }
        let expiresAt = null;
        if (type.effect) {
          expiresAt = applyEffect(player, type.effect, now);
          resolveModifiers(player, now);
        }
        player.lastPellet = { type: type.id, expiresAt };
      }
      room.pellets.splice(i, 1);
    }
  }
  while (room.pellets.length < PELLET_TARGET) {
    room.pellets.push(createPellet());
  }
}

function updateMorph(player) {
  if (player.state === 'progenitor' && player.diffProgress >= 6) {
    player.state = 'osteoblast';
  }
  if ((player.mass >= 40 && player.elongation >= 4) || player.mass >= 65) {
    player.morph = 'elongated';
  } else if (player.mass >= 28) {
    player.morph = 'hypertrophic';
  } else {
    player.morph = 'round';
  }
}

function performCapture(larger, smaller, now) {
  const mods = larger.activeModifiers || resolveModifiers(larger, now);
  const captureGain = smaller.mass * 0.7 * (mods.capture || 1);
  larger.mass = Math.min(MAX_MASS, larger.mass + captureGain);
  larger.captures += 1;
  larger.mineralized += 0.35 * smaller.mass * (mods.mineral || 1);
  respawnPlayer(smaller);
}

function handleCollisions(room, now) {
  const players = [...room.players.values()];
  for (let i = 0; i < players.length; i++) {
    const a = players[i];
    if (now < a.invulnerableUntil) continue;
    const ra = calcRadius(a);
    for (let j = i + 1; j < players.length; j++) {
      const b = players[j];
      if (now < b.invulnerableUntil) continue;
      const rb = calcRadius(b);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist > Math.max(ra, rb)) continue;
      if (a.mass >= b.mass * MASS_EAT_RATIO) {
        performCapture(a, b, now);
      } else if (b.mass >= a.mass * MASS_EAT_RATIO) {
        performCapture(b, a, now);
      }
    }
  }
}

function updateScoreboard(room) {
  const board = {
    totals: { players: 0, biomass: 0, minerals: 0, captures: 0 },
  };
  for (const p of room.players.values()) {
    const cellType = sanitizeCellType(p.cellType);
    if (!board[cellType]) {
      const arc = CELL_ARCHETYPES[cellType];
      board[cellType] = {
        id: cellType,
        label: arc.label,
        players: 0,
        biomass: 0,
        minerals: 0,
        captures: 0,
      };
    }
    const entry = board[cellType];
    entry.players += 1;
    entry.biomass += p.mass;
    entry.minerals += p.mineralized;
    entry.captures += p.captures;

    board.totals.players += 1;
    board.totals.biomass += p.mass;
    board.totals.minerals += p.mineralized;
    board.totals.captures += p.captures;
  }
  const leaders = Object.entries(board)
    .filter(([key]) => key !== 'totals')
    .sort((a, b) => b[1].minerals - a[1].minerals);
  board.leader = leaders.length
    ? {
        cellType: leaders[0][0],
        label: leaders[0][1].label,
        minerals: leaders[0][1].minerals,
      }
    : null;
  room.scoreboard = board;
}

function stepRoom(room, dt) {
  const now = Date.now();
  // Safety: ensure content exists even if room was created under an older build
  if (!room.cues || room.cues.length === 0) room.cues = generateCues();
  if (!room.pellets) room.pellets = [];
  while (room.pellets.length < PELLET_TARGET) room.pellets.push(createPellet());

  // Round state progression
  if (room.round.phase === 'countdown') {
    room.round.remainingMs = Math.max(0, room.round.remainingMs - dt * 1000);
    if (room.round.remainingMs <= 0) {
      room.round.phase = 'playing';
      room.round.remainingMs = room.round.durationMs;
      room.round.startedAt = now;
      // Normalize players
      for (const p of room.players.values()) {
        p.invulnerableUntil = now + 1500;
      }
    }
  } else if (room.round.phase === 'playing') {
    room.round.remainingMs = Math.max(0, room.round.remainingMs - dt * 1000);
    if (room.round.remainingMs <= 0) {
      room.round.phase = 'ended';
      room.round.endedAt = now;
    }
  }
  for (const player of room.players.values()) {
    const mods = resolveModifiers(player, now);
    const speed = calcSpeed(player, mods);
    const vx = player.input.dx * speed;
    const vy = player.input.dy * speed;
    player.vx = vx;
    player.vy = vy;
    player.x = clamp(player.x + vx * dt, 0, WORLD.width);
    player.y = clamp(player.y + vy * dt, 0, WORLD.height);

    const decay = MASS_DECAY_PER_SECOND * dt * (mods.decay || 1);
    player.mass = clamp(player.mass - decay, MIN_MASS, MAX_MASS);

    applyCues(player, room, dt, now);
    applyPellets(player, room, now);
    updateMorph(player);
  }

  handleCollisions(room, now);
  updateScoreboard(room);
  const snapshot = buildSnapshot(room);
  io.to(room.id).emit('state', snapshot);
}

function buildSnapshot(room) {
  return {
    t: Date.now(),
    roomId: room.id,
    cues: room.cues,
    pellets: room.pellets,
    round: room.round,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      cellType: sanitizeCellType(p.cellType),
      x: p.x,
      y: p.y,
      state: p.state,
      morph: p.morph,
      mass: p.mass,
      diffProgress: p.diffProgress,
      elongation: p.elongation,
      mineralized: p.mineralized,
      captures: p.captures,
      invulnerableUntil: p.invulnerableUntil,
      lastEatenAt: p.lastEatenAt,
      activeModifiers: p.activeModifiers,
      effects: p.effects?.map((e) => ({ kind: e.kind, expiresAt: e.expiresAt })) || [],
      lastPellet: p.lastPellet || null,
    })),
    scoreboard: room.scoreboard,
    world: WORLD,
  };
}

// API: create room
app.post('/api/create-room', (req, res) => {
  const pin = req.body && typeof req.body.pin === 'string' ? req.body.pin : DEFAULT_ROOM_PIN;
  const room = createRoom({ pin });
  res.json({ roomId: room.id, pin: room.pin || null });
});

// Diagnostics: list rooms and summaries (for troubleshooting on LAN)
app.get('/api/rooms', (_req, res) => {
  res.json({ rooms: [...rooms.keys()] });
});

app.get('/api/rooms/:id/summary', (req, res) => {
  const id = String(req.params.id || '').toUpperCase();
  const room = rooms.get(id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    id,
    cues: room.cues?.length || 0,
    pellets: room.pellets?.length || 0,
    players: room.players.size,
    round: room.round,
  });
});

app.post('/api/rooms/:id/regenerate', (req, res) => {
  const id = String(req.params.id || '').toUpperCase();
  const room = rooms.get(id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.cues = generateCues();
  room.pellets = Array.from({ length: PELLET_TARGET }, () => createPellet());
  const cx = WORLD.width / 2, cy = WORLD.height / 2;
  for (let i = 0; i < 80; i++) {
    const px = cx + rand(-220, 220);
    const py = cy + rand(-220, 220);
    room.pellets.push(createPellet({ x: px, y: py }));
  }
  res.json({ ok: true, cues: room.cues.length, pellets: room.pellets.length });
});

// API: start round
function startRound(room, opts = {}) {
  const cd = typeof opts.countdownMs === 'number' ? Math.max(1000, Math.min(30000, opts.countdownMs)) : room.round.countdownMs;
  const dur = typeof opts.durationMs === 'number' ? Math.max(30000, Math.min(600000, opts.durationMs)) : room.round.durationMs;
  room.round.phase = 'countdown';
  room.round.countdownMs = cd;
  room.round.durationMs = dur;
  room.round.remainingMs = cd;
  room.round.startedAt = 0;
  room.round.endedAt = 0;
}

app.all('/api/start-round', (req, res) => {
  const body = req.body || {};
  const q = req.query || {};
  const roomId = body.roomId || q.roomId || q.room;
  const countdownMs = Number(body.countdownMs || q.countdownMs);
  const durationMs = Number(body.durationMs || q.durationMs);
  const room = rooms.get(String(roomId || '').toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  try {
    startRound(room, { countdownMs: isNaN(countdownMs) ? undefined : countdownMs, durationMs: isNaN(durationMs) ? undefined : durationMs });
    return res.json({ ok: true, round: room.round });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to start round' });
  }
});

// Serve host and play pages explicitly (also served by static middleware)
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));

io.on('connection', (socket) => {
  let joinedRoomId = null;
  let playerId = null;

  socket.emit('manifest', manifestPayload());

  socket.on('join', ({ roomId, name, pin, cellType }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('join_error', { message: 'Room not found' });
      return;
    }
    if (room.pin && room.pin !== pin) {
      socket.emit('join_error', { message: 'Invalid PIN' });
      return;
    }
    if (room.players.size >= room.maxPlayers) {
      socket.emit('join_error', { message: 'Room full' });
      return;
    }

    joinedRoomId = roomId;
    playerId = socket.id;
    const selectedCell = sanitizeCellType(cellType);
    const player = spawnPlayer({
      id: playerId,
      name: name?.slice(0, 16) || 'Player',
      cellType: selectedCell,
    });
    room.players.set(playerId, player);
    socket.join(roomId);
    socket.emit('join_ok', { roomId, playerId, cellType: selectedCell });

    // Auto-start a round if we are still in lobby or have ended
    if (room.round.phase === 'lobby' || room.round.phase === 'ended') {
      startRound(room, { countdownMs: 2000 });
    }
  });

  socket.on('input', ({ dx, dy }) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;
    const p = room.players.get(playerId);
    if (!p) return;
    const mag = Math.hypot(dx || 0, dy || 0) || 1;
    p.input.dx = clamp((dx || 0) / mag, -1, 1);
    p.input.dy = clamp((dy || 0) / mag, -1, 1);
  });

  socket.on('disconnect', () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (room) {
      room.players.delete(playerId);
    }
  });
});

// Room tick loops
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const dt = Math.min(0.05, (now - room.lastTick) / 1000);
    room.lastTick = now;
    stepRoom(room, dt);
  }
}, 50);

// Create a default room on startup for convenience
const defaultRoom = createRoom({ pin: DEFAULT_ROOM_PIN });
console.log('Created default room', defaultRoom.id);

server.listen(PORT, () => {
  console.log(`OsteoGame server listening on http://localhost:${PORT}`);
});
