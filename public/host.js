const byId = (id) => document.getElementById(id);
      const baseUrlInput = byId('baseUrl');
      const defaultOrigin = `${location.protocol}//${location.host}`;
      const savedBase = (typeof localStorage !== 'undefined' && localStorage.getItem('hostBaseUrl')) || '';
      baseUrlInput.value = savedBase || defaultOrigin;
      baseUrlInput.addEventListener('change', () => {
        const value = baseUrlInput.value.trim();
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('hostBaseUrl', value);
        }
      });

      function resolveBaseUrl() {
        let raw = baseUrlInput.value.trim();
        if (!raw) raw = defaultOrigin;
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
          raw = `http://${raw}`;
        }
        return raw.replace(/\/+$/, '');
      }

      let activeRoomId = null;
      let creatingRoom = false;
      const notice = byId('hostNotice');
      const showError = (error) => { notice.textContent = error?.message || 'Request failed. Check your connection.'; };
      async function request(url, body) {
        const response = await fetch(url, body === undefined ? {} : {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
      }
      function updateJoinLink() {
        if (!activeRoomId) return;
        const base = new URL(resolveBaseUrl());
        if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Use an HTTP or HTTPS address.');
        const joinUrl = `${base.origin}/play?room=${activeRoomId}`;
        byId('joinUrl').value = joinUrl;
        const qrNode = byId('qr');
        qrNode.replaceChildren();
        new QRCode(qrNode, { text: joinUrl, width: 240, height: 240,
          colorDark: '#091b26', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      }
      baseUrlInput.addEventListener('change', () => { try { updateJoinLink(); } catch (e) { showError(e); } });
      async function updateStatus() {
        if (!activeRoomId) return;
        const status = byId('roomStatus');
        status.style.display = 'block';
        try {
          const data = await request(`/api/rooms/${activeRoomId}/summary`);
          const phase = data.round.phase;
          const live = ['countdown', 'playing'].includes(phase);
          byId('regen').disabled = live;
          byId('startRound').disabled = live;
          byId('startRound').textContent = live ? 'Round in progress' : 'Start Round';
          const seconds = Math.ceil(data.round.remainingMs / 1000);
          const metrics = data.tissue.metrics;
          status.textContent = `${data.players}/48 collaborators · ${phase}${live ? ` · ${seconds}s` : ''} · Gap repair ${Math.round(metrics.gapRepair)}% · Integrity ${Math.round(metrics.integrity)}% · ${metrics.bridged ? 'Bone bridge restored' : 'Bridge incomplete'} · ${data.tissue.loading} loading`;
        } catch (e) { status.textContent = `Status: ${e.message}`; }
      }
      byId('create').addEventListener('click', async () => {
        if (creatingRoom) return;
        creatingRoom = true;
        byId('create').disabled = true;
        notice.textContent = '';
        try {
          const base = new URL(resolveBaseUrl());
          if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Use an HTTP or HTTPS address.');
          const data = await request('/api/create-room', { pin: byId('pin').value.trim() || undefined });
          activeRoomId = data.roomId;
          byId('room').style.display = '';
          byId('roomId').textContent = activeRoomId;
          byId('roomPin').textContent = data.pin || '(none)';
          updateJoinLink();
          await request(`/api/rooms/${activeRoomId}/loading`, { loading: byId('loading').value });
          await updateStatus();
        } catch (e) { showError(e); }
        finally { creatingRoom = false; byId('create').disabled = false; }
      });
      byId('loading').addEventListener('change', async () => {
        if (!activeRoomId) return;
        try { await request(`/api/rooms/${activeRoomId}/loading`, { loading: byId('loading').value }); await updateStatus(); }
        catch (e) { showError(e); }
      });
      byId('copyLink').onclick = async () => {
        try {
          await navigator.clipboard.writeText(byId('joinUrl').value);
          byId('copyLink').textContent = 'Copied!';
          setTimeout(() => { byId('copyLink').textContent = 'Copy Link'; }, 1200);
        } catch {
          byId('joinUrl').select();
          notice.textContent = 'Select and copy the highlighted link. Clipboard access requires HTTPS or localhost.';
        }
      };
      byId('openPlay').onclick = () => window.open(byId('joinUrl').value, '_blank', 'noopener');
      byId('startRound').onclick = async () => {
        byId('startRound').disabled = true;
        try { await request('/api/start-round', { roomId: activeRoomId }); }
        catch (e) { showError(e); }
        await updateStatus();
      };
      byId('refreshStatus').onclick = updateStatus;
      byId('regen').onclick = async () => {
        try { await request(`/api/rooms/${activeRoomId}/regenerate`, {}); await updateStatus(); }
        catch (e) { showError(e); }
      };
      setInterval(() => { if (!document.hidden) updateStatus(); }, 2000);

      // Hero open play shortcut
      const openPlayHero = byId('openPlayHero');
      if (openPlayHero) openPlayHero.addEventListener('click', () => window.open('/play', '_blank', 'noopener'));

      // Guided tour for hosts
      const tourSteps = [
        { title: 'Set your LAN address', body: 'Point the QR to your LAN IP so kids on Wi-Fi can join.', targetId: 'baseUrl' },
        { title: 'Create a room', body: 'Optional PIN keeps random joiners out. Press Create to generate a code.', targetId: 'create' },
        { title: 'Share the QR', body: 'Show the QR or copy the join link. Phones scan and jump straight to the room.', targetId: 'qr' },
        { title: 'Start the round', body: 'Kick off a countdown. A fresh bone gap appears. Build a connected mineralized bridge.', targetId: 'startRound' },
        { title: 'Watch the culture', body: 'Watch gap repair and tissue integrity. Change loading to explore mechanobiology.', targetId: 'roomStatus' },
      ];
      const tourOverlay = document.createElement('div');
      tourOverlay.className = 'tour-overlay';
      tourOverlay.innerHTML = `
        <div class="tour-card">
          <div class="tour-step">
            <div class="badge" id="tourBadge">1</div>
            <div>
              <h3 id="tourTitle" style="margin:0 0 4px 0;">Guided tour</h3>
              <p class="muted" id="tourBody" style="margin:0;">Welcome to OsteoGame hosting.</p>
            </div>
          </div>
          <div class="tour-nav">
            <div class="muted" id="tourHint">Follow the neon highlight.</div>
            <div class="row" style="gap:8px;">
              <button id="tourPrev" class="btn-ghost" type="button">Back</button>
              <button id="tourNext" class="btn-accent" type="button">Next</button>
              <button id="tourClose" class="btn-danger" type="button">End tour</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(tourOverlay);
      const tourTitle = byId('tourTitle');
      const tourBody = byId('tourBody');
      const tourBadge = byId('tourBadge');
      const tourHint = byId('tourHint');
      const tourPrev = byId('tourPrev');
      const tourNext = byId('tourNext');
      const tourClose = byId('tourClose');
      let tourIndex = 0;
      let highlighted = null;

      const showStep = (delta = 0) => {
        tourIndex = Math.max(0, Math.min(tourSteps.length - 1, tourIndex + delta));
        const step = tourSteps[tourIndex];
        tourTitle.textContent = step.title;
        tourBody.textContent = step.body;
        tourBadge.textContent = `${tourIndex + 1}/${tourSteps.length}`;
        tourHint.textContent = 'Follow the neon highlight.';
        if (highlighted) highlighted.classList.remove('highlight');
        const target = step.targetId ? byId(step.targetId) : null;
        if (target) {
          highlighted = target;
          highlighted.classList.add('highlight');
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          highlighted = null;
          tourHint.textContent = 'This step shows once the element exists.';
        }
        tourOverlay.style.display = 'flex';
      };

      const endTour = () => {
        if (highlighted) highlighted.classList.remove('highlight');
        highlighted = null;
        tourOverlay.style.display = 'none';
      };

      const startTourBtn = byId('startTour');
      if (startTourBtn) startTourBtn.addEventListener('click', () => { tourIndex = 0; showStep(0); });
      tourPrev.addEventListener('click', () => showStep(-1));
      tourNext.addEventListener('click', () => showStep(1));
      tourClose.addEventListener('click', endTour);
      tourOverlay.addEventListener('click', (e) => { if (e.target === tourOverlay) endTour(); });
