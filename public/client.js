(() => {
  const params = new URLSearchParams(location.search);
  let roomId = params.get('room')?.trim().toUpperCase();
  let worldData = null;
  let tissueData = null;
  let workHeld = false;
  let spaceKey;
  let embedKey;
  const workButton = document.getElementById('workButton');
  const embedButton = document.getElementById('embedButton');
  const roleSwitch = document.getElementById('roleSwitch');
  const controls = document.getElementById('cellControls');
  const sitePanel = document.getElementById('sitePanel');
  let serverOffset = 0;
  let lastRoundMarkup = '';
  const serverNow = () => Date.now() + serverOffset;
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
  let selectedCellType = null;

  const socket = io();
  let playerId = null;
  let lastState = null;

  const pointerVector = { dx: 0, dy: 0, active: false };
  const keyboardVector = { dx: 0, dy: 0 };
  const inputVector = { dx: 0, dy: 0, work: false };
  const previousPositions = new Map();
  const labelPool = new Map();
  const worldLabelPool = new Map();

  if (roomId) {
    if (roomInput) {
      roomInput.value = roomId;
      roomInput.setAttribute('aria-label', 'Room code');
    }
  } else if (roomInput) {
    roomInput.focus();
  }

  document.getElementById('join').addEventListener('click', () => {
    errorEl.textContent = '';
    const enteredRoom = (roomInput?.value || '').trim().toUpperCase();
    const useRoom = enteredRoom || roomId;
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
      for (const pt of pelletTypes) pelletMap.set(pt.id, pt);
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
    controls.hidden = false;
  });

  socket.on('join_error', (err) => {
    errorEl.textContent = err?.message || 'Failed to join';
  });

  socket.on('tissue_state', (data) => {
    const { grid } = data;
    tissueData = { ...data, patches: data.patches.map((values, id) => ({
      id, x: grid.x + (id % grid.cols + .5) * grid.size,
      y: grid.y + (Math.floor(id / grid.cols) + .5) * grid.size,
      osteoid: values[0], matrix: values[1], mineral: values[2], damage: values[3],
      formationSignal: values[4], resorptionSignal: values[5],
    })) };
  });

  socket.on('world_data', (data) => {
    worldData = data;
    if (lastState && lastState.roomId === data.roomId) lastState = { ...lastState, ...data };
  });

  socket.on('state', (snap) => {
    serverOffset = snap.t - Date.now();
    lastState = { ...snap, cues: worldData?.roomId === snap.roomId ? worldData.cues : [] };
  });

  socket.on('disconnect', () => {
    playerId = null;
    lastState = null;
    worldData = null;
    tissueData = null;
    controls.hidden = true;
    sitePanel.hidden = true;
    resetInput();
    overlay.style.display = 'flex';
    errorEl.textContent = 'Connection lost. Rejoin when connected; your previous score was cleared.';
  });
  socket.on('connect_error', () => { errorEl.textContent = 'Cannot reach the server. Check your connection.'; });
  socket.on('connect', () => { errorEl.textContent = ''; });

  function resetInput() {
    pointerVector.active = false;
    workHeld = false;
    spaceKey?.reset();
    inputVector.work = false;
    workButton.classList.remove('working');
    for (const vector of [pointerVector, keyboardVector, inputVector]) { vector.dx = 0; vector.dy = 0; }
    if (playerId && socket.connected) socket.emit('input', { dx: 0, dy: 0, work: false });
  }
  workButton.addEventListener('pointerdown', (event) => {
    if (workButton.disabled) return;
    event.preventDefault(); workButton.setPointerCapture(event.pointerId);
    workHeld = true;
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    workButton.addEventListener(event, () => { workHeld = false; });
  }
  embedButton.addEventListener('click', () => socket.emit('observe_or_embed'));
  roleSwitch.addEventListener('change', () => { resetInput(); socket.emit('take_role', { cellType: roleSwitch.value }); });
  window.addEventListener('blur', resetInput);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetInput(); });

  const config = {
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#091b26',
    width: window.innerWidth,
    height: window.innerHeight,
    scene: { preload, create, update },
  };
  const game = new Phaser.Game(config);

  window.addEventListener('resize', () => {
    if (game.isBooted && game.renderer) game.scale.resize(window.innerWidth, window.innerHeight);
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

    hudText = this.add.text(16, 16, '', {
      fontFamily: 'Space Grotesk, Fira Code, monospace',
      fontSize: window.innerWidth < 700 ? 11 : 13,
      backgroundColor: '#102c3b',
      padding: { x: 10, y: 8 },
      color: '#e6eef7',
    }).setScrollFactor(0).setDepth(2000);
    hudText.setLineSpacing(4);

    statusText = this.add.text(16, 94, '', {
      fontFamily: 'Space Grotesk, Fira Code, monospace',
      fontSize: 12,
      color: '#d6adff',
    }).setScrollFactor(0).setDepth(2000);
    statusText.setVisible(false);

    cursors = this.input.keyboard.createCursorKeys();
    wasd = this.input.keyboard.addKeys({ W: 'W', A: 'A', S: 'S', D: 'D' });
    spaceKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE, false);
    embedKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E, false);
    embedKey.on('down', () => { if (playerId) socket.emit('observe_or_embed'); });

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
    this.input.on('pointerupoutside', resetInput);
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
  let frameDelta = 16;
  const renderPositions = new Map();
  function update(time, delta) {
    frameDelta = delta;
    inputVector.work = Boolean(playerId && (workHeld || spaceKey?.isDown));
    workButton.classList.toggle('working', inputVector.work);
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

    if (playerId && socket.connected && time - lastSent > 50) {
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

    const smoothed = lastState.players.map((p) => {
      const previous = renderPositions.get(p.id);
      const factor = Math.min(1, 1 - Math.exp(-frameDelta / 45));
      const teleport = p.state === 'osteocyte' || !previous || Math.hypot(p.x - previous.x, p.y - previous.y) > 250;
      const position = teleport ? { x: p.x, y: p.y } : { x: previous.x + (p.x - previous.x) * factor, y: previous.y + (p.y - previous.y) * factor };
      renderPositions.set(p.id, position);
      return { ...p, ...position };
    });
    const me = smoothed.find((p) => p.id === playerId);
    if (me) cam.centerOn(me.x, me.y);

    drawTissue(scene);
    drawCues(scene);
    drawPellets();

    const players = smoothed;
    const active = new Set();
    for (const p of players) {
      active.add(p.id);
      if (isVisible(p.x, p.y, 100)) drawPlayer(scene, p);
      else labelPool.get(p.id)?.setVisible(false);
      previousPositions.set(p.id, { x: p.x, y: p.y });
    }

    cleanupLabels(active);
    cleanupPositions(active);

    updateHud(me);
  }

  function isVisible(x, y, radius = 0) {
    const view = cam.worldView;
    return x + radius >= view.x && x - radius <= view.right && y + radius >= view.y && y - radius <= view.bottom;
  }

  function worldLabel(scene, id, text, x, y, color) {
    let label = worldLabelPool.get(id);
    if (!label) {
      label = scene.add.text(x, y, text, { fontFamily: 'Segoe UI, sans-serif', fontSize: 13,
        color, backgroundColor: '#091b26', padding: { x: 6, y: 4 } }).setOrigin(.5).setDepth(50);
      worldLabelPool.set(id, label);
    }
    label.setVisible(isVisible(x, y, 180));
  }

  function drawTissue(scene) {
    if (!tissueData || tissueData.roomId !== lastState.roomId) return;
    const { grid, patches } = tissueData;
    worldLabel(scene, 'bone-left', 'EXISTING BONE', grid.x + grid.size * 2.5, grid.y - 18, '#eee2c5');
    worldLabel(scene, 'bone-gap', 'REPAIR GAP · lay matrix, then mineralize', grid.x + grid.size * 9, grid.y - 18, '#7ce4cd');
    worldLabel(scene, 'bone-right', 'EXISTING BONE', grid.x + grid.size * 15.5, grid.y - 18, '#eee2c5');
    for (const patch of patches) {
      const size = grid.size - 3;
      if (!isVisible(patch.x, patch.y, grid.size)) continue;
      const x = patch.x - size / 2, y = patch.y - size / 2;
      gfx.fillStyle(0x18333d, .8); gfx.fillRoundedRect(x, y, size, size, 5);
      gfx.lineStyle(1, 0x49606a, .3); gfx.strokeRoundedRect(x, y, size, size, 5);
      if (patch.osteoid > .005 || patch.matrix > .005) {
        gfx.fillStyle(0xb67c50, Math.min(.8, .15 + patch.osteoid * .6 + patch.matrix * .45));
        gfx.fillRoundedRect(x + 2, y + 2, size - 4, size - 4, 4);
        gfx.lineStyle(1.5, 0xf2bb87, .2 + patch.osteoid * .7);
        for (let i = 0; i < 4; i++) gfx.lineBetween(x + 8, y + 14 + i * 12, x + size - 8, y + 9 + i * 12);
      }
      if (patch.mineral > .01) {
        gfx.fillStyle(0xeee2c5, patch.mineral * .8);
        gfx.fillRoundedRect(x + 3, y + 3, size - 6, size - 6, 4);
        gfx.fillStyle(0xfff5db, patch.mineral * .5);
        gfx.fillCircle(patch.x - 13, patch.y - 11, 3); gfx.fillCircle(patch.x + 13, patch.y + 15, 2);
      }
      if (patch.damage > .35 && patch.matrix > .01) {
        gfx.lineStyle(2.5, 0xff7e91, .85);
        gfx.beginPath(); gfx.moveTo(x + 24, y + 7); gfx.lineTo(x + 37, y + 25);
        gfx.lineTo(x + 23, y + 38); gfx.lineTo(x + 40, y + size - 7); gfx.strokePath();
      }
      if (patch.formationSignal > .1 || patch.resorptionSignal > .1) {
        gfx.lineStyle(2, patch.resorptionSignal > .1 ? 0xff7e91 : 0xb9a0f5, .7);
        gfx.strokeRoundedRect(x + 1, y + 1, size - 2, size - 2, 4);
      }
    }
    const me = lastState.players.find(p => p.id === playerId);
    const target = patches[me?.patchId];
    if (target) {
      gfx.lineStyle(2.5, 0x7ce4cd, 1);
      gfx.strokeRoundedRect(target.x - grid.size / 2, target.y - grid.size / 2, grid.size, grid.size, 5);
    }
  }

  function drawBackdrop(world) {
    const pad = 500;
    gfx.fillStyle(0x091b26, 1);
    gfx.fillRect(-pad, -pad, world.width + pad * 2, world.height + pad * 2);
    gfx.lineStyle(2, 0x50cdb4, 0.6);
    gfx.strokeRect(0, 0, world.width, world.height);
  }

  function drawGrid(world) {
    const step = 200;
    gfx.lineStyle(1, 0x244555, 0.45);
    for (let x = Math.floor(cam.worldView.x / step) * step; x <= cam.worldView.right; x += step) {
      gfx.lineBetween(x, -400, x, world.height + 400);
    }
    for (let y = Math.floor(cam.worldView.y / step) * step; y <= cam.worldView.bottom; y += step) {
      gfx.lineBetween(-400, y, world.width + 400, y);
    }
    const cx = world.width / 2;
    const cy = world.height / 2;
    gfx.lineStyle(2, 0x386372, 0.7);
    gfx.lineBetween(cx - world.width, cy, cx + world.width, cy);
    gfx.lineBetween(cx, cy - world.height, cx, cy + world.height);
  }

  function drawCues(scene) {
    if (!lastState.cues) return;
    const time = serverNow();
    for (const cue of lastState.cues) {
      if (!isVisible(cue.x, cue.y, cue.r)) continue;
      const color = cueColor(cue.type);
      worldLabel(scene, cue.id, cue.label, cue.x, cue.y - cue.r + 24, colorToCss(color));
      const pulse = 0.5 + 0.25 * Math.sin(time / 700 + cue.x * 0.01 + cue.y * 0.01);
      const fillAlpha = 0.12 + 0.1 * pulse;
      const strokeAlpha = 0.55 + 0.25 * pulse;
      gfx.lineStyle(2, color, strokeAlpha);
      gfx.fillStyle(color, fillAlpha * 0.65);
      gfx.fillCircle(cue.x, cue.y, cue.r);
      gfx.strokeCircle(cue.x, cue.y, cue.r);
      const marker = { ...cue, r: 18 };
      switch (cue.shape) {
        case 'circle': gfx.strokeCircle(cue.x, cue.y, 18); break;
        case 'square': gfx.strokeRect(cue.x - 16, cue.y - 16, 32, 32); break;
        case 'diamond': drawCuePolygon(marker, 4, 0, color, strokeAlpha, 0.25); break;
        case 'hex': drawCuePolygon(marker, 6, Math.PI / 6, color, strokeAlpha, 0.25); break;
        case 'triangle': drawCuePolygon(marker, 3, -Math.PI / 2, color, strokeAlpha, 0.25); break;
        case 'capsule': gfx.strokeRoundedRect(cue.x - 22, cue.y - 12, 44, 24, 12); break;
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
      if (!isVisible(pellet.x, pellet.y, 15)) continue;
      const type = pelletMap.get(pellet.type);
      drawPelletMarker(pellet, type);
    }
  }

  function drawPelletMarker(pellet, type) {
    const x = pellet.x;
    const y = pellet.y;
    const color = type?.color ?? 0xffe27a;
    const alpha = 0.88;
    const sizeBase = 1.6;
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
        drawPelletPolygon(x, y, 4, radius * 1.05, 0, color, alpha);
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
    const invulnerable = false;

    if (player.state !== 'osteocyte') drawMotionTrail(player, color);
    if (player.state === 'osteocyte') {
      gfx.lineStyle(1.5, color, .45);
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4;
        const endX = player.x + Math.cos(angle) * 62;
        const endY = player.y + Math.sin(angle) * 62;
        gfx.lineBetween(player.x, player.y, endX, endY);
        gfx.fillStyle(color, .55); gfx.fillCircle(endX, endY, 2);
      }
    }
    if (player.working) { gfx.lineStyle(2, color, .7); gfx.strokeCircle(player.x, player.y, radius + 8); }
    drawCellBody(player, cell, radius, color, outline, alpha, invulnerable);
    gfx.fillStyle(0x102c3b, 0.3);
    gfx.fillCircle(player.x, player.y, radius * 0.3);
    gfx.fillStyle(0xffffff, 0.3);
    gfx.fillCircle(player.x - radius * 0.2, player.y - radius * 0.23, radius * 0.13);
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
      case 'multinucleated':
        gfx.fillStyle(fillColor, alpha);
        gfx.fillEllipse(player.x, player.y, radius * 2.5, radius * 1.7);
        gfx.lineStyle(3, outlineColor, .85);
        gfx.strokeEllipse(player.x, player.y, radius * 2.5, radius * 1.7);
        gfx.fillStyle(0x6f354c, .6);
        for (const [x, y] of [[-.6, -.2], [0, .25], [.55, -.2]]) gfx.fillCircle(player.x + x * radius, player.y + y * radius, radius * .23);
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
    const r = radius;
    gfx.fillStyle(fillColor, alpha);
    gfx.fillCircle(player.x, player.y, r);
    gfx.lineStyle(3, outlineColor, outlineAlpha);
    gfx.strokeCircle(player.x, player.y, r);
  }

  function drawSquareCell(player, fillColor, outlineColor, alpha, outlineAlpha, radius) {
    const size = radius * 1.65;
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
    const halfLen = radius * 0.7;
    const halfThick = radius * 0.55;
    const pts = [];
    for (const side of [1, -1]) {
      for (let i = 0; i <= 10; i++) {
        const angle = -Math.PI / 2 + i * Math.PI / 10 + (side === -1 ? Math.PI : 0);
        const localX = side * halfLen + Math.cos(angle) * halfThick;
        const localY = Math.sin(angle) * halfThick;
        pts.push({ x: player.x + dx * localX + px * localY, y: player.y + dy * localX + py * localY });
      }
    }
    drawPolygonShape(pts, fillColor, outlineColor, alpha, invulnerable ? 0.45 : 0.85);
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
    label.setText(`${player.name} · ${player.state === 'progenitor' ? 'MSC' : player.state}`);
    label.x = player.x;
    label.y = player.y - radius - 10;
    label.setVisible(true);
  }

  function cleanupLabels(active) {
    for (const [id, text] of labelPool.entries()) {
      if (!active.has(id)) {
        text.destroy();
        labelPool.delete(id);
        renderPositions.delete(id);
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
      const traits = document.createElement('small');
      traits.textContent = cell.lineage;
      btn.append(shape, title, desc, traits);
      btn.addEventListener('click', () => {
        selectedCellType = cell.id;
        updateSelectedCellOption();
      });
      cellOptionsEl.appendChild(btn);
    }
    roleSwitch.replaceChildren();
    for (const cell of cellArchetypes) { const option = new Option(cell.label, cell.id); roleSwitch.add(option); }
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
      case 'multinucleated':
        return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><ellipse cx="32" cy="32" rx="26" ry="18" fill="${fill}" stroke="${stroke}" stroke-width="3"/><g fill="#6f354c"><circle cx="18" cy="29" r="5"/><circle cx="32" cy="37" r="5"/><circle cx="45" cy="27" r="5"/></g></svg>`;
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

  function updateHud(me) {
    if (!me) return;
    const metrics = lastState.tissue?.metrics || {};
    const r = me.resources;
    const pct = n => `${Math.round((n || 0) * 100)}%`;
    const label = (cellMap.get(me.cellType)?.label || me.state) + (me.state === 'progenitor' ? ` · Commitment ${pct(me.diffProgress)}` : '');
    const supplyLine = `Energy ${pct(r.energy)} · Asc ${pct(r.ascorbate)} · Ca ${pct(r.calcium)} · Pi ${pct(r.phosphate)}`;
    hudText.setText(window.innerWidth < 700 ? [
      label, `Gap repair ${Math.round(metrics.gapRepair || 0)}% · O₂ ${pct(me.oxygen)}`,
      `Energy ${pct(r.energy)} · Asc ${pct(r.ascorbate)}`, `Ca ${pct(r.calcium)} · Pi ${pct(r.phosphate)}`,
    ] : [
      `Room ${lastState.roomId} · ${lastState.players.length} collaborators · ${label}`,
      `Gap repair ${Math.round(metrics.gapRepair || 0)}% · Tissue integrity ${Math.round(metrics.integrity || 0)}% · O₂ ${pct(me.oxygen)}`,
      supplyLine,
    ]);
    statusText.setVisible(false);
    const patch = tissueData?.roomId === lastState.roomId ? tissueData.patches[me.patchId] : null;
    sitePanel.hidden = false;
    document.getElementById('cellActivity').textContent = me.activity;
    document.getElementById('siteReadout').textContent = patch
      ? `Site: osteoid ${pct(patch.osteoid)} · mature matrix ${pct(patch.matrix)} · mineral ${pct(patch.mineral)} · damage ${pct(patch.damage)}`
      : 'Off scaffold · Red vessel zones refill supplies. Blue zones recruit mesenchymal cells.';
    document.getElementById('cellContribution').textContent = `Your work: ${formatNumber(me.deposited, 1)} tiles of matrix laid · ${formatNumber(me.resorbed, 1)} resorbed · ${formatNumber(me.signaling, 1)} signal units`;
    roleSwitch.value = me.cellType;
    const live = lastState.round.phase === 'playing';
    workButton.disabled = !live || me.state === 'progenitor';
    workButton.textContent = me.state === 'progenitor' ? 'Recruit in a blue zone' : me.state === 'osteocyte' ? 'Hold: sense & signal' : me.state === 'osteoclast' ? 'Hold: resorb damage' : 'Hold: build osteoid';
    roleSwitch.disabled = !live;
    embedButton.disabled = !live || !['osteoblast', 'osteocyte'].includes(me.state);
    embedButton.textContent = me.state === 'osteocyte' ? 'Observe next cell (E)' : 'Embed in bone (E)';
  }

  function renderRound() {
    if (!lastState?.round) { roundHud.style.display = 'none'; return; }
    const r = lastState.round;
    const elapsed = ['playing', 'countdown'].includes(r.phase) ? Math.max(0, serverNow() - lastState.t) : 0;
    const ms = Math.max(0, Math.ceil(r.remainingMs - elapsed));
    const time = `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
    const labels = { lobby: 'Waiting for host', countdown: `Starts in ${Math.ceil(ms / 1000)}s`, playing: `Repair time ${time}`,
      ended: r.outcome === 'bridged' ? 'Bone bridge restored! Team success.' : 'Time up. Review the tissue and try again.' };
    const loading = lastState.tissue?.loading || 'physiological';
    const markup = `<div class="hud-line"><span class="pill">${r.phase === 'playing' ? 'Repair Live' : 'Bone repair'}</span><strong>${labels[r.phase]}</strong></div><div class="hud-line muted">Restore a continuous mineralized bridge · Loading: ${loading}</div>`;
    if (markup !== lastRoundMarkup) { roundHud.innerHTML = markup; lastRoundMarkup = markup; }
    roundHud.style.display = 'block';
  }

  function cueColor(type) {
    switch (type) {
      case 'growth': return 0x70c9ed;
      case 'vascular': return 0xff7e91;
      case 'nutrient': return 0x8fdba5;
      case 'mineral': return 0xf7c66a;
      case 'mechanical': return 0xb9a0f5;
      case 'hormonal': return 0xff8b90;
      case 'flow': return 0x63d8cd;
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
    return 19 * (cell || cellMap.get(player.cellType))?.modifiers?.radius || 19;
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
