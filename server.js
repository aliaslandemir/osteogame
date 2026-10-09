require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const bone = require('./bone');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM_PIN = process.env.ROOM_PIN || null;
const WORLD = { width: 2000, height: 1400 };
const PELLET_TARGET = 80;
const EMPTY_ROOM_TTL_MS = 60 * 60 * 1000;
const MAX_ROOMS = 100;
const rooms = new Map();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

const CELL_ARCHETYPES = Object.freeze({
  progenitor: { id: 'progenitor', label: 'Mesenchymal progenitor', shape: 'capsule', color: 0x7ce4cd,
    description: 'Commit to the osteoblast lineage in a BMP/Wnt recruitment zone. Then build bone.',
    job: 'Recruit → differentiate → deposit osteoid', lineage: 'Mesenchymal lineage',
    modifiers: { speed: 1, radius: 1 } },
  osteoblast: { id: 'osteoblast', label: 'Osteoblast', shape: 'square', color: 0xffad87,
    description: 'Secrete collagen-rich osteoid and supply calcium + phosphate. Mature matrix mineralizes over time.',
    job: 'Build matrix → support mineralization', lineage: 'Mesenchymal lineage',
    modifiers: { speed: .8, radius: 1 } },
  osteocyte: { id: 'osteocyte', label: 'Embedded osteocyte', shape: 'star', color: 0xb9a0f5,
    description: 'Stay embedded in bone. Sense loading and signal local formation or damaged-site remodeling.',
    job: 'Sense load → coordinate remodeling', lineage: 'Osteoblast-derived, embedded in bone',
    modifiers: { speed: 0, radius: .85 } },
  osteoclast: { id: 'osteoclast', label: 'Osteoclast', shape: 'multinucleated', color: 0xff7e91,
    description: 'Resorb damaged bone matrix to prepare repair sites. Healthy tissue inhibits resorption.',
    job: 'Clear damaged matrix → enable rebuilding', lineage: 'Hematopoietic / monocyte lineage',
    modifiers: { speed: .7, radius: 1.35 } },
});
const PELLET_TYPES = Object.freeze([
  { id: 'ascorbate', label: 'Ascorbate', shape: 'triangle', color: 0x7ce4cd,
    description: 'Supports collagen-rich osteoid production.', resource: 'ascorbate' },
  { id: 'calcium', label: 'Calcium', shape: 'circle', color: 0xf7c66a,
    description: 'One of the two required mineral precursors.', resource: 'calcium' },
  { id: 'phosphate', label: 'Phosphate', shape: 'diamond', color: 0x70c9ed,
    description: 'Combines with calcium on mature matrix.', resource: 'phosphate' },
  { id: 'glucose', label: 'Metabolic supply', shape: 'hex', color: 0xffad87,
    description: 'Restores energy for tissue work.', resource: 'energy' },
]);
const PELLET_TYPE_MAP = Object.fromEntries(PELLET_TYPES.map(p => [p.id, p]));
const sanitizeCellType = raw => typeof raw === 'string' && Object.hasOwn(CELL_ARCHETYPES, raw) ? raw : 'progenitor';
const manifestPayload = () => ({ cellArchetypes: Object.values(CELL_ARCHETYPES), pelletTypes: PELLET_TYPES });
app.use(express.json({ limit: '8kb' }));
app.get('/vendor/phaser.min.js', (_req, res) => res.sendFile(require.resolve('phaser/dist/phaser.min.js')));
app.use(express.static(path.join(__dirname, 'public')));

