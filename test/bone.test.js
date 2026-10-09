const { test } = require('node:test');
const assert = require('node:assert/strict');
const bone = require('../bone');
const game = require('../server');
function setup(role = 'osteoblast', id = 6) {
  const room = game.createRoom(); room.round.phase = 'playing'; room.round.remainingMs = 300000;
  const p = game.spawnPlayer({ id: 'test', name: 'Test', cellType: role }, room.tissue);
  const patch = room.tissue.patches[id]; p.x = patch.x; p.y = patch.y; p.input.work = true;
  room.players.set(p.id, p); return { room, p, patch };
}

test('mesenchymal commitment produces osteoblasts; osteoclasts retain their separate lineage', () => {
  const { room, p } = setup('progenitor'); p.x = 820; p.y = 700;
  for (let i = 0; i < 260; i++) bone.actOnTissue(p, room, .05);
  assert.equal(p.state, 'osteoblast'); assert.equal(p.cellType, 'osteoblast');
  const clast = game.spawnPlayer({ id: 'clast', name: 'Clast', cellType: 'osteoclast' }, room.tissue);
  clast.x = 820; clast.y = 700;
  for (let i = 0; i < 260; i++) bone.actOnTissue(clast, room, .05);
  assert.equal(clast.state, 'osteoclast');
});

test('formation creates extracellular osteoid before mature matrix or mineral', () => {
  const { room, p, patch } = setup();
  bone.actOnTissue(p, room, 1);
  assert.ok(patch.osteoid > 0); assert.equal(patch.matrix, 0); assert.equal(patch.mineral, 0);
  for (let i = 0; i < 5; i++) bone.stepTissue(room.tissue, 1);
  assert.equal(patch.matrix, 0); assert.equal(patch.mineral, 0);
  bone.stepTissue(room.tissue, 1);
  assert.ok(patch.matrix > 0); assert.ok(patch.mineral > 0);
});

test('mineralization requires mature matrix AND calcium AND phosphate', () => {
  for (const absent of ['matrix', 'calcium', 'phosphate']) {
    const { room, patch } = setup(); Object.assign(patch, { matrix: .8, calcium: 1, phosphate: 1 });
    patch[absent] = 0; bone.stepTissue(room.tissue, 1); assert.equal(patch.mineral, 0, absent);
  }
  const { room, patch } = setup(); Object.assign(patch, { matrix: .8, calcium: .2, phosphate: .4 });
  bone.stepTissue(room.tissue, 1); assert.equal(patch.mineral, .1);
  assert.equal(patch.calcium, .1); assert.ok(Math.abs(patch.phosphate - .3) < 1e-9);
});

test('without ascorbate an osteoblast cannot deposit osteoid', () => {
  const { room, p, patch } = setup(); p.resources.ascorbate = 0;
  room.cues = []; bone.actOnTissue(p, room, 1); assert.equal(patch.osteoid, 0);
});

test('osteoclasts resorb damaged matrix, preserve healthy bone, and never eat players', () => {
  const { room, p, patch } = setup('osteoclast', 5);
  const mineral = patch.mineral; bone.actOnTissue(p, room, 1);
  assert.ok(patch.matrix < 1); assert.ok(patch.mineral < mineral); assert.ok(patch.damage < .65);
  assert.ok(p.resorbed > 0); assert.ok(p.clearedDamage > 0);
  const healthy = room.tissue.patches[0]; p.x = healthy.x; p.y = healthy.y;
  const before = { ...healthy }; bone.actOnTissue(p, room, 1);
  assert.equal(healthy.matrix, before.matrix); assert.equal(healthy.mineral, before.mineral);
});

test('damaged sites block osteoblast deposition until resorption prepares them', () => {
  const { room, p, patch } = setup('osteoblast', 5);
  bone.actOnTissue(p, room, 1); assert.equal(patch.osteoid, 0);
  const clast = game.spawnPlayer({ id: 'clast', name: 'clast', cellType: 'osteoclast' }, room.tissue);
  Object.assign(clast, { x: patch.x, y: patch.y }); clast.input.work = true;
  for (let i = 0; i < 60; i++) bone.actOnTissue(clast, room, .1);
  assert.ok(patch.damage <= .35);
  bone.actOnTissue(p, room, 1); assert.ok(patch.osteoid > 0);
});

test('osteocytes remain embedded and signal loading response locally', () => {
  const { room, p } = setup('osteocyte', 0); const x = p.x, y = p.y;
  p.input.dx = 1; bone.actOnTissue(p, room, 1); game.stepRoom(room, .05);
  assert.equal(p.x, x); assert.equal(p.y, y);
  assert.ok(room.tissue.patches[0].formationSignal > 0);
  assert.equal(room.tissue.patches[143].formationSignal, 0);
  assert.ok(p.signaling > 0);
});

