// Qualitative bone-repair rules. Fractions and seconds are game units, not clinical measurements.
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const GRID = Object.freeze({ x: 352, y: 412, size: 72, cols: 18, rows: 8 });
const LOADS = Object.freeze({ resting: 0.12, physiological: 0.55, overload: 1.2 });

function createTissue() {
  const patches = [];
  for (let row = 0; row < GRID.rows; row++) {
    for (let col = 0; col < GRID.cols; col++) {
      const gap = col >= 6 && col <= 11;
      const margin = col === 5 || col === 12;
      patches.push({ id: row * GRID.cols + col, row, col,
        x: GRID.x + (col + .5) * GRID.size, y: GRID.y + (row + .5) * GRID.size,
        gap, osteoid: 0, matrix: gap ? 0 : 1, mineral: gap ? 0 : .85,
        damage: gap ? 0 : margin ? .65 : .08, age: 0,
        calcium: 0, phosphate: 0, formationSignal: 0, resorptionSignal: 0,
      });
    }
  }
  return { grid: GRID, patches, loading: 'physiological', load: LOADS.physiological,
    deposited: 0, mineralized: 0, resorbed: 0, clearedDamage: 0, metrics: null };
}

function patchAt(tissue, x, y) {
  const col = Math.floor((x - GRID.x) / GRID.size);
  const row = Math.floor((y - GRID.y) / GRID.size);
  if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) return null;
  return tissue.patches[row * GRID.cols + col];
}
const isStrong = p => p.matrix >= .55 && p.mineral >= .45 && p.damage < .4;

function tissueMetrics(tissue) {
  const { patches } = tissue;
  const gap = patches.filter(p => p.gap);
  const queue = patches.filter(p => p.col === 0 && isStrong(p)).map(p => p.id);
  const visited = new Set(queue);
  let bridged = false;
  for (let i = 0; i < queue.length; i++) {
    const p = patches[queue[i]];
    if (p.col === GRID.cols - 1) { bridged = true; break; }
    for (const id of [p.col > 0 ? p.id - 1 : -1, p.col < GRID.cols - 1 ? p.id + 1 : -1,
      p.row > 0 ? p.id - GRID.cols : -1, p.row < GRID.rows - 1 ? p.id + GRID.cols : -1]) {
      if (id >= 0 && !visited.has(id) && isStrong(patches[id])) { visited.add(id); queue.push(id); }
    }
  }
  const mineral = patches.reduce((sum, p) => sum + p.mineral, 0);
  const damage = patches.reduce((sum, p) => sum + p.damage * p.matrix, 0);
  tissue.metrics = { bridged, gapRepair: 100 * gap.filter(isStrong).length / gap.length,
    integrity: 100 * patches.reduce((sum, p) => sum + p.mineral * (1 - p.damage), 0) / patches.length,
    mineral, damage, osteoid: patches.reduce((sum, p) => sum + p.osteoid, 0),
    formed: tissue.mineralized, resorbed: tissue.resorbed, clearedDamage: tissue.clearedDamage };
  return tissue.metrics;
}

function embeddedSite(tissue, preferredId = -1) {
  const candidates = tissue.patches.filter(isStrong).sort((a, b) =>
    Math.abs(a.col - 8.5) - Math.abs(b.col - 8.5) || Math.abs(a.row - 3.5) - Math.abs(b.row - 3.5) || a.id - b.id);
  const index = candidates.findIndex(p => p.id === preferredId);
  return candidates.length ? candidates[(index + 1) % candidates.length] : null;
}

function environment(player, room) {
  let growth = 0;
  let vascular = false;
  for (const cue of room.cues) {
    if (Math.hypot(player.x - cue.x, player.y - cue.y) <= cue.r) {
      if (cue.type === 'growth') growth = Math.max(growth, cue.strength);
      if (cue.type === 'vascular') vascular = true;
    }
  }
  const nearVessel = Math.min(...room.cues.filter(c => c.type === 'vascular').map(c => Math.hypot(player.x - c.x, player.y - c.y)));
  const oxygen = Number.isFinite(nearVessel) ? clamp(1 - Math.max(0, nearVessel - 170) / 650, .15, 1) : .15;
  return { growth, vascular, oxygen };
}

