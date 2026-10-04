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
    raidContactDamage = false; // touching a boss hurts (BOS-48); tests that are not about it put players on top of bosses all the time
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

  // A point well inside the slash a player's swing draws at a given swingTimer (default 8, mid-swing):
  // handy for putting a boss or a shot exactly where the blade is. p needs x, y, facing, swingDir.
  slashPoint(p, timer = 8) {
    const poly = raidSlashWorldPoly(p, raidSwingProgress(timer));
    const n = (poly.length / 2) | 0, a = poly[(n / 2) | 0], b = poly[poly.length - 1 - ((n / 2) | 0)];
    return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
  },

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
    b.x = 500; b.y = BOSS_HOVER_Y[type] || 90; // a floating boss's idle height (BOS-44)
    raidG.hazards = []; raidG.projectiles = []; raidG.slamAnimations = []; raidG.playerProjectiles = [];
    raidContactDamage = false;
    raidClearTerrain(); // a clean arena (no permanent pieces, no leftovers from the last test)
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
    const states = new Set(), damage = [], terrainDamage = [];
    // Standing in leftover terrain (lava, fire, thorns) hurts too, but that is the arena, not a new attack: count it apart.
    const realUpdateTerrain = raidUpdateTerrain; let terrainHurt = false;
    raidUpdateTerrain = function () { const h0 = T.me().health; realUpdateTerrain(); if (T.me().health < h0) terrainHurt = true; };
    for (let f = 0; f < frames; f++) {
      T.place(playerX, undefined, { invincible: 0 });
      const before = T.me().health;
      terrainHurt = false;
      T.step(1);
      states.add(raidG.boss.anim.state);
      const after = T.me().health;
      if (after < before && terrainHurt) terrainDamage.push({ frame: raidG.frame });
      else if (after < before) {
        const last = T.attackLog.length ? T.attackLog[T.attackLog.length - 1].frame : 0;
        damage.push({ frame: raidG.frame, sinceAttackStart: raidG.frame - last, state: raidG.boss.anim.state });
      }
      if (after <= 2) { raidPlayerRef.child(raidMyId).update({ health: 5 }); raidG.gameOver = false; }
    }
    raidUpdateTerrain = realUpdateTerrain;
    return { states: [...states], spawns: T.spawns, hazards: T.hazardSpawns, attacks: T.attackLog, damage: damage, terrainDamage: terrainDamage };
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
        if (h.kind === 'thornSpike' && h.timer >= 15 && h.timer - (h.delay || 0) < RAID_THORN_WARN + RAID_THORN_ACTIVE + 2) dangers.push({ x: h.x, r: RAID_THORN_HALF + 15 });
        if (h.kind === 'tremor') { const t = h.timer - h.delay; if (h.timer >= 15 && t < RAID_TREMOR_WARN + RAID_TREMOR_ACTIVE + 2) dangers.push({ x: h.x, r: 80 }); }
        if (h.kind === 'featherFall') { const t = h.timer - h.delay; if (h.timer >= 15 && t < RAID_FEATHERFALL_WARN + RAID_FEATHERFALL_ACTIVE + 2) dangers.push({ x: h.x, r: 65 }); }
      });
      // a sensible player does not stand in lava, ghost-fire or thorns once they have formed
      raidG.terrain.forEach((t) => {
        if ((t.kind === 'lava' || t.kind === 'fire' || t.kind === 'thorns') && t.life !== 0) dangers.push({ x: t.x, r: t.w / 2 + 15 });
      });
      if (a.timer >= 15) {
        if (['fade', 'ghost', 'materialize'].includes(a.state) && b.type === 'warden') dangers.push({ x: a.targetX, r: 100 });
        if (['aim', 'dive', 'crash'].includes(a.state) && b.type === 'wyrm') dangers.push({ x: a.targetX, r: 110 });
        if (['sink', 'swim', 'rise'].includes(a.state) && b.type === 'glutton') dangers.push({ x: a.targetX, r: 100 });
        if (['sweepAim', 'sweepPass'].includes(a.state) && b.type === 'wyrm') dangers.push({ x: 500, r: WYRM_SWEEP_LOW_HALF + 20 });
        if (['swoop', 'track', 'plunge', 'thud'].includes(a.state) && b.type === 'griffon') dangers.push({ x: a.targetX, r: 110 });
      }
      raidG.projectiles.forEach((p) => {
        if (!p.isBossProjectile || !(p.life > 0)) return;
        if (p.gravity) {
          // A lobbed shot (fireball, bubble, feather) is only a threat where it comes down, so a
          // sensible player steps away from its landing spot once it is close to landing.
          const g = p.gravity, vy = p.vy, d = (raidGROUND_Y - 14) - p.y;
          const disc = vy * vy + 2 * g * d;
          if (disc < 0) return;
          const t = (-vy + Math.sqrt(disc)) / g; // frames until it reaches the floor
          if (t < 50) dangers.push({ x: p.x + (p.vx || 0) * t, r: Math.max(70, (RAID_LAND_RADIUS[p.onLand] || 0) + 30) });
        } else if (p.y > raidGROUND_Y - 260) {
          dangers.push({ x: p.x + (p.vx || 0) * 12, r: 60 });
        }
      });
      let wantJump = false;
      raidG.hazards.forEach((h) => {
        if ((h.kind === 'shockwave' || h.kind === 'imp' || h.kind === 'quake') && Math.abs(x - h.x) < 55) wantJump = true;
      });
      // standing in lava, ghost-fire or thorns: hop out (a jump clears them)
      raidG.terrain.forEach((t) => {
        if ((t.kind === 'lava' || t.kind === 'fire' || t.kind === 'thorns') && Math.abs(x - t.x) < t.w / 2) wantJump = true;
      });
      // Bramblehide's dash sweeps most of the arena in 18 frames - far too fast to outrun, so the
      // dodge is a jump (like a shockwave), reacting to the boar's own live x as it closes in.
      if (b.type === 'bramblehide' && a.state === 'charging' && Math.abs(x - b.x) < 90) wantJump = true;
      // Griffon's strafing run is a low sweep: same answer, a jump as it reaches you.
      if (b.type === 'griffon' && a.state === 'strafe' && Math.abs(x - b.x) < 150) wantJump = true;
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