function generateCues() {
  return [
    { id: 'recruit-left', type: 'growth', label: 'BMP/Wnt recruitment', shape: 'circle', x: 820, y: 700, r: 190, strength: 1 },
    { id: 'recruit-right', type: 'growth', label: 'BMP/Wnt recruitment', shape: 'circle', x: 1180, y: 700, r: 190, strength: 1 },
    ...[640, 1360].flatMap(x => [330, 1070].map(y => ({ id: `vessel-${x}-${y}`, type: 'vascular',
      label: 'Vessel: oxygen + supplies', shape: 'capsule', x, y, r: 220 }))),
  ];
}
function createPellet(opts = {}) {
  const type = Object.hasOwn(PELLET_TYPE_MAP, opts.type || '') ? opts.type : PELLET_TYPES[Math.floor(Math.random() * PELLET_TYPES.length)].id;
  return { id: randomUUID().slice(0, 8), type, x: opts.x ?? rand(420, 1580),
    y: opts.y ?? (Math.random() < .5 ? rand(260, 450) : rand(950, 1140)) };
}
const generatePellets = () => Array.from({ length: PELLET_TARGET }, () => createPellet());
function createRoom({ pin = DEFAULT_ROOM_PIN } = {}) {
  let id;
  do { id = randomUUID().slice(0, 6).toUpperCase(); } while (rooms.has(id));
  const now = Date.now();
  const room = { id, pin: pin || null, createdAt: now, emptySince: now, lastTick: now,
    players: new Map(), cues: generateCues(), pellets: generatePellets(), tissue: bone.createTissue(),
    scoreboard: {}, tissueBroadcastAt: 0, maxPlayers: 48,
    round: { phase: 'lobby', countdownMs: 5000, durationMs: 300000, remainingMs: 0, startedAt: 0, endedAt: 0, outcome: null } };
  bone.tissueMetrics(room.tissue);
  rooms.set(id, room);
  return room;
}
function buildTissueSnapshot(room) {
  const round = n => Math.round(n * 1000) / 1000;
  return { roomId: room.id, grid: bone.GRID, patches: room.tissue.patches.map(p =>
    [p.osteoid, p.matrix, p.mineral, p.damage, p.formationSignal, p.resorptionSignal].map(round)) };
}
function emitWorld(room, target = io.to(room.id)) {
  target.emit('world_data', { roomId: room.id, world: WORLD, cues: room.cues });
  target.emit('tissue_state', buildTissueSnapshot(room));
}
function spawnPlayer(opts, tissue = null) {
  const cellType = sanitizeCellType(opts.cellType);
  const site = cellType === 'osteocyte' && tissue ? bone.embeddedSite(tissue) : null;
  return { id: opts.id, name: opts.name, cellType, initialCellType: cellType, state: cellType,
    x: site?.x ?? rand(760, 880), y: site?.y ?? rand(650, 750), vx: 0, vy: 0,
    input: { dx: 0, dy: 0, work: false }, diffProgress: cellType === 'progenitor' ? 0 : 1,
    resources: { energy: 1, ascorbate: .8, calcium: .8, phosphate: .8 }, oxygen: 1,
    deposited: 0, resorbed: 0, clearedDamage: 0, signaling: 0, patchId: site?.id ?? null,
    activity: cellType === 'osteocyte' ? 'Embedded in mineralized matrix' : 'Ready to contribute to bone repair',
    lastPellet: null, activeModifiers: { ...CELL_ARCHETYPES[cellType].modifiers } };
}
function calcRadius(player) { return 19 * CELL_ARCHETYPES[sanitizeCellType(player.cellType)].modifiers.radius; }
function resolveModifiers(player) {
  player.activeModifiers = { ...CELL_ARCHETYPES[sanitizeCellType(player.cellType)].modifiers };
  return player.activeModifiers;
}
function applyPellets(player, room) {
  if (player.state === 'osteocyte') return;
  for (let i = room.pellets.length - 1; i >= 0; i--) {
    const pellet = room.pellets[i];
    if (Math.hypot(player.x - pellet.x, player.y - pellet.y) > calcRadius(player) + 9) continue;
    const type = PELLET_TYPE_MAP[pellet.type];
    if (!type || player.resources[type.resource] >= .99) continue;
    player.resources[type.resource] = Math.min(1, player.resources[type.resource] + .28);
    player.lastPellet = { type: type.id };
    room.pellets.splice(i, 1);
  }
  while (room.pellets.length < PELLET_TARGET) room.pellets.push(createPellet());
}
function updateScoreboard(room) {
  room.scoreboard = { totals: { players: room.players.size },
    contributions: [...room.players.values()].map(p => ({ id: p.id, name: p.name,
      deposited: p.deposited, resorbed: p.resorbed, clearedDamage: p.clearedDamage, signaling: p.signaling })) };
}
function startRound(room, opts = {}) {
  const cd = Number.isFinite(opts.countdownMs) ? clamp(opts.countdownMs, 1000, 30000) : room.round.countdownMs;
  const dur = Number.isFinite(opts.durationMs) ? clamp(opts.durationMs, 30000, 600000) : room.round.durationMs;
  const loading = room.tissue.loading;
  room.cues = generateCues(); room.pellets = generatePellets(); room.tissue = bone.createTissue();
  room.tissue.loading = loading;
  for (const [id, p] of room.players) room.players.set(id, spawnPlayer({ id, name: p.name, cellType: p.initialCellType }, room.tissue));
  bone.tissueMetrics(room.tissue); updateScoreboard(room); emitWorld(room);
  Object.assign(room.round, { phase: 'countdown', countdownMs: cd, durationMs: dur, remainingMs: cd,
    startedAt: 0, endedAt: 0, outcome: null });
}
function stepRoom(room, dt, now = Date.now()) {
  dt = Number.isFinite(dt) ? clamp(dt, 0, .25) : 0;
  const phaseBefore = room.round.phase;
  if (room.round.phase === 'countdown') {
    room.round.remainingMs = Math.max(0, room.round.remainingMs - dt * 1000);
    if (room.round.remainingMs === 0) Object.assign(room.round, { phase: 'playing', remainingMs: room.round.durationMs, startedAt: now });
  } else if (room.round.phase === 'playing') {
    room.round.remainingMs = Math.max(0, room.round.remainingMs - dt * 1000);
    if (room.round.remainingMs === 0) Object.assign(room.round, { phase: 'ended', endedAt: now, outcome: 'time_up' });
  }
  if (room.round.phase === 'playing') {
    for (const p of room.players.values()) {
      const mods = resolveModifiers(p);
      const speed = p.input.work ? 0 : 150 * mods.speed;
      p.vx = p.input.dx * speed; p.vy = p.input.dy * speed;
      const radius = calcRadius(p);
      p.x = clamp(p.x + p.vx * dt, radius, WORLD.width - radius);
      p.y = clamp(p.y + p.vy * dt, radius, WORLD.height - radius);
      applyPellets(p, room);
      bone.actOnTissue(p, room, dt);
    }
    const metrics = bone.stepTissue(room.tissue, dt, (room.round.durationMs - room.round.remainingMs) / 1000);
    if (metrics.bridged) Object.assign(room.round, { phase: 'ended', endedAt: now, outcome: 'bridged' });
  }
  updateScoreboard(room);
  if (now >= room.tissueBroadcastAt || phaseBefore !== room.round.phase) {
    io.to(room.id).volatile.emit('tissue_state', buildTissueSnapshot(room));
    room.tissueBroadcastAt = now + 200;
  }
  io.to(room.id).volatile.emit('state', buildSnapshot(room));
}
function buildSnapshot(room) {
  return { t: Date.now(), roomId: room.id, world: WORLD, pellets: room.pellets, round: { ...room.round },
    tissue: { loading: room.tissue.loading, load: room.tissue.load, metrics: { ...room.tissue.metrics } },
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, cellType: p.cellType, state: p.state,
      x: p.x, y: p.y, diffProgress: p.diffProgress, resources: { ...p.resources }, oxygen: p.oxygen,
      deposited: p.deposited, resorbed: p.resorbed, clearedDamage: p.clearedDamage, signaling: p.signaling,
      patchId: p.patchId, activity: p.activity, lastPellet: p.lastPellet,
      activeModifiers: p.activeModifiers, working: p.input.work })), scoreboard: room.scoreboard };
}
function takeRole(player, cellType, room) {
  const type = sanitizeCellType(cellType);
  const next = spawnPlayer({ id: player.id, name: player.name, cellType: type }, room.tissue);
  for (const key of ['deposited', 'resorbed', 'clearedDamage', 'signaling', 'resources']) next[key] = player[key];
  if (type !== 'osteocyte') { next.x = player.x; next.y = player.y; }
  room.players.set(player.id, next);
}