test('embedding needs intact mineralized matrix and preserves the osteoblast lineage', () => {
  const { room, p, patch } = setup();
  assert.equal(bone.switchSite(p, room.tissue), false);
  Object.assign(patch, { matrix: 1, mineral: .75, damage: .1 });
  assert.equal(bone.switchSite(p, room.tissue), true); assert.equal(p.state, 'osteocyte');
  assert.equal(p.initialCellType, 'osteoblast');
  const old = p.patchId; assert.equal(bone.switchSite(p, room.tissue), true); assert.notEqual(p.patchId, old);
});

test('overload produces microdamage; physiological loading does not', () => {
  const a = bone.createTissue(), b = bone.createTissue(); a.loading = 'overload';
  bone.stepTissue(a, 1); bone.stepTissue(b, 1);
  assert.ok(a.patches[0].damage > .08); assert.equal(b.patches[0].damage, .08);
});

test('scattered mineral cannot win: success requires connected intact tissue across the gap', () => {
  const tissue = bone.createTissue();
  for (const p of tissue.patches) p.damage = 0;
  for (const p of tissue.patches.filter(p => p.row === 0 && p.gap)) Object.assign(p, { matrix: .8, mineral: .6 });
  assert.equal(bone.tissueMetrics(tissue).bridged, true);
  tissue.patches[8].mineral = 0;
  assert.equal(bone.tissueMetrics(tissue).bridged, false);
});

test('coordinated resorption followed by formation can restore a bone bridge', () => {
  const { room, p } = setup('osteoclast', 5);
  for (const id of [5, 12]) {
    const patch = room.tissue.patches[id]; p.x = patch.x; p.y = patch.y;
    for (let i = 0; i < 160; i++) { bone.actOnTissue(p, room, .05); bone.stepTissue(room.tissue, .05); }
  }
  game.takeRole(p, 'osteoblast', room); const builder = room.players.get(p.id);
  for (let id = 5; id <= 12; id++) {
    const patch = room.tissue.patches[id]; builder.x = patch.x; builder.y = patch.y;
    builder.input.work = true;
    // A perfused experimental setup keeps all substrates available at this site.
    room.cues = [{ type: 'vascular', x: patch.x, y: patch.y, r: 100 }];
    for (let i = 0; i < 400; i++) { bone.actOnTissue(builder, room, .05); bone.stepTissue(room.tissue, .05); }
  }
  assert.equal(bone.tissueMetrics(room.tissue).bridged, true);
  game.stepRoom(room, .05); assert.equal(room.round.phase, 'ended'); assert.equal(room.round.outcome, 'bridged');
});

test('matrix, mineral and resources stay bounded during sustained work', () => {
  const { room, p } = setup();
  for (let i = 0; i < 2000; i++) { bone.actOnTissue(p, room, .05); bone.stepTissue(room.tissue, .05); }
  for (const patch of room.tissue.patches) {
    assert.ok(patch.matrix + patch.osteoid <= 1.000001); assert.ok(patch.mineral <= patch.matrix + 1e-9);
    for (const key of ['matrix', 'mineral', 'osteoid', 'damage', 'calcium', 'phosphate']) assert.ok(patch[key] >= -1e-9 && patch[key] <= 1.000001, key);
  }
  for (const value of Object.values(p.resources)) assert.ok(value >= 0 && value <= 1);
});

test('a solo player can repair a bridge within a normal round using actual vessel supplies', () => {
  const { room, p } = setup('osteoclast', 5);
  function moveTo(player, target) {
    player.input.work = false;
    let steps = 0;
    while (Math.hypot(target.x - player.x, target.y - player.y) > 3 && room.round.phase === 'playing') {
      const dx = target.x - player.x, dy = target.y - player.y, length = Math.hypot(dx, dy);
      player.input.dx = dx / length; player.input.dy = dy / length;
      game.stepRoom(room, Math.min(.1, length / (150 * player.activeModifiers.speed)));
      assert.ok(++steps < 1000, 'cell reaches target');
    }
    player.input.dx = 0; player.input.dy = 0;
  }
  function workFor(player, seconds, work = true) {
    player.input.work = work;
    for (let i = 0; i < seconds * 10 && room.round.phase === 'playing'; i++) game.stepRoom(room, .1);
    player.input.work = false;
  }
  for (const id of [5, 12]) { moveTo(p, room.tissue.patches[id]); workFor(p, 6); }
  game.takeRole(p, 'osteoblast', room); const builder = room.players.get(p.id);
  for (let id = 5; id <= 12 && room.round.phase === 'playing'; id++) {
    const patch = room.tissue.patches[id];
    moveTo(builder, { x: patch.x < 1000 ? 640 : 1360, y: 330 });
    workFor(builder, 9, false);
    moveTo(builder, patch); workFor(builder, 20);
  }
  assert.equal(room.round.outcome, 'bridged'); assert.ok(room.round.remainingMs > 0);
  assert.ok(builder.deposited > 0); assert.ok(builder.resorbed > 0);
});