function actOnTissue(player, room, dt) {
  const env = environment(player, room);
  player.oxygen = env.oxygen;
  player.resources.energy = clamp(player.resources.energy + (env.vascular ? .2 : .012 * env.oxygen) * dt);
  if (env.vascular) {
    for (const key of ['ascorbate', 'calcium', 'phosphate']) player.resources[key] = clamp(player.resources[key] + .12 * dt);
  }
  const patch = patchAt(room.tissue, player.x, player.y);
  player.patchId = patch?.id ?? null;
  if (player.state === 'progenitor') {
    if (env.growth > 0 && env.oxygen > .35 && player.resources.energy > .1) {
      player.diffProgress = clamp(player.diffProgress + dt * .08 * env.growth);
      player.activity = 'BMP/Wnt signal: committing to osteoblast lineage';
      if (player.diffProgress >= 1) { player.state = 'osteoblast'; player.cellType = 'osteoblast'; }
    } else player.activity = 'Find the blue BMP/Wnt recruitment zone';
    return;
  }
  if (!patch) { player.activity = 'Move to the tissue scaffold'; return; }
  if (player.state === 'osteocyte') {
    if (patch.matrix < .2 || patch.mineral < .1) {
      player.activity = 'This embedded site has been lost. E observes an intact osteocyte.';
      return;
    }
    // Established osteocytes remain embedded. The player controls signaling, not locomotion.
    if (player.input.work && player.resources.energy > .05) {
      const moderate = room.tissue.load >= .25 && room.tissue.load <= .85;
      let signaled = 0;
      for (const p of room.tissue.patches) {
        if (Math.hypot(p.x - player.x, p.y - player.y) > GRID.size * 3.5) continue;
        if (p.damage > .35) p.resorptionSignal = Math.min(1, p.resorptionSignal + dt * .5);
        else if (moderate) p.formationSignal = Math.min(1, p.formationSignal + dt * .5);
        signaled++;
      }
      player.resources.energy = clamp(player.resources.energy - dt * .01);
      player.signaling += dt * signaled / 10;
      player.activity = moderate ? 'Load sensing: local formation signal (Wnt abstraction)' : 'Monitoring load and marking damaged tissue for remodeling';
    } else player.activity = 'Embedded sensor: hold Work to signal; E observes another osteocyte';
    return;
  }
  if (!player.input.work) { player.activity = player.state === 'osteoclast' ? 'Find cracked tissue; hold Work to resorb' : 'Hold Work to deposit osteoid and supply calcium + phosphate'; return; }
  if (player.resources.energy <= .05 || env.oxygen <= .3) { player.activity = 'Low supply: visit a red vessel zone'; return; }
  if (player.state === 'osteoclast') {
    if (patch.damage <= .35 || patch.matrix <= .01) { player.activity = 'Healthy/empty tissue: resorption is inhibited'; return; }
    const removed = Math.min(patch.matrix, dt * .13 * (1 + patch.resorptionSignal));
    const fraction = removed / patch.matrix;
    const mineralRemoved = patch.mineral * fraction;
    const damageCleared = patch.damage * fraction;
    patch.matrix -= removed; patch.mineral -= mineralRemoved; patch.damage = clamp(patch.damage - damageCleared);
    player.resorbed += removed; player.clearedDamage += damageCleared;
    room.tissue.resorbed += removed; room.tissue.clearedDamage += damageCleared;
    player.resources.energy = clamp(player.resources.energy - dt * .035);
    player.activity = 'Resorbing damaged matrix; opening a remodeling site';
    return;
  }
  if (patch.damage > .35) { player.activity = 'Damaged matrix: an osteoclast must clear this site first'; return; }
  const deposit = Math.min(Math.max(0, 1 - patch.matrix - patch.osteoid), dt * .14 * (1 + .3 * patch.formationSignal),
    player.resources.ascorbate / .5, player.resources.energy / .3);
  patch.osteoid += deposit;
  player.resources.ascorbate = clamp(player.resources.ascorbate - deposit * .5);
  player.resources.energy = clamp(player.resources.energy - deposit * .3);
  player.deposited += deposit; room.tissue.deposited += deposit;
  for (const key of ['calcium', 'phosphate']) {
    const transfer = Math.min(player.resources[key], Math.max(0, 1 - patch[key] - patch.mineral), dt * .14);
    patch[key] += transfer; player.resources[key] -= transfer;
  }
  player.activity = player.resources.ascorbate <= .01 && patch.matrix + patch.osteoid < .95 ? 'Ascorbate depleted: visit a red vessel zone' : deposit > 0 ? 'Secreting collagen-rich osteoid (ascorbate dependent)' : patch.mineral < .85 ? 'Matrix maturing; supplying mineral precursors' : 'Site mineralized. E embeds as an osteocyte, or move to the next site';
}

function stepTissue(tissue, dt, elapsedSeconds = 0) {
  tissue.load = LOADS[tissue.loading] * (1 + .1 * Math.sin(elapsedSeconds * .7));
  for (const p of tissue.patches) {
    p.formationSignal = Math.max(0, p.formationSignal - dt * .05);
    p.resorptionSignal = Math.max(0, p.resorptionSignal - dt * .05);
    if (p.osteoid > 0) {
      p.age += dt;
      if (p.age >= 6) {
        const matured = Math.min(p.osteoid, dt * .12);
        p.osteoid -= matured; p.matrix = clamp(p.matrix + matured);
      }
    } else p.age = 0;
    // Mineral forms extracellularly, only on mature matrix with both ions available.
    const gain = Math.min(Math.max(0, p.matrix - p.mineral), p.calcium, p.phosphate,
      dt * .10 * (1 + .45 * p.formationSignal));
    p.mineral = clamp(p.mineral + gain, 0, p.matrix);
    p.calcium -= gain; p.phosphate -= gain; tissue.mineralized += gain;
    if (tissue.load > 1 && p.mineral > .4) p.damage = clamp(p.damage + dt * .004 * tissue.load);
  }
  return tissueMetrics(tissue);
}

function switchSite(player, tissue) {
  if (player.state === 'osteocyte') {
    const site = embeddedSite(tissue, player.patchId);
    if (!site) { player.activity = 'No intact site to observe'; return false; }
    player.x = site.x; player.y = site.y; player.patchId = site.id;
    player.activity = 'Observing a different existing osteocyte';
    return true;
  }
  const patch = patchAt(tissue, player.x, player.y);
  if (player.state !== 'osteoblast' || !patch || !isStrong(patch) || patch.mineral < .7) {
    player.activity = 'Embedding needs mature, intact mineralized matrix'; return false;
  }
  player.state = 'osteocyte'; player.cellType = 'osteocyte'; player.x = patch.x; player.y = patch.y;
  player.patchId = patch.id; player.input.dx = 0; player.input.dy = 0;
  player.activity = 'Embedded: now maintaining the local bone network';
  return true;
}

module.exports = { GRID, LOADS, createTissue, patchAt, isStrong, tissueMetrics, embeddedSite,
  environment, actOnTissue, stepTissue, switchSite };