// API: create room
app.post('/api/create-room', (req, res) => {
  const pin = req.body && typeof req.body.pin === 'string' ? req.body.pin : DEFAULT_ROOM_PIN;
  if (pin && pin.length > 32) return res.status(400).json({ error: 'PIN must be at most 32 characters' });
  if (rooms.size >= MAX_ROOMS) return res.status(429).json({ error: 'Room limit reached. Try again later.' });
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
    tissue: { loading: room.tissue.loading, metrics: room.tissue.metrics },
  });
});

app.post('/api/rooms/:id/regenerate', (req, res) => {
  const id = String(req.params.id || '').toUpperCase();
  const room = rooms.get(id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (['countdown', 'playing'].includes(room.round.phase)) {
    return res.status(409).json({ error: 'Regenerate between rounds' });
  }
  room.cues = generateCues();
  room.pellets = generatePellets();
  emitWorld(room);
  res.json({ ok: true, cues: room.cues.length, pellets: room.pellets.length });
});

app.post('/api/start-round', (req, res) => {
  const body = req.body || {};
  const q = req.query || {};
  const roomId = body.roomId || q.roomId || q.room;
  const countdownMs = Number(body.countdownMs || q.countdownMs);
  const durationMs = Number(body.durationMs || q.durationMs);
  const room = rooms.get(String(roomId || '').toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (['countdown', 'playing'].includes(room.round.phase)) return res.status(409).json({ error: 'Round already in progress' });
  try {
    startRound(room, { countdownMs: isNaN(countdownMs) ? undefined : countdownMs, durationMs: isNaN(durationMs) ? undefined : durationMs });
    return res.json({ ok: true, round: room.round });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to start round' });
  }
});

app.post('/api/rooms/:id/loading', (req, res) => {
  const room = rooms.get(String(req.params.id).toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const loading = req.body?.loading;
  if (!Object.hasOwn(bone.LOADS, loading || '')) return res.status(400).json({ error: 'Choose resting, physiological, or overload' });
  room.tissue.loading = loading;
  room.tissue.load = bone.LOADS[loading];
  res.json({ ok: true, loading });
});

// Serve host and play pages explicitly (also served by static middleware)
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));

io.on('connection', (socket) => {
  let joinedRoomId = null;
  let playerId = null;

  socket.emit('manifest', manifestPayload());

  socket.on('join', (payload) => {
    if (!payload || typeof payload !== 'object') return socket.emit('join_error', { message: 'Invalid join request' });
    const { name, pin, cellType } = payload;
    const roomId = typeof payload.roomId === 'string' ? payload.roomId.trim().toUpperCase() : '';
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('join_error', { message: 'Room not found' });
      return;
    }
    if (room.pin && room.pin !== pin) {
      socket.emit('join_error', { message: 'Invalid PIN' });
      return;
    }
    if (!room.players.has(socket.id) && room.players.size >= room.maxPlayers) {
      socket.emit('join_error', { message: 'Room full' });
      return;
    }

    if (joinedRoomId === roomId && room.players.has(socket.id)) {
      socket.emit('join_ok', { roomId, playerId, cellType: room.players.get(playerId).cellType });
      emitWorld(room, socket);
      socket.emit('state', buildSnapshot(room));
      return;
    }
    if (joinedRoomId) {
      const previousRoom = rooms.get(joinedRoomId);
      previousRoom?.players.delete(playerId);
      if (previousRoom && !previousRoom.players.size) previousRoom.emptySince = Date.now();
      socket.leave(joinedRoomId);
    }
    joinedRoomId = roomId;
    playerId = socket.id;
    const selectedCell = sanitizeCellType(cellType);
    const player = spawnPlayer({
      id: playerId,
      name: typeof name === 'string' ? name.trim().slice(0, 16) || 'Player' : 'Player',
      cellType: selectedCell,
    }, room.tissue);
    room.players.set(playerId, player);
    room.emptySince = null;
    socket.join(roomId);
    emitWorld(room, socket);
    socket.emit('join_ok', { roomId, playerId, cellType: selectedCell });

    updateScoreboard(room);
    socket.emit('state', buildSnapshot(room));
  });

  socket.on('input', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { dx, dy, work } = payload;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;
    const p = room.players.get(playerId);
    if (!p) return;
    const mag = Math.max(1, Math.hypot(dx, dy));
    p.input.dx = clamp((dx || 0) / mag, -1, 1);
    p.input.dy = clamp((dy || 0) / mag, -1, 1);
    p.input.work = work === true;
  });

  socket.on('take_role', (payload) => {
    const room = rooms.get(joinedRoomId);
    const p = room?.players.get(playerId);
    if (!p || room.round.phase !== 'playing' || typeof payload?.cellType !== 'string' || !Object.hasOwn(CELL_ARCHETYPES, payload.cellType)) return;
    takeRole(p, payload.cellType, room);
    socket.emit('state', buildSnapshot(room));
  });
  socket.on('observe_or_embed', () => {
    const room = rooms.get(joinedRoomId);
    const p = room?.players.get(playerId);
    if (!p || room.round.phase !== 'playing') return;
    bone.switchSite(p, room.tissue);
    socket.emit('state', buildSnapshot(room));
  });

  socket.on('disconnect', () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (room) {
      room.players.delete(playerId);
      if (!room.players.size) room.emptySince = Date.now();
    }
  });
});

// Importing the simulation does not open ports or start timers (used by tests).
let tickTimer;
function startServer(port = PORT) {
  const defaultRoom = createRoom({ pin: DEFAULT_ROOM_PIN });
  console.log('Created default room', defaultRoom.id);
  tickTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const dt = Math.min(0.25, (now - room.lastTick) / 1000);
      room.lastTick = now;
      if (!room.players.size) {
        if (now - room.emptySince > EMPTY_ROOM_TTL_MS) rooms.delete(room.id);
        continue;
      }
      stepRoom(room, dt, now);
    }
  }, 50);
  return server.listen(port, () => console.log(`OsteoGame listening on http://localhost:${server.address().port}`));
}

function stopServer() {
  clearInterval(tickTimer);
  return new Promise((resolve) => io.close(resolve));
}

if (require.main === module) startServer();
module.exports = { app, server, rooms, startServer, stopServer, createRoom, spawnPlayer,
  startRound, stepRoom, buildSnapshot, sanitizeCellType, resolveModifiers, calcRadius,
  applyPellets, takeRole, buildTissueSnapshot };
