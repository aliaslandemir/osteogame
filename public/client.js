(() => {
  const params = new URLSearchParams(location.search);
  let roomId = params.get('room');
  const overlay = document.getElementById('overlay');
  const errorEl = document.getElementById('error');
  const roomInput = document.getElementById('room');
  const nameInput = document.getElementById('name');
  const pinInput = document.getElementById('pin');
  const cellOptionsEl = document.getElementById('cellOptions');

  let cellArchetypes = [];
  const cellMap = new Map();
  let pelletTypes = [];
  const pelletMap = new Map();
  const effectLabels = new Map();
  const effectColors = new Map();
  let selectedCellType = null;

  const socket = io();
  let playerId = null;
  let lastState = null;

  const pointerVector = { dx: 0, dy: 0, active: false };
  const keyboardVector = { dx: 0, dy: 0 };
  const inputVector = { dx: 0, dy: 0 };
  const previousPositions = new Map();
  const labelPool = new Map();

  if (roomId) {
    if (roomInput) {
      roomInput.value = roomId;
      roomInput.style.display = 'none';
    }
  } else if (roomInput) {
    roomInput.focus();
  }

  document.getElementById('join').addEventListener('click', () => {
    errorEl.textContent = '';
    const enteredRoom = (roomInput?.value || '').trim().toUpperCase();
    const useRoom = roomId || enteredRoom;
    if (!useRoom) {
      errorEl.textContent = 'Enter the room code (from host) to join.';
      return;
    }
    const name = nameInput.value.trim() || 'Player';
    const pin = pinInput.value.trim() || undefined;
    if (!selectedCellType && cellArchetypes.length) {
      selectedCellType = cellArchetypes[0].id;
      updateSelectedCellOption();
    }
    if (!selectedCellType) {
      errorEl.textContent = 'Select a cell archetype to join the culture.';
      return;
    }
    roomId = useRoom;
    socket.emit('join', { roomId: useRoom, name, pin, cellType: selectedCellType });
  });

  socket.on('manifest', (payload = {}) => {
    if (Array.isArray(payload.cellArchetypes)) {
      cellArchetypes = payload.cellArchetypes.map((cell) => ({
        ...cell,
        color: typeof cell.color === 'number' ? cell.color : parseInt(cell.color, 16),
      }));
      cellMap.clear();
      for (const cell of cellArchetypes) {
        cellMap.set(cell.id, cell);
      }
      if (!selectedCellType || !cellMap.has(selectedCellType)) {
        selectedCellType = cellArchetypes[0]?.id || null;
      }
    }
    if (Array.isArray(payload.pelletTypes)) {
      pelletTypes = payload.pelletTypes.map((pt) => ({ ...pt }));
      pelletMap.clear();
      effectLabels.clear();
      effectColors.clear();
      for (const pt of pelletTypes) {
        pelletMap.set(pt.id, pt);
        if (pt.effect?.kind) {
          effectLabels.set(pt.effect.kind, `${pt.label} surge`);
          effectColors.set(pt.effect.kind, pt.color);
        }
      }
      if (!effectLabels.has('flow_shear')) {
        effectLabels.set('flow_shear', 'Fluid shear');
        effectColors.set('flow_shear', 0x63e6be);
      }
    }
    renderCellOptions();
  });

  socket.on('join_ok', (data) => {
    playerId = data.playerId;
    if (data.cellType) {
      selectedCellType = data.cellType;
      updateSelectedCellOption();
    }
    overlay.style.display = 'none';
  });

  socket.on('join_error', (err) => {
    errorEl.textContent = err?.message || 'Failed to join';
  });

  socket.on('state', (snap) => {
    lastState = snap;
  });

  const config = {
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#0b0d12',
    width: window.innerWidth,
    height: window.innerHeight,
    scene: { preload, create, update },
  };
  const game = new Phaser.Game(config);

  window.addEventListener('resize', () => {
    game.scale.resize(window.innerWidth, window.innerHeight);
  });

  let cam;
  let gfx;
  let hudText;
  let statusText;
  const roundHud = document.getElementById('roundHud');
  let cursors;
  let wasd;

  function preload() {}

  function create() {
    gfx = this.add.graphics();
    cam = this.cameras.main;
    cam.setRoundPixels(true);

    hudText = this.add.text(8, 8, '', {
      fontFamily: 'Space Grotesk, Fira Code, monospace',
      fontSize: 14,
      color: '#e6eef7',
    }).setScrollFactor(0).setDepth(2000);
    hudText.setLineSpacing(4);

    statusText = this.add.text(8, 52, '', {
      fontFamily: 'Space Grotesk, Fira Code, monospace',
      fontSize: 13,
      color: '#d6adff',
    }).setScrollFactor(0).setDepth(2000);
    statusText.setVisible(false);

    cursors = this.input.keyboard.createCursorKeys();
    wasd = this.input.keyboard.addKeys({ W: 'W', A: 'A', S: 'S', D: 'D' });

    const updateKeyboardVector = () => {
      const dx = (cursors.right.isDown || wasd.D.isDown ? 1 : 0) - (cursors.left.isDown || wasd.A.isDown ? 1 : 0);
      const dy = (cursors.down.isDown || wasd.S.isDown ? 1 : 0) - (cursors.up.isDown || wasd.W.isDown ? 1 : 0);
      if (dx === 0 && dy === 0) {
        keyboardVector.dx = 0;
        keyboardVector.dy = 0;
      } else {
        const len = Math.hypot(dx, dy) || 1;
        keyboardVector.dx = dx / len;
        keyboardVector.dy = dy / len;
      }
    };

    this.input.keyboard.on('keydown', updateKeyboardVector);
    this.input.keyboard.on('keyup', updateKeyboardVector);

    this.input.on('pointerdown', (p) => {
      pointerVector.active = true;
      setPointerVector(p, this.scale.width, this.scale.height);
    });
    this.input.on('pointermove', (p) => {
      if (!pointerVector.active && !p.isDown) return;
      pointerVector.active = true;
      setPointerVector(p, this.scale.width, this.scale.height);
    });
    this.input.on('pointerup', () => {
      pointerVector.active = false;
      pointerVector.dx = 0;
      pointerVector.dy = 0;
    });
  }

  function setPointerVector(pointer, width, height) {
    const centerX = width / 2;
    const centerY = height / 2;
    const dx = pointer.x - centerX;
    const dy = pointer.y - centerY;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) {
      pointerVector.dx = 0;
      pointerVector.dy = 0;
      return;
    }
    const len = Math.hypot(dx, dy) || 1;
    pointerVector.dx = dx / len;
    pointerVector.dy = dy / len;
  }

  let lastSent = 0;
  function update(time) {
    const combinedDx = pointerVector.dx + keyboardVector.dx;
    const combinedDy = pointerVector.dy + keyboardVector.dy;
    if (combinedDx === 0 && combinedDy === 0) {
      inputVector.dx = 0;
      inputVector.dy = 0;
    } else {
      const len = Math.hypot(combinedDx, combinedDy) || 1;
      inputVector.dx = combinedDx / len;
      inputVector.dy = combinedDy / len;
    }

    if (time - lastSent > 33) {
      socket.emit('input', inputVector);
      lastSent = time;
    }

    try {
      renderWorld(this);
    } catch (e) {
      console.error(e);
    }
    renderRound();
  }

  function renderWorld(scene) {
    const world = lastState?.world || { width: 4000, height: 4000 };
    gfx.clear();
    drawBackdrop(world);
    // background grid even before state arrives
    drawGrid(world);
    if (!lastState) {
      return;
    }

    cam.setBounds(0, 0, world.width, world.height);

    const me = lastState.players.find((p) => p.id === playerId) || lastState.players[0];
    if (me) cam.centerOn(me.x, me.y);

    drawCues();
    drawPellets();

    const players = [...lastState.players].sort((a, b) => a.mass - b.mass);
    const active = new Set();
    for (const p of players) {
      active.add(p.id);
      drawPlayer(scene, p);
      previousPositions.set(p.id, { x: p.x, y: p.y });
    }

    cleanupLabels(active);
    cleanupPositions(active);

    updateHud(me);
  }

  function drawBackdrop(world) {
    const pad = 500;
    gfx.fillStyle(0x060912, 1);
    gfx.fillRect(-pad, -pad, world.width + pad * 2, world.height + pad * 2);
    gfx.lineStyle(2, 0x0f1728, 0.6);
    gfx.strokeRect(0, 0, world.width, world.height);
  }

  function drawGrid(world) {
    const step = 200;
    gfx.lineStyle(1, 0x182337, 0.45);
    for (let x = -400; x <= world.width + 400; x += step) {
      gfx.lineBetween(x, -400, x, world.height + 400);
    }
    for (let y = -400; y <= world.height + 400; y += step) {
      gfx.lineBetween(-400, y, world.width + 400, y);
    }
    const cx = world.width / 2;
    const cy = world.height / 2;
    gfx.lineStyle(2, 0x20344f, 0.7);
    gfx.lineBetween(cx - world.width, cy, cx + world.width, cy);
    gfx.lineBetween(cx, cy - world.height, cx, cy + world.height);
  }

  function drawCues() {
    if (!lastState.cues) return;
    const time = Date.now();
    for (const cue of lastState.cues) {
      const color = cueColor(cue.type);
      const pulse = 0.5 + 0.25 * Math.sin(time / 700 + cue.x * 0.01 + cue.y * 0.01);
      const fillAlpha = 0.12 + 0.1 * pulse;
      const strokeAlpha = 0.55 + 0.25 * pulse;
      switch (cue.shape) {
        case 'circle':
          gfx.lineStyle(3, color, strokeAlpha);
          gfx.fillStyle(color, fillAlpha);
          gfx.strokeCircle(cue.x, cue.y, cue.r);
          gfx.fillCircle(cue.x, cue.y, cue.r);
          break;
        case 'square':
          gfx.lineStyle(3, color, strokeAlpha);
          gfx.fillStyle(color, fillAlpha);
          gfx.strokeRect(cue.x - cue.r, cue.y - cue.r, cue.r * 2, cue.r * 2);
          gfx.fillRect(cue.x - cue.r, cue.y - cue.r, cue.r * 2, cue.r * 2);
          break;
        case 'diamond':
          drawCuePolygon(cue, 4, Math.PI / 4, color, strokeAlpha, fillAlpha);
          break;
        case 'hex':
          drawCuePolygon(cue, 6, Math.PI / 6, color, strokeAlpha, fillAlpha);
          break;
        default:
          drawCuePolygon(cue, 5, 0, color, strokeAlpha, fillAlpha);
          break;
      }
    }
  }

  function drawCuePolygon(cue, sides, rotation, color, strokeAlpha, fillAlpha) {
    gfx.lineStyle(2, color, strokeAlpha ?? 0.6);
    gfx.fillStyle(color, fillAlpha ?? 0.08);
    gfx.beginPath();
    for (let i = 0; i <= sides; i++) {
      const angle = rotation + (i * Math.PI * 2) / sides;
      const px = cue.x + Math.cos(angle) * cue.r;
      const py = cue.y + Math.sin(angle) * cue.r;
      if (i === 0) gfx.moveTo(px, py);
      else gfx.lineTo(px, py);
    }
    gfx.closePath();
    gfx.fillPath();
    gfx.strokePath();
  }

  function drawPellets() {
    if (!lastState?.pellets) return;
    for (const pellet of lastState.pellets) {
      const type = pelletMap.get(pellet.type);
      drawPelletMarker(pellet, type);
    }
  }

  function drawPelletMarker(pellet, type) {
    const x = pellet.x;
    const y = pellet.y;
    const color = type?.color ?? 0xffe27a;
    const alpha = 0.88;
    const sizeBase = type?.massGain || 1.6;
    const radius = 5.5 + Math.min(3.5, sizeBase);
    const shape = type?.shape || 'circle';
    switch (shape) {
      case 'triangle':
        gfx.fillStyle(color, alpha);
        gfx.fillTriangle(x, y - radius, x + radius * 0.95, y + radius, x - radius * 0.95, y + radius);
        gfx.lineStyle(2, color, 0.9);
        gfx.strokeTriangle(x, y - radius, x + radius * 0.95, y + radius, x - radius * 0.95, y + radius);
        break;
      case 'diamond':
        drawPelletPolygon(x, y, 4, radius * 1.05, Math.PI / 4, color, alpha);
        break;
      case 'hex':
        drawPelletPolygon(x, y, 6, radius, Math.PI / 6, color, alpha);
        break;
      case 'square':
        gfx.fillStyle(color, alpha);
        gfx.fillRoundedRect(x - radius, y - radius, radius * 2, radius * 2, 4);
        gfx.lineStyle(2, color, 0.85);
        gfx.strokeRoundedRect(x - radius, y - radius, radius * 2, radius * 2, 4);
        break;
      default:
        gfx.fillStyle(color, alpha);
        gfx.fillCircle(x, y, radius);
        gfx.lineStyle(2, color, 0.85);
        gfx.strokeCircle(x, y, radius);
        break;
    }
  }

  function drawPelletPolygon(x, y, sides, radius, rotation, color, alpha) {
    gfx.lineStyle(2, color, 0.85);
    gfx.fillStyle(color, alpha);
    gfx.beginPath();
    for (let i = 0; i <= sides; i++) {
      const angle = rotation + (i * Math.PI * 2) / sides;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (i === 0) gfx.moveTo(px, py);
      else gfx.lineTo(px, py);
    }
    gfx.closePath();
    gfx.fillPath();
    gfx.strokePath();
  }

  function drawPlayer(scene, player) {
    const isMe = player.id === playerId;
    const cell = cellMap.get(player.cellType);
    const color = playerColor(player, cell);
    const outline = isMe ? 0xffffff : 0x1b2433;
    const alpha = isMe ? 1.0 : 0.85;
    const radius = clientRadius(player, cell);
    const now = Date.now();
    const invulnerable = player.invulnerableUntil && player.invulnerableUntil > now;

    drawMotionTrail(player, color);
    drawEffectAura(player, radius);
    drawCellBody(player, cell, radius, color, outline, alpha, invulnerable);
    drawLabel(scene, player, radius);
  }

  function drawCellBody(player, cell, radius, fillColor, outlineColor, alpha, invulnerable) {
    const shape = cell?.shape || 'circle';
    const outlineAlpha = invulnerable ? 0.45 : 0.85;
    switch (shape) {
      case 'capsule':
        drawElongated(player, fillColor, outlineColor, alpha, invulnerable, radius);
        break;
      case 'square':
        drawSquareCell(player, fillColor, outlineColor, alpha, outlineAlpha, radius);
        break;
      case 'triangle':
        drawTriangleCell(player, fillColor, outlineColor, alpha, outlineAlpha, radius);
        break;
      case 'star':
        drawStarCell(player, fillColor, outlineColor, alpha, outlineAlpha, radius);
        break;
      default:
        drawCircleCell(player, fillColor, outlineColor, alpha, outlineAlpha, radius);
        break;
    }
  }

  function drawCircleCell(player, fillColor, outlineColor, alpha, outlineAlpha, radius) {
    const scale = player.morph === 'hypertrophic' ? 1.12 : player.morph === 'elongated' ? 1.05 : 1;
    const r = radius * scale;
    gfx.fillStyle(fillColor, alpha);
    gfx.fillCircle(player.x, player.y, r);
    gfx.lineStyle(3, outlineColor, outlineAlpha);
    gfx.strokeCircle(player.x, player.y, r);
  }

  function drawSquareCell(player, fillColor, outlineColor, alpha, outlineAlpha, radius) {
    const scale = player.morph === 'hypertrophic' ? 1.25 : 1.05;
    const size = radius * 1.45 * scale;
    const half = size / 2;
    const corner = Math.min(12, size * 0.25);
    gfx.fillStyle(fillColor, alpha);
    gfx.fillRoundedRect(player.x - half, player.y - half, size, size, corner);
    gfx.lineStyle(3, outlineColor, outlineAlpha);
    gfx.strokeRoundedRect(player.x - half, player.y - half, size, size, corner);
  }

  function drawTriangleCell(player, fillColor, outlineColor, alpha, outlineAlpha, radius) {
    const angle = getMovementAngle(player) ?? -Math.PI / 2;
    const r = radius * 1.2;
    const points = [];
    for (let i = 0; i < 3; i++) {
      const a = angle + (i * Math.PI * 2) / 3;
      points.push({ x: player.x + Math.cos(a) * r, y: player.y + Math.sin(a) * r });
    }
    drawPolygonShape(points, fillColor, outlineColor, alpha, outlineAlpha);
  }

  function drawStarCell(player, fillColor, outlineColor, alpha, outlineAlpha, radius) {
    const baseAngle = getMovementAngle(player) ?? -Math.PI / 2;
    const outer = radius * 1.25;
    const inner = outer * 0.5;
    const points = [];
    for (let i = 0; i < 10; i++) {
      const angle = baseAngle + (i * Math.PI) / 5;
      const len = i % 2 === 0 ? outer : inner;
      points.push({ x: player.x + Math.cos(angle) * len, y: player.y + Math.sin(angle) * len });
    }
    drawPolygonShape(points, fillColor, outlineColor, alpha, outlineAlpha);
  }

  function drawPolygonShape(points, fillColor, outlineColor, alpha, outlineAlpha) {
    if (points.length < 3) return;
    gfx.fillStyle(fillColor, alpha);
    gfx.lineStyle(3, outlineColor, outlineAlpha);
    gfx.beginPath();
    gfx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      gfx.lineTo(points[i].x, points[i].y);
    }
    gfx.closePath();
    gfx.fillPath();
    gfx.strokePath();
  }

  function drawMotionTrail(player, color) {
    const prev = previousPositions.get(player.id);
    if (!prev) return;
    gfx.lineStyle(2, color, 0.25);
    gfx.lineBetween(prev.x, prev.y, player.x, player.y);
  }

  function drawEffectAura(player, radius) {
    const now = Date.now();
    const active = Array.isArray(player.effects) ? player.effects.find((e) => e.expiresAt > now) : null;
    if (!active) return;
    const color = effectColors.get(active.kind) ?? 0x63e6be;
    const pulse = 0.5 + 0.25 * Math.sin(now / 320 + player.x * 0.003 + player.y * 0.002);
    const r = radius * (1.25 + pulse * 0.18);
    gfx.lineStyle(3, color, 0.5 + pulse * 0.25);
    gfx.strokeCircle(player.x, player.y, r);
  }

  function getMovementAngle(player) {
    const prev = previousPositions.get(player.id);
    if (!prev) return null;
    const dx = player.x - prev.x;
    const dy = player.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.05) return null;
    return Math.atan2(dy, dx);
  }

  function drawElongated(player, fillColor, outlineColor, alpha, invulnerable, radius) {
    const prev = previousPositions.get(player.id) || { x: player.x + 0.01, y: player.y };
    let dx = player.x - prev.x;
    let dy = player.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    // Default direction if nearly stationary
    if (Math.abs(dx) + Math.abs(dy) < 0.05) { dx = 1; dy = 0; }
    const px = -dy; // perpendicular
    const py = dx;
    const halfLen = radius * 1.2;
    const halfThick = radius * 0.55;
    const p1 = { x: player.x + dx * halfLen + px * halfThick, y: player.y + dy * halfLen + py * halfThick };
    const p2 = { x: player.x + dx * halfLen - px * halfThick, y: player.y + dy * halfLen - py * halfThick };
    const p3 = { x: player.x - dx * halfLen - px * halfThick, y: player.y - dy * halfLen - py * halfThick };
    const p4 = { x: player.x - dx * halfLen + px * halfThick, y: player.y - dy * halfLen + py * halfThick };
    const pts = [p1, p2, p3, p4];
    gfx.fillStyle(fillColor, alpha);
    gfx.fillPoints(pts, true);
    gfx.lineStyle(3, outlineColor, invulnerable ? 0.45 : 0.85);
    gfx.strokePoints(pts, true);
  }

  function drawLabel(scene, player, radius) {
    let label = labelPool.get(player.id);
    if (!label) {
      label = scene.add.text(0, 0, '', {
        fontFamily: 'monospace',
        fontSize: 12,
        color: '#e6eef7',
        backgroundColor: 'rgba(13,17,24,0.45)',
        padding: { x: 4, y: 2 },
      }).setOrigin(0.5, 1).setDepth(1500);
      labelPool.set(player.id, label);
    }
    const mass = Number.isFinite(player.mass) ? Math.round(player.mass) : 0;
    const minerals = Number.isFinite(player.mineralized) ? player.mineralized.toFixed(1) : '0.0';
    const captures = player.captures ? (' *' + player.captures) : '';
    const cell = cellMap.get(player.cellType);
    const cellTag = cell ? (' [' + cell.label.split(' ')[0] + ']') : '';
    label.setText(player.name + cellTag + ' m:' + mass + ' Ca:' + minerals + captures);
    label.x = player.x;
    label.y = player.y - radius - 10;
    label.setVisible(true);
  }

  function cleanupLabels(active) {
    for (const [id, text] of labelPool.entries()) {
      if (!active.has(id)) {
        text.setVisible(false);
      }
    }
  }

  function cleanupPositions(active) {
    for (const id of previousPositions.keys()) {
      if (!active.has(id)) {
        previousPositions.delete(id);
      }
    }
  }

  function renderCellOptions() {
    if (!cellOptionsEl) return;
    cellOptionsEl.innerHTML = '';
    if (!cellArchetypes.length) {
      cellOptionsEl.classList.remove('cell-choice-grid');
      const placeholder = document.createElement('div');
      placeholder.className = 'muted';
      placeholder.textContent = 'Loading cell archetypes...';
      cellOptionsEl.appendChild(placeholder);
      return;
    }
    cellOptionsEl.classList.add('cell-choice-grid');
    for (const cell of cellArchetypes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cell-option';
      btn.dataset.cell = cell.id;
      const shape = document.createElement('div');
      shape.className = 'cell-shape';
      shape.innerHTML = renderCellSvg(cell);
      const title = document.createElement('strong');
      title.textContent = cell.label;
      const desc = document.createElement('small');
      desc.textContent = cell.description;
      const mods = cell.modifiers || {};
      const traits = document.createElement('small');
      traits.textContent = `Speed ${formatMod(mods.speed)} • Mineral ${formatMod(mods.mineral)} • Capture ${formatMod(mods.capture)}`;
      btn.append(shape, title, desc, traits);
      btn.addEventListener('click', () => {
        selectedCellType = cell.id;
        updateSelectedCellOption();
      });
      cellOptionsEl.appendChild(btn);
    }
    updateSelectedCellOption();
  }

  function updateSelectedCellOption() {
    if (!cellOptionsEl) return;
    const buttons = cellOptionsEl.querySelectorAll('.cell-option');
    buttons.forEach((btn) => {
      const isSelected = btn.dataset.cell === selectedCellType;
      btn.classList.toggle('selected', isSelected);
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });
  }

  function renderCellSvg(cell) {
    const fill = colorToCss(cell.color);
    const stroke = '#1b2433';
    const accent = '#ffffff22';
    switch (cell.shape) {
      case 'capsule':
        return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="12" y="18" width="40" height="28" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="3"/><rect x="20" y="26" width="24" height="12" rx="6" fill="${accent}"/></svg>`;
      case 'square':
        return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="14" y="14" width="36" height="36" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="3"/><rect x="22" y="22" width="20" height="20" rx="6" fill="${accent}"/></svg>`;
      case 'triangle':
        return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><polygon points="32,8 56,54 8,54" fill="${fill}" stroke="${stroke}" stroke-width="3"/><polygon points="32,16 48,48 16,48" fill="${accent}"/></svg>`;
      case 'star':
        return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><polygon points="32,6 40,24 58,24 44,36 50,54 32,44 14,54 20,36 6,24 24,24" fill="${fill}" stroke="${stroke}" stroke-width="3"/><polygon points="32,14 38,26 50,26 40,34 44,46 32,38 20,46 24,34 14,26 26,26" fill="${accent}"/></svg>`;
      default:
        return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="20" fill="${fill}" stroke="${stroke}" stroke-width="3"/><circle cx="32" cy="32" r="10" fill="${accent}"/></svg>`;
    }
  }

  function colorToCss(color) {
    const value = typeof color === 'number' ? color : parseInt(String(color || '0'), 16);
    return `#${(value >>> 0).toString(16).padStart(6, '0')}`;
  }

  function formatMod(value) {
    if (!Number.isFinite(value)) return 'x1.00';
    return 'x' + Number(value).toFixed(2);
  }

  function updateHud(me) {
    const board = lastState.scoreboard || {};
    const totals = board.totals || { players: 0, biomass: 0, minerals: 0, captures: 0 };
    const totalPlayers = totals.players || (lastState.players?.length || 0);
    const meState = me ? `${me.state}/${me.morph}` : 'spectating';
    const meMass = me ? formatNumber(me.mass, 1) : '0.0';
    const meMinerals = me ? formatNumber(me.mineralized, 1) : '0.0';
    const meCaptures = me && Number.isFinite(me.captures) ? me.captures : 0;
    const meCell = me ? cellMap.get(me.cellType) : null;

    const cuesCount = lastState.cues ? lastState.cues.length : 0;
    const pelletsCount = lastState.pellets ? lastState.pellets.length : 0;
    const leader = board.leader;
    const leaderText = leader
      ? `${leader.label.split(' ')[0]}:${formatNumber(leader.minerals, 1)}`
      : 'No leader';
    const cellSummaries = Object.entries(board)
      .filter(([key]) => key !== 'totals' && key !== 'leader')
      .map(([, info]) => `${info.label.split(' ')[0]}:${formatNumber(info.minerals, 1)}`)
      .slice(0, 3)
      .join(' ');
    const totalsMineral = formatNumber(totals.minerals, 1);
    const totalsCaptures = Number.isFinite(totals.captures) ? totals.captures : 0;
    const meCellLabel = meCell ? meCell.label : 'Spectator';

    const lines = [
      `Room ${lastState.roomId} • Players ${totalPlayers} • Pellets ${pelletsCount} • Cues ${cuesCount}`,
      `Culture Ca ${totalsMineral} • Captures ${totalsCaptures}` + (leader ? ` • Lead ${leaderText}` : ''),
      `You ${meCellLabel} m:${meMass} Ca:${meMinerals} state:${meState} capt:${meCaptures}` + (cellSummaries ? ` • Cells ${cellSummaries}` : '')
    ];
    hudText.setText(lines);

    if (!me) {
      statusText.setVisible(false);
      return;
    }

    const now = Date.now();
    const invulnLeft = me.invulnerableUntil ? me.invulnerableUntil - now : 0;
    if (now - (me.lastEatenAt || 0) < 2600) {
      const seconds = Math.max(0, invulnLeft / 1000).toFixed(1);
      statusText.setText(`You were resorbed! Invulnerable ${seconds}s`);
      statusText.setColor('#ff6f91');
      statusText.setVisible(true);
      return;
    }
    if (invulnLeft > 0) {
      const seconds = (invulnLeft / 1000).toFixed(1);
      statusText.setText(`Invulnerable ${seconds}s`);
      statusText.setColor('#7ea6ff');
      statusText.setVisible(true);
      return;
    }

    const primaryEffect = Array.isArray(me.effects) && me.effects.length
      ? me.effects.reduce((best, effect) => (effect.expiresAt > (best?.expiresAt || 0) ? effect : best), null)
      : null;
    if (primaryEffect && primaryEffect.expiresAt > now) {
      const seconds = ((primaryEffect.expiresAt - now) / 1000).toFixed(1);
      const label = effectLabels.get(primaryEffect.kind) || primaryEffect.kind;
      const color = colorToCss(effectColors.get(primaryEffect.kind) ?? 0x63e6be);
      statusText.setText(`${label} ${seconds}s`);
      statusText.setColor(color);
      statusText.setVisible(true);
      return;
    }
    if (me.lastPellet?.type) {
      const pellet = pelletMap.get(me.lastPellet.type);
      if (pellet) {
        statusText.setText(`Last intake: ${pellet.label}`);
        statusText.setColor('#e6eef7');
        statusText.setVisible(true);
        return;
      }
    }
    statusText.setVisible(false);
  }

  function renderRound() {
    if (!lastState || !lastState.round) { roundHud.style.display = 'none'; return; }
    const r = lastState.round;
    const ms = Math.max(0, Math.floor(r.remainingMs || 0));
    const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
    const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const leader = lastState.scoreboard?.leader;
    const leaderLine = leader ? `${leader.label.split(' ')[0]} lead ${formatNumber(leader.minerals, 1)} Ca` : 'No leader yet';
    let phaseLabel = 'Lobby';
    let timeLabel = 'Waiting to start';
    if (r.phase === 'countdown') { phaseLabel = 'Countdown'; timeLabel = `Starts in ${ss}s`; }
    else if (r.phase === 'playing') { phaseLabel = 'Round Live'; timeLabel = `Time left ${mm}:${ss}`; }
    else if (r.phase === 'ended') { phaseLabel = 'Round Ended'; timeLabel = 'Review + restart'; }

    roundHud.innerHTML = `
      <div class="hud-line"><span class="pill">${phaseLabel}</span><strong>${timeLabel}</strong></div>
      <div class="hud-line muted">Objective: bank minerals, ride cues, and dodge resorption.</div>
      <div class="hud-line muted">Leader: ${leaderLine}</div>
    `;
    roundHud.style.display = 'block';
  }

  function cueColor(type) {
    switch (type) {
      case 'growth': return 0x4cc9f0;
      case 'nutrient': return 0x9ef01a;
      case 'mineral': return 0xf8961e;
      case 'mechanical': return 0xc77dff;
      case 'hormonal': return 0xff6f91;
      case 'flow': return 0x4361ee;
      default: return 0xffffff;
    }
  }

  function playerColor(player, cell) {
    const info = cell || cellMap.get(player.cellType);
    let color = info?.color ?? 0x7fd1b9;
    if (player.state === 'osteoblast') {
      color = lightenColor(color, 0.2);
    }
    return color >>> 0;
  }

  function clientRadius(player, cell) {
    const base = 12 + Math.sqrt(player.mass || 0);
    const info = cell || cellMap.get(player.cellType);
    let radius = base * (info?.modifiers?.radius || 1);
    if (player.morph === 'elongated') radius *= 1.25;
    else if (player.morph === 'hypertrophic') radius *= 1.1;
    return radius;
  }

  function formatNumber(value, digits) {
    if (!Number.isFinite(value)) return digits === 0 ? '0' : '0.0';
    return Number(value).toFixed(digits);
  }

  function lightenColor(color, amount) {
    const clamp = (v) => Math.max(0, Math.min(255, v));
    const r = clamp(((color >> 16) & 0xff) + Math.round(255 * amount));
    const g = clamp(((color >> 8) & 0xff) + Math.round(255 * amount));
    const b = clamp((color & 0xff) + Math.round(255 * amount));
    return (r << 16) | (g << 8) | b;
  }
})();
