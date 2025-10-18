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

function calcRadius(player) {
  const base = 12 + Math.sqrt(player.mass);
  if (player.morph === 'elongated') return base * 1.25;
  if (player.morph === 'hypertrophic') return base * 1.1;
  return base;
}

function calcSpeed(player) {
  const massPenalty = 1 - Math.min(0.6, (player.mass - BASE_MASS) / (MAX_MASS * MASS_SPEED_SLOW_FACTOR));
  const stateFactor = player.state === 'osteoblast' ? OSTEOBLAST_SPEED_FACTOR : 1;
  return BASE_SPEED * Math.max(0.35, massPenalty) * stateFactor;
}

function createPellet() {
  const { x, y } = randomPoint();
  return { id: randomUUID().slice(0, 8), x, y, value: rand(1.2, 2.4) };
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
    room.pellets.push({ id: 'C' + randomUUID().slice(0,6), x: px, y: py, value: rand(1.2, 2.5) });
  }
  return room;
}

function generateCues() {
  const cues = [];
  const typeConfigs = [
    { type: 'growth', shape: 'circle', count: 12, radius: [140, 240], strength: [0.6, 1.4] },
    { type: 'nutrient', shape: 'hex', count: 12, radius: [120, 210], rate: [1.4, 2.2] },
    { type: 'mineral', shape: 'square', count: 10, radius: [120, 190], rate: [0.7, 1.3] },
    { type: 'mechanical', shape: 'diamond', count: 10, radius: [130, 220], intensity: [0.6, 1.1] },
  ];
  for (const cfg of typeConfigs) {
    for (let i = 0; i < cfg.count; i++) {
      const { x, y } = randomPoint();
      const cue = {
        id: `${cfg.type}-${i}-${randomUUID().slice(0, 4)}`,
        type: cfg.type,
        shape: cfg.shape,
        x,
        y,
        r: rand(cfg.radius[0], cfg.radius[1]),
      };
      if (cfg.strength) cue.strength = rand(cfg.strength[0], cfg.strength[1]);
      if (cfg.rate) cue.rate = rand(cfg.rate[0], cfg.rate[1]);
      if (cfg.intensity) cue.intensity = rand(cfg.intensity[0], cfg.intensity[1]);
      cues.push(cue);
    }
  }
  // Ensure some cues are visible near the world center
  const cx = WORLD.width / 2, cy = WORLD.height / 2;
  cues.push({ id: 'center-growth', type: 'growth', shape: 'circle', x: cx - 200, y: cy, r: 180, strength: 1.0 });
  cues.push({ id: 'center-nutrient', type: 'nutrient', shape: 'hex', x: cx + 220, y: cy, r: 160, rate: 1.8 });
  cues.push({ id: 'center-mineral', type: 'mineral', shape: 'square', x: cx, y: cy - 240, r: 150, rate: 1.0 });
  cues.push({ id: 'center-mech', type: 'mechanical', shape: 'diamond', x: cx, y: cy + 240, r: 170, intensity: 0.9 });
  return cues;
}

function spawnPlayer(opts) {
  const { x, y } = randomPoint();
  const now = Date.now();
  return {
    id: opts.id,
    name: opts.name,
    team: opts.team,
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
}

function applyCues(player, room, dt) {
  if (room.round.phase !== 'playing') return; // no cue effects outside play
  for (const cue of room.cues) {
    const dx = cue.x - player.x;
    const dy = cue.y - player.y;
    if ((dx * dx + dy * dy) > cue.r * cue.r) continue;
    switch (cue.type) {
      case 'growth':
        player.diffProgress += (cue.strength || 1) * dt;
        break;
      case 'nutrient':
        player.mass = Math.min(MAX_MASS, player.mass + (cue.rate || 1.5) * dt);
        break;
      case 'mineral':
        if (player.state === 'osteoblast') {
          const gain = (cue.rate || 0.8) * dt;
          player.mineralized += gain;
          player.mass = Math.min(MAX_MASS, player.mass + gain * 0.45);
        }
        break;
      case 'mechanical':
        player.elongation = Math.min(12, player.elongation + (cue.intensity || 0.6) * dt);
        break;
      default:
        break;
    }
  }
}

function applyPellets(player, room) {
  if (room.round.phase !== 'playing') return; // only absorb pellets during play
  const radius = calcRadius(player);
  for (let i = room.pellets.length - 1; i >= 0; i--) {
    const pellet = room.pellets[i];
    const dx = pellet.x - player.x;
    const dy = pellet.y - player.y;
    if ((dx * dx + dy * dy) <= (radius + 12) * (radius + 12)) {
      player.mass = Math.min(MAX_MASS, player.mass + pellet.value);
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

function performCapture(larger, smaller) {
  larger.mass = Math.min(MAX_MASS, larger.mass + smaller.mass * 0.7);
  larger.captures += 1;
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
      if (a.team === b.team) continue;
      if (now < b.invulnerableUntil) continue;
      const rb = calcRadius(b);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist > Math.max(ra, rb)) continue;
      if (a.mass >= b.mass * MASS_EAT_RATIO) {
        performCapture(a, b);
      } else if (b.mass >= a.mass * MASS_EAT_RATIO) {
        performCapture(b, a);
      }
    }
  }
}

function updateScoreboard(room) {
  const board = {};
  for (const p of room.players.values()) {
    const team = p.team;
    if (!board[team]) {
      board[team] = { players: 0, biomass: 0, minerals: 0, captures: 0 };
    }
    board[team].players += 1;
    board[team].biomass += p.mass;
    board[team].minerals += p.mineralized;
    board[team].captures += p.captures;
  }
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
    const speed = calcSpeed(player);
    const vx = player.input.dx * speed;
    const vy = player.input.dy * speed;
    player.vx = vx;
    player.vy = vy;
    player.x = clamp(player.x + vx * dt, 0, WORLD.width);
    player.y = clamp(player.y + vy * dt, 0, WORLD.height);

    const decay = MASS_DECAY_PER_SECOND * dt;
    player.mass = clamp(player.mass - decay, MIN_MASS, MAX_MASS);

    applyCues(player, room, dt);
    applyPellets(player, room);
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
      team: p.team,
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
    room.pellets.push({ id: 'C' + randomUUID().slice(0, 6), x: px, y: py, value: rand(1.2, 2.5) });
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

  socket.on('join', ({ roomId, name, pin, team }) => {
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
    const player = spawnPlayer({
      id: playerId,
      name: name?.slice(0, 16) || 'Player',
      team: team || 'A',
    });
    room.players.set(playerId, player);
    socket.join(roomId);
    socket.emit('join_ok', { roomId, playerId });

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
