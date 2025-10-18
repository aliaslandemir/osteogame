(() => {
  const params = new URLSearchParams(location.search);
  let roomId = params.get('room');
  const overlay = document.getElementById('overlay');
  const errorEl = document.getElementById('error');
  const roomInput = document.getElementById('room');
  const nameInput = document.getElementById('name');
  const pinInput = document.getElementById('pin');
  const teamSel = document.getElementById('team');

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
    const team = teamSel.value;
    roomId = useRoom;
    socket.emit('join', { roomId: useRoom, name, pin, team });
  });

  socket.on('join_ok', (data) => {
    playerId = data.playerId;
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
      fontFamily: 'monospace',
      fontSize: 14,
      color: '#e6eef7',
    }).setScrollFactor(0).setDepth(2000);

    statusText = this.add.text(8, 28, '', {
      fontFamily: 'monospace',
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
    gfx.clear();
    // background grid even before state arrives
    drawGrid();
    if (!lastState) {
      return;
    }

    const world = lastState.world || { width: 4000, height: 4000 };
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

  function drawGrid() {
    const step = 200;
    gfx.lineStyle(1, 0x18202b, 0.5);
    for (let x = -2000; x <= 6000; x += step) {
      gfx.lineBetween(x, -2000, x, 6000);
    }
    for (let y = -2000; y <= 6000; y += step) {
      gfx.lineBetween(-2000, y, 6000, y);
    }
  }

  function drawCues() {
    if (!lastState.cues) return;
    for (const cue of lastState.cues) {
      const color = cueColor(cue.type);
      switch (cue.shape) {
        case 'circle':
          gfx.lineStyle(3, color, 0.9);
          gfx.fillStyle(color, 0.18);
          gfx.strokeCircle(cue.x, cue.y, cue.r);
          gfx.fillCircle(cue.x, cue.y, cue.r);
          break;
        case 'square':
          gfx.lineStyle(3, color, 0.9);
          gfx.fillStyle(color, 0.18);
          gfx.strokeRect(cue.x - cue.r, cue.y - cue.r, cue.r * 2, cue.r * 2);
          gfx.fillRect(cue.x - cue.r, cue.y - cue.r, cue.r * 2, cue.r * 2);
          break;
        case 'diamond':
          drawCuePolygon(cue, 4, Math.PI / 4, color);
          break;
        case 'hex':
          drawCuePolygon(cue, 6, Math.PI / 6, color);
          break;
        default:
          drawCuePolygon(cue, 5, 0, color);
          break;
      }
    }
  }

  function drawCuePolygon(cue, sides, rotation, color) {
    gfx.lineStyle(2, color, 0.6);
    gfx.fillStyle(color, 0.08);
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
    if (!lastState.pellets) return;
    gfx.fillStyle(0xffe27a, 0.95);
    for (const pellet of lastState.pellets) {
      gfx.fillCircle(pellet.x, pellet.y, 7);
    }
  }

  function drawPlayer(scene, player) {
    const isMe = player.id === playerId;
    const color = playerColor(player);
    const outline = isMe ? 0xffffff : 0x1b2433;
    const alpha = isMe ? 1.0 : 0.85;
    const radius = clientRadius(player);
    const now = Date.now();
    const invulnerable = player.invulnerableUntil && player.invulnerableUntil > now;

    if (player.morph === 'elongated') {
      drawElongated(player, color, outline, alpha, invulnerable, radius);
    } else if (player.morph === 'hypertrophic') {
      gfx.fillStyle(color, alpha);
      gfx.fillCircle(player.x, player.y, radius * 1.05);
      gfx.lineStyle(3, outline, invulnerable ? 0.45 : 0.8);
      gfx.strokeCircle(player.x, player.y, radius * 1.05);
    } else {
      gfx.fillStyle(color, alpha);
      gfx.fillCircle(player.x, player.y, radius);
      gfx.lineStyle(2, outline, invulnerable ? 0.45 : 0.85);
      gfx.strokeCircle(player.x, player.y, radius);
    }

    drawLabel(scene, player, radius);
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
    const captures = player.captures ? ` ⚡${player.captures}` : '';
    label.setText(`${player.name} · ${mass}${captures}`);
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

  function updateHud(me) {
    const board = lastState.scoreboard || {};
    const teamA = board['A'] || { players: 0, biomass: 0, minerals: 0, captures: 0 };
    const teamB = board['B'] || { players: 0, biomass: 0, minerals: 0, captures: 0 };
    const totalPlayers = lastState.players?.length || 0;
    const meState = me ? `${me.state}/${me.morph}` : 'spectating';
    const meMass = me && Number.isFinite(me.mass) ? me.mass.toFixed(1) : '0.0';
    const meCaptures = me && Number.isFinite(me.captures) ? me.captures : 0;

    const cuesCount = lastState.cues ? lastState.cues.length : 0;
    const pelletsCount = lastState.pellets ? lastState.pellets.length : 0;
    hudText.setText(
      `Room ${lastState.roomId} | Players:${totalPlayers} | Cues:${cuesCount} Pellets:${pelletsCount} | ` +
      `A P:${teamA.players} Bio:${teamA.biomass.toFixed(0)} Capt:${teamA.captures} | ` +
      `B P:${teamB.players} Bio:${teamB.biomass.toFixed(0)} Capt:${teamB.captures} | ` +
      `You mass:${meMass} stage:${meState} captures:${meCaptures}`
    );

    if (!me) {
      statusText.setVisible(false);
      return;
    }

    const now = Date.now();
    const invulnLeft = me.invulnerableUntil ? me.invulnerableUntil - now : 0;
    if (now - (me.lastEatenAt || 0) < 2600) {
      const seconds = Math.max(0, invulnLeft / 1000).toFixed(1);
      statusText.setText(`You were resorbed! Invulnerable ${seconds}s`);
      statusText.setVisible(true);
    } else if (invulnLeft > 0) {
      const seconds = (invulnLeft / 1000).toFixed(1);
      statusText.setText(`Invulnerable ${seconds}s`);
      statusText.setVisible(true);
    } else {
      statusText.setVisible(false);
    }
  }

  function renderRound() {
    if (!lastState || !lastState.round) { roundHud.style.display = 'none'; return; }
    const r = lastState.round;
    const ms = Math.max(0, Math.floor(r.remainingMs || 0));
    const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
    const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    let text = '';
    if (r.phase === 'lobby') text = 'Lobby — waiting to start';
    else if (r.phase === 'countdown') text = `Round starting in ${ss}s`;
    else if (r.phase === 'playing') text = `Time left ${mm}:${ss}`;
    else if (r.phase === 'ended') text = 'Round ended';
    roundHud.textContent = text;
    roundHud.style.display = 'block';
  }

  function cueColor(type) {
    switch (type) {
      case 'growth': return 0x4cc9f0;
      case 'nutrient': return 0x9ef01a;
      case 'mineral': return 0xf8961e;
      case 'mechanical': return 0xc77dff;
      default: return 0xffffff;
    }
  }

  function playerColor(player) {
    const base = player.team === 'A' ? 0x7fd1b9 : 0x7fa7d1;
    if (player.state === 'osteoblast') return 0xf284c0;
    return base;
  }

  function clientRadius(player) {
    const base = 12 + Math.sqrt(player.mass || 0);
    if (player.morph === 'elongated') return base * 1.25;
    if (player.morph === 'hypertrophic') return base * 1.1;
    return base;
  }
})();
