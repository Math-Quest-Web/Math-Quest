// Helpers injected into the page (as window.T) so tests can drive the raid without the
// browser's animation loop: frames are stepped by hand, which keeps every test deterministic.
window.T = {
  // Deterministic Math.random for simulations (mulberry32).
  seed(s) {
    let a = s >>> 0;
    Math.random = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  // Start a raid the same way the lobby does, then take over the frame loop.
  async setupRaid(type = 'grinmaw', difficulty = 'normal') {
    await startFirebase();
    currentDifficulty = difficulty;
    currentBossType = type;
    const id = '9001';
    await lobbyRef.child(id).set({
      name: 'T', hostId: mathQuestUid, status: 'playing', playerCount: 1, createdAt: 1,
      bossType: type, difficulty: difficulty, players: { [mathQuestUid]: { joinedAt: 1 } }
    });
    currentLobbyId = id; currentLobbyName = 'T'; isLobbyHost = true;
    startRaidWithLobby(id, type);
    raidLoopRunning = false; // we step frames manually
    clearInterval(countdownInterval); countdownInterval = null;
    countdownActive = false; countdownOverlay.style.display = 'none';
    raidIsHost = true; raidHostChecked = true;
    return id;
  },

  // One game frame: same order as raidGameLoop, minus drawing. opts.local also runs the local player.
  step(n = 1, opts = {}) {
    for (let i = 0; i < n; i++) {
      raidG.frame++;
      if (opts.local) raidUpdateLocal();
      if (raidIsHost) raidBossUpdate();
      mqCheckRaidReward();
    }
  },

  me() { return raidG.players[raidMyId]; },

  // Put the local player at horizontal centre x (feet on the ground unless y is given, y = top edge).
  place(x, y, extra) {
    y = y === undefined ? raidGROUND_Y - 48 : y;
    raidLocal.x = x - 18; raidLocal.y = y; raidLocal.vy = 0; raidLocal.vx = 0;
    raidPlayerRef.child(raidMyId).update(Object.assign({ x: x - 18, y: y, invincible: 0, health: raidLocal.health }, extra || {}));
  },

  // Reset the boss to a clean idle state at a given phase without recreating the raid.
  prepBoss(type, phase = 1) {
    const b = raidG.boss;
    b.type = type;
    b.anim = { state: 'idle', timer: 0 };
    b.animScale = 1; b.animAlpha = 1; b.animOffsetX = 0; b.animOffsetY = 0;
    b.maxHp = BOSS_DEFS[type].maxHp;
    b.hp = Math.round(b.maxHp * (phase === 3 ? 0.2 : phase === 2 ? 0.5 : 1));
    b.phase = phase; b.lastPhase = phase;
    b.exposed = 0; b.transition = 0; b.attackTimer = 99999; b.invulnerable = false;
    b.feastCooldown = 99999; b.comboPending = false; b.lastAttack = '';
    b.x = 500; b.y = 90;
    raidG.hazards = []; raidG.projectiles = []; raidG.slamAnimations = []; raidG.playerProjectiles = [];
    raidG.mathEvent = null; raidG.gameOver = false; raidG.victory = false;
    raidLocal.health = 5;
    raidPlayerRef.child(raidMyId).update({ health: 5, invincible: 0 });
  },

  // Record every attack the boss starts, with the animation state it started from.
  recordAttacks() {
    T.attackLog = [];
    Object.keys(BOSS_ATTACK_FNS).forEach((k) => {
      if (!BOSS_ATTACK_FNS[k].__wrapped) {
        const orig = BOSS_ATTACK_FNS[k];
        const w = function (b) { T.attackLog.push({ frame: raidG.frame, state: b.anim.state, comboPending: b.comboPending }); return orig(b); };
        w.__wrapped = true;
        BOSS_ATTACK_FNS[k] = w;
      }
    });
  },

  // Record everything the boss spawns. raidG.projectiles / raidG.hazards get replaced by arrays
  // from the (stub) database all the time, so wrap them with accessors that proxy each new array.
  watch() {
    T.spawns = []; T.hazardSpawns = [];
    const wrap = (key, sink) => {
      let cur = raidG[key];
      const proxify = (arr) => new Proxy(arr, {
        get(t, k) {
          if (k === 'push') {
            return (...items) => {
              items.forEach((it) => sink.push(Object.assign({}, it, { _frame: raidG.frame, _bx: raidG.boss.x, _by: raidG.boss.y })));
              return t.push(...items);
            };
          }
          const v = t[k];
          return typeof v === 'function' ? v.bind(t) : v;
        }
      });
      Object.defineProperty(raidG, key, { configurable: true, get() { return cur; }, set(v) { cur = Array.isArray(v) ? proxify(v) : v; } });
      raidG[key] = cur;
    };
    wrap('projectiles', T.spawns);
    wrap('hazards', T.hazardSpawns);
  },

  // Run a whole fight with a stationary player (invincibility reset every frame so that EVERY
  // damaging event is counted). Reports states seen, spawns, hazards, attacks and damage timing.
  simulate(type, phase, frames, playerX = 500) {
    T.prepBoss(type, phase);
    raidG.boss.attackTimer = 30;
    T.recordAttacks();
    T.watch();
    const states = new Set(), damage = [];
    for (let f = 0; f < frames; f++) {
      T.place(playerX, undefined, { invincible: 0 });
      const before = T.me().health;
      T.step(1);
      states.add(raidG.boss.anim.state);
      const after = T.me().health;
      if (after < before) {
        const last = T.attackLog.length ? T.attackLog[T.attackLog.length - 1].frame : 0;
        damage.push({ frame: raidG.frame, sinceAttackStart: raidG.frame - last, state: raidG.boss.anim.state });
      }
      if (after <= 2) { raidPlayerRef.child(raidMyId).update({ health: 5 }); raidG.gameOver = false; }
    }
    return { states: [...states], spawns: T.spawns, hazards: T.hazardSpawns, attacks: T.attackLog, damage: damage };
  },

  // Step frames until pred() is true; returns how many frames it took (or -1).
  until(pred, max = 2000) {
    for (let i = 1; i <= max; i++) { T.step(1); if (pred()) return i; }
    return -1;
  },

  // A simple dodging player: moves at `speed` px/frame away from telegraphed danger after a
  // reaction delay of 15 frames, and jumps over floor hazards. Returns the number of hits taken.
  runBot(type, frames, phase, speed = 4.5) {
    T.prepBoss(type, phase);
    raidG.boss.attackTimer = 30;
    let x = 500, airborne = 0, jumpCd = 0, hits = 0, lastHp = 5, iframes = 0;
    for (let f = 0; f < frames; f++) {
      const b = raidG.boss;
      const a = b.anim || { state: 'idle', timer: 0 };
      const dangers = [];
      raidG.hazards.forEach((h) => {
        if (h.kind === 'chainLash') { const t = h.timer - h.delay; if (t >= 15 && t < 82) dangers.push({ x: h.tx, r: 75 }); }
        if (h.kind === 'pillar' && h.timer >= 15 && h.timer < 62) dangers.push({ x: h.x, r: 75 });
      });
      if (a.timer >= 15) {
        if (['fade', 'ghost', 'materialize'].includes(a.state) && b.type === 'warden') dangers.push({ x: a.targetX, r: 100 });
        if (['aim', 'dive', 'crash'].includes(a.state) && b.type === 'wyrm') dangers.push({ x: a.targetX, r: 110 });
        if (['sink', 'swim', 'rise'].includes(a.state) && b.type === 'glutton') dangers.push({ x: a.targetX, r: 100 });
      }
      raidG.projectiles.forEach((p) => { if (p.isBossProjectile && p.life > 0 && p.y > raidGROUND_Y - 260) dangers.push({ x: p.x + (p.vx || 0) * 12, r: 60 }); });
      let wantJump = false;
      raidG.hazards.forEach((h) => {
        if ((h.kind === 'shockwave' || h.kind === 'imp') && Math.abs(x - h.x) < 55) wantJump = true;
      });
      if (wantJump && airborne <= 0 && jumpCd <= 0) { airborne = 45; jumpCd = 70; }
      const inDanger = (d) => dangers.some((dd) => Math.abs(d - dd.x) < dd.r);
      if (inDanger(x)) {
        let best = null;
        for (let k = 10; k < 700 && best === null; k += 10) {
          if (x + k <= 960 && !inDanger(x + k)) best = x + k; else if (x - k >= 40 && !inDanger(x - k)) best = x - k;
        }
        if (best !== null) x += Math.sign(best - x) * Math.min(speed, Math.abs(best - x));
      }
      if (airborne > 0) airborne--; if (jumpCd > 0) jumpCd--;
      T.place(x, airborne > 0 ? raidGROUND_Y - 48 - 90 : raidGROUND_Y - 48, { invincible: iframes > 0 ? 30 : 0 });
      if (iframes > 0) iframes--;
      raidG.frame++; raidBossUpdate();
      const h = T.me().health;
      if (h < lastHp) { hits += lastHp - h; iframes = 30; }
      lastHp = h;
      if (h <= 2) { raidPlayerRef.child(raidMyId).update({ health: 5 }); lastHp = 5; raidG.gameOver = false; }
    }
    return hits;
  }
};
