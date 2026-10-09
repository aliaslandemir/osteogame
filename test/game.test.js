const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const game = require('../server');

const makeRoom = () => { const room = game.createRoom({ pin: null }); room.cues = []; return room; };
const addPlayer = (room, id, props = {}) => {
  const p = Object.assign(game.spawnPlayer({ id, name: id, cellType: 'progenitor' }), props);
  room.players.set(id, p);
  return p;
};

test('all inactive phases freeze both players and tissue', () => {
  for (const phase of ['lobby', 'countdown', 'ended']) {
    const room = makeRoom(); room.round.phase = phase; room.round.remainingMs = 5000;
    const p = addPlayer(room, 'a', { x: 500, y: 500, input: { dx: 1, dy: 0, work: true } });
    const before = JSON.stringify(room.tissue);
    game.stepRoom(room, .05);
    assert.equal(p.x, 500); assert.equal(JSON.stringify(room.tissue), before);
  }
});

test('starting a round resets tissue, resources, and contributions; preserves loading', () => {
  const room = makeRoom(); room.tissue.loading = 'overload'; room.tissue.patches[6].mineral = .8;
  const p = addPlayer(room, 'a', { deposited: 4, cellType: 'osteocyte', initialCellType: 'osteoblast' });
  p.resources.calcium = 0;
  game.startRound(room, { countdownMs: Infinity, durationMs: NaN });
  const fresh = room.players.get('a');
  assert.equal(room.round.remainingMs, 5000); assert.equal(room.round.durationMs, 300000);
  assert.equal(fresh.cellType, 'osteoblast'); assert.equal(fresh.deposited, 0); assert.equal(fresh.resources.calcium, .8);
  assert.equal(room.pellets.length, 80); assert.equal(room.tissue.patches[6].mineral, 0);
  assert.equal(room.tissue.loading, 'overload');
});

test('control handoffs preserve supplies and work contributions', () => {
  const room = makeRoom(); const p = addPlayer(room, 'a', { deposited: 3 }); p.resources.calcium = .2;
  game.takeRole(p, 'osteoclast', room); const next = room.players.get('a');
  assert.equal(next.state, 'osteoclast'); assert.equal(next.deposited, 3); assert.equal(next.resources.calcium, .2);
});

test('substrate pickups replenish inventory without directly creating mineral', () => {
  const room = makeRoom(); const p = addPlayer(room, 'a', { x: 400, y: 400 }); p.resources.calcium = .1;
  room.pellets = [{ id: 'calcium', type: 'calcium', x: 400, y: 400 }];
  const before = room.tissue.metrics.mineral; game.applyPellets(p, room);
  assert.equal(p.resources.calcium, .38); assert.equal(room.tissue.metrics.mineral, before); assert.equal(room.pellets.length, 80);
});

test('prototype names cannot be used as cell archetypes', () => {
  for (const value of ['constructor', '__proto__', 'toString', null, {}, []]) assert.equal(game.sanitizeCellType(value), 'progenitor');
});

function nextEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timed out: ${event}`)); }, 3000);
    function handler(value) { clearTimeout(timer); resolve(value); }
    socket.once(event, handler);
  });
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('HTTP and Socket.IO: validated joins, room switching, controls and disconnect cleanup', async () => {
  const server = game.startServer(0);
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const socket = connect(origin, { transports: ['websocket'], autoConnect: false });
  try {
    const manifest = nextEvent(socket, 'manifest'); socket.connect();
    assert.equal((await manifest).cellArchetypes.length, 4);
    const created = await fetch(`${origin}/api/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1234' }) }).then(r => r.json());
    const room = game.rooms.get(created.roomId);
    let error = nextEvent(socket, 'join_error'); socket.emit('join', null); assert.match((await error).message, /Invalid/);
    error = nextEvent(socket, 'join_error'); socket.emit('join', { roomId: room.id, pin: 'wrong' }); assert.equal((await error).message, 'Invalid PIN');
    const joined = nextEvent(socket, 'join_ok'); const world = nextEvent(socket, 'world_data'); const state = nextEvent(socket, 'state');
    socket.emit('join', { roomId: room.id.toLowerCase(), pin: '1234', name: 123, cellType: 'constructor' });
    const result = await joined; assert.equal(result.cellType, 'progenitor'); assert.equal((await world).cues.length, 6);
    assert.equal((await state).round.phase, 'lobby');
    let p = room.players.get(result.playerId); assert.equal(p.name, 'Player');
    socket.emit('input', null); socket.emit('input', { dx: 'bad', dy: 1 }); socket.emit('input', { dx: 3, dy: 4 });
    await delay(40); assert.equal(p.input.dx, .6); assert.equal(p.input.dy, .8);
    socket.emit('input', { dx: NaN, dy: Infinity }); await delay(40); assert.ok(Number.isFinite(p.input.dx));
    p.deposited = 12;
    const repeated = nextEvent(socket, 'join_ok'); socket.emit('join', { roomId: room.id, pin: '1234' }); await repeated;
    assert.equal(room.players.get(result.playerId).deposited, 12);
    const other = makeRoom(); const moved = nextEvent(socket, 'join_ok'); socket.emit('join', { roomId: other.id, name: 'Ada' }); await moved;
    assert.equal(room.players.size, 0); assert.equal(other.players.size, 1);
    const start = await fetch(`${origin}/api/start-round`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: other.id }) });
    assert.equal(start.status, 200);
    const conflict = await fetch(`${origin}/api/start-round`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: other.id }) });
    assert.equal(conflict.status, 409);
    const loaded = await fetch(`${origin}/api/rooms/${other.id}/loading`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loading: 'overload' }) });
    assert.equal(loaded.status, 200); assert.equal(other.tissue.loading, 'overload');
    const invalid = await fetch(`${origin}/api/rooms/${other.id}/loading`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loading: 'constructor' }) }); assert.equal(invalid.status, 400);
    const regen = await fetch(`${origin}/api/rooms/${other.id}/regenerate`, { method: 'POST' }); assert.equal(regen.status, 409);
    for (const route of ['/', '/host', '/play', '/images/osteogame-overview.svg', '/vendor/phaser.min.js']) {
      const response = await fetch(origin + route); assert.equal(response.status, 200, route); await response.arrayBuffer();
    }
    socket.disconnect(); await delay(40); assert.equal(other.players.size, 0); assert.ok(other.emptySince);
  } finally { socket.disconnect(); await game.stopServer(); }
});
after(() => game.rooms.clear());

test('countdown starts repair; time-up freezes tissue with an explicit outcome', () => {
  const room = makeRoom(); addPlayer(room, 'a'); game.startRound(room);
  room.round.remainingMs = 10; game.stepRoom(room, .05);
  assert.equal(room.round.phase, 'playing');
  room.round.remainingMs = 10; const before = JSON.stringify(room.tissue);
  game.stepRoom(room, .05); assert.equal(room.round.phase, 'ended');
  assert.equal(room.round.outcome, 'time_up'); assert.equal(JSON.stringify(room.tissue), before);
});
