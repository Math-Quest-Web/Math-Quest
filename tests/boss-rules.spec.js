// Spec 9.1: the rules every boss must follow (sourced, telegraphed, dodgeable, no overlap, phases,
// stun, feedback). Whole fights are simulated with a seeded RNG so results are repeatable.
const { test, expect } = require('./support/fixtures');

const BOSSES = ['grinmaw', 'warden', 'wyrm', 'glutton', 'bramblehide', 'colossus', 'griffon'];

test.describe('Boss design rules (spec 9.1)', () => {
  test('BOS-01 every projectile and hazard comes from the boss or a marked spot - nothing appears from nowhere', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (const boss of BOSS_ORDER) {
        T.seed(7);
        const sim = T.simulate(boss, 3, 3600);
        const orbs = sim.hazards.filter((h) => h.kind === 'voidOrb');
        const far = sim.spawns.filter((p) => {
          if (p.kind === 'void') return false; // bursts out of an orb, checked below
          return Math.hypot(p.x - p._bx, p.y - p._by) > 140;
        }).map((p) => ({ kind: p.kind, dx: Math.round(p.x - p._bx), dy: Math.round(p.y - p._by) }));
        const voidShots = sim.spawns.filter((p) => p.kind === 'void').length;
        const orbsNearBoss = orbs.filter((o) => Math.hypot(o.x - o._bx, o.y - o._by) < 60).length;
        const hazardKinds = [...new Set(sim.hazards.map((h) => h.kind))].sort();
        const embers = sim.spawns.filter((p) => p.kind === 'ember').length;
        const pillars = sim.hazards.filter((h) => h.kind === 'pillar').length;
        const thornSpikes = sim.hazards.filter((h) => h.kind === 'thornSpike').length;
        const quakes = sim.hazards.filter((h) => h.kind === 'quake').length;
        // imps/shockwaves/quakes all start at the boss
        const impsFar = sim.hazards.filter((h) => h.kind === 'imp' && Math.hypot(h.x - h._bx, h.y - h._by) > 80).length;
        const wavesFar = sim.hazards.filter((h) => h.kind === 'shockwave' && Math.abs(h.x - h._bx) > 5).length;
        const quakesFar = sim.hazards.filter((h) => h.kind === 'quake' && Math.abs(h.x - h._bx) > 5).length;
        out[boss] = { far, voidShots, orbs: orbs.length, orbsNearBoss, hazardKinds, embers, pillars, thornSpikes, quakes, impsFar, wavesFar, quakesFar, attacks: sim.attacks.length };
      }
      return out;
    });
    const allowed = ['burst', 'chainLash', 'featherFall', 'imp', 'pillar', 'quake', 'shockwave', 'thornSpike', 'tremor', 'voidOrb'];
    for (const b of BOSSES) {
      expect(r[b].attacks, b + ' attacked').toBeGreaterThan(5);
      expect(r[b].far, b + ' projectiles spawning far from the boss').toEqual([]);
      expect(r[b].impsFar).toBe(0);
      expect(r[b].wavesFar).toBe(0);
      expect(r[b].quakesFar, b + ' quakes only ever spread from directly under the boss').toBe(0);
      r[b].hazardKinds.forEach((k) => expect(allowed, b + ' hazard kind ' + k).toContain(k));
      if (b !== 'bramblehide') {
        expect(r[b].thornSpikes, b + " thorn spikes only come from Bramblehide's own marks/pods").toBe(0);
      }
      if (b !== 'colossus') {
        expect(r[b].quakes, b + ' quakes only come from Colossus stomping').toBe(0);
        expect(r[b].hazardKinds, b + ' has no tremors').not.toContain('tremor');
      }
      if (b !== 'griffon') expect(r[b].hazardKinds, b + ' has no feather drops').not.toContain('featherFall');
    }
    // every void burst belongs to an orb that was conjured at the Warden's hands
    expect(r.warden.orbs).toBeGreaterThan(0);
    expect(r.warden.orbsNearBoss).toBe(r.warden.orbs);
    expect(r.warden.voidShots).toBe(r.warden.orbs * 8);
    // only the Wyrm spits fireballs, so nothing else - including the new bosses - ever makes flame
    // pillars any more (Bramblehide/Colossus's ground eruptions are their own thornSpike/quake kinds)
    expect(r.grinmaw.pillars + r.warden.pillars + r.glutton.pillars + r.griffon.pillars + r.bramblehide.pillars + r.colossus.pillars).toBe(0);
    // Bramblehide's thorn spikes come from a marked spot (a player's position) or a landed pod,
    // never appearing with no source.
    expect(r.bramblehide.thornSpikes).toBeGreaterThan(0);
    // Colossus's quakes always spread from directly under its own feet (checked via quakesFar above).
    expect(r.colossus.quakes).toBeGreaterThan(0);
  });

  test('BOS-02 no attack can hurt within 25 frames of starting - there is always a readable wind-up', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (const boss of BOSS_ORDER) {
        let earliest = Infinity, hits = 0, nonIdleStarts = 0, attacks = 0;
        for (const phase of [1, 2]) {
          T.seed(11 + phase);
          const sim = T.simulate(boss, phase, 3000);
          attacks += sim.attacks.length;
          nonIdleStarts += sim.attacks.filter((a) => a.state !== 'idle').length;
          sim.damage.forEach((d) => { hits++; earliest = Math.min(earliest, d.sinceAttackStart); });
        }
        out[boss] = { earliest: earliest === Infinity ? 999 : earliest, hits, nonIdleStarts, attacks };
      }
      return out;
    });
    for (const b of BOSSES) {
      expect(r[b].attacks, b + ' attacks').toBeGreaterThan(8);
      expect(r[b].hits, b + ' did hit a stationary player at some point').toBeGreaterThan(0);
      expect(r[b].earliest, b + ' earliest damage after attack start').toBeGreaterThanOrEqual(25);
    }
  });

  test('BOS-03 every attack is dodgeable: a moving player (4.5 px/frame, 15-frame reaction) takes few hits', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (const boss of BOSS_ORDER) {
        T.seed(21);
        const bot = T.runBot(boss, 3600, 3);
        T.seed(21);
        const still = T.simulate(boss, 3, 3600).damage.length;
        out[boss] = { bot, still };
      }
      return out;
    });
    for (const b of BOSSES) {
      expect(r[b].bot, b + ' hits on a dodging player in 60 s of phase 3').toBeLessThanOrEqual(8);
      expect(r[b].still, b + ' should hurt a player who never moves').toBeGreaterThan(r[b].bot);
    }
  });

  test('BOS-03 floor hazards can be jumped or walked around, and no screen-wide sweep exists', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      const out = {};
      const health = () => T.me().health;
      // low hazards (shockwave, imp): grounded player is hurt, airborne player is not
      for (const kind of ['shockwave', 'imp']) {
        for (const airborne of [false, true]) {
          T.prepBoss('grinmaw', 1); raidLocal.health = 5;
          T.place(500, airborne ? raidGROUND_Y - 48 - 80 : undefined, { health: 5 });
          if (kind === 'shockwave') raidHazard({ kind: 'shockwave', x: 500, dir: 1, speed: 0, life: 50 });
          else raidHazard({ kind: 'imp', x: 500, y: raidGROUND_Y - 40, vx: 0, vy: 0, life: 50 });
          T.step(1);
          out[kind + (airborne ? 'Air' : 'Ground')] = health();
        }
      }
      // pillar of flame and chain: hurt when standing there, not when standing 120px away
      for (const kind of ['pillar', 'chainLash']) {
        for (const dx of [0, 120]) {
          T.prepBoss('wyrm', 1); T.place(500, undefined, { health: 5 });
          if (kind === 'pillar') raidHazard({ kind: 'pillar', x: 500 + dx, life: 66, timer: 40 });
          else raidHazard({ kind: 'chainLash', tx: 500 + dx, ty: raidGROUND_Y - 6, delay: 0, timer: 65, life: 100 });
          T.step(1);
          out[kind + (dx ? 'Far' : 'Near')] = health();
        }
      }
      // no hazard type in the game sweeps the whole screen any more
      out.legacyKinds = ['breath', 'chainSweep', 'voidPull', 'teleportReticle'].filter((k) => raidUpdateHazards.toString().includes("'" + k + "'"));
      return out;
    });
    expect(r).toEqual({
      shockwaveGround: 4, shockwaveAir: 5, impGround: 4, impAir: 5,
      pillarNear: 4, pillarFar: 5, chainLashNear: 4, chainLashFar: 5, legacyKinds: []
    });
  });

  test('BOS-45 every floor strike is warned by a marker as wide as its hit zone that flashes faster as it nears, and long attacks are marked from the start', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('bramblehide');
      raidFx.shake = 0;
      T.place(900); // keep the local player out of the way
      const W = 1000, H = 600;
      const grab = () => raidCtx.getImageData(0, 0, W, H).data;
      const changed = (a, b, x0, x1, y0, y1) => {
        let n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; }
        return n;
      };
      const out = {};
      const kinds = { thornSpike: RAID_THORN_HALF, pillar: 38, tremor: 46, featherFall: 34 };
      for (const kind of Object.keys(kinds)) {
        const half = kinds[kind];
        raidG.hazards = []; raidG.frame = 100; raidDraw(); const empty = grab();
        const mk = (timer) => ({ kind, x: 300, timer, delay: 0, life: 200, tx: 300 });
        raidG.hazards = [mk(10)]; raidG.frame = 100; raidDraw(); const early = grab();
        out[kind] = {
          leftEdge: changed(empty, early, 300 - half + 2, 300 - half + 8, raidGROUND_Y - 14, raidGROUND_Y + 12),
          rightEdge: changed(empty, early, 300 + half - 8, 300 + half - 2, raidGROUND_Y - 14, raidGROUND_Y + 12),
          outside: changed(empty, early, 300 + half + 14, 300 + half + 40, raidGROUND_Y - 14, raidGROUND_Y + 12)
        };
        // near the strike the marker flashes: two frames four apart look different
        raidG.hazards = [mk(30)]; raidG.frame = 100; raidDraw(); const f1 = grab();
        raidG.hazards = [mk(30)]; raidG.frame = 104; raidDraw(); const f2 = grab();
        out[kind].flash = changed(f1, f2, 300 - half, 300 + half, raidGROUND_Y - 14, raidGROUND_Y + 12);
      }
      return out;
    });
    for (const kind of ['thornSpike', 'pillar', 'tremor', 'featherFall']) {
      expect(r[kind].leftEdge, kind + ' marker reaches the left edge of its hit zone').toBeGreaterThan(5);
      expect(r[kind].rightEdge, kind + ' marker reaches the right edge of its hit zone').toBeGreaterThan(5);
      expect(r[kind].outside, kind + ' marker does not overstate the danger').toBe(0);
      expect(r[kind].flash, kind + ' marker flashes').toBeGreaterThan(20);
    }
  });

  test('BOS-04 an attack only ever starts from the idle animation, so moves never overlap', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (const boss of BOSS_ORDER) {
        T.seed(3);
        const sim = T.simulate(boss, 3, 6000);
        out[boss] = { attacks: sim.attacks.length, notIdle: sim.attacks.filter((a) => a.state !== 'idle').length };
      }
      return out;
    });
    for (const b of BOSSES) {
      expect(r[b].attacks, b).toBeGreaterThan(10);
      expect(r[b].notIdle, b + ' attacks that interrupted another animation').toBe(0);
    }
  });

  test('BOS-04 the gap between attacks only counts idle time, so a long move never eats into the rest that follows', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (const boss of BOSS_ORDER) {
        T.seed(6);
        T.prepBoss(boss, 1); raidG.boss.attackTimer = 30; T.recordAttacks();
        let idle = 0, seen = 0; const gaps = [];
        for (let f = 0; f < 6000; f++) {
          T.place(500, undefined, { invincible: 30 });
          T.step(1);
          if (T.attackLog.length > seen) { seen = T.attackLog.length; gaps.push(idle); idle = 0; }
          else if (raidG.boss.anim.state === 'idle') idle++;
          else idle = 0;
          if (T.me().health <= 2) { raidPlayerRef.child(raidMyId).update({ health: 5 }); raidG.gameOver = false; }
        }
        out[boss] = gaps.slice(1); // the first gap is the short opening delay
      }
      return out;
    });
    for (const b of BOSSES) {
      expect(r[b].length, b + ' attacks').toBeGreaterThan(5);
      // Normal, phase 1: 170 idle frames before every attack
      r[b].forEach((g) => expect(g, b + ' idle frames before an attack').toBeGreaterThanOrEqual(165));
    }
  });

  test('BOS-05 gap between attacks is (190 - 20 x phase) idle frames on Normal, with a quiet start', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('wyrm');
      const out = { gaps: [] };
      T.recordAttacks();
      // the fight opens with about 3 seconds of quiet
      T.step(190); const early = T.attackLog.length; T.step(20);
      out.firstAttackNotBefore200 = [early, T.attackLog.length];
      for (const phase of [1, 2, 3]) {
        T.prepBoss('grinmaw', phase); raidG.boss.attackTimer = 1; currentDifficulty = 'normal';
        raidBossUpdate();
        out.gaps.push(raidG.boss.attackTimer);
      }
      return out;
    });
    expect(r.firstAttackNotBefore200).toEqual([0, 1]);
    expect(r.gaps).toEqual([170, 150, 130]);
  });

  test('BOS-06 attacks never repeat back-to-back, and phase 3 sometimes chains a second, different attack', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.seed(5);
      const out = { repeats: 0, picks: 0, single: null, combo: 0, comboTries: 400, comboDiffers: 0, comboWaits: 0 };
      const b = { lastAttack: '' };
      let prev = null;
      for (let i = 0; i < 600; i++) { const p = raidPickAttack(b, ['a', 'b', 'c']); if (p === prev) out.repeats++; prev = p; out.picks++; }
      out.single = raidPickAttack({ lastAttack: 'only' }, ['only']);

      // combo chance (30%) measured over many triggered attacks
      for (let i = 0; i < out.comboTries; i++) {
        T.prepBoss('grinmaw', 3); raidG.boss.attackTimer = 1;
        raidBossUpdate();
        if (raidG.boss.comboPending) out.combo++;
      }
      // a pending combo fires a different attack after 60 idle frames (never sooner)
      T.prepBoss('warden', 3); T.recordAttacks();
      raidG.boss.comboPending = true; raidG.boss.comboTimer = 60; raidG.boss.lastAttack = 'lash';
      T.step(59); out.comboWaits = T.attackLog.length;
      T.step(1);
      out.comboFired = T.attackLog.length;
      out.comboDiffers = raidG.boss.lastAttack !== 'lash' ? 1 : 0;
      return out;
    });
    expect(r.repeats).toBe(0);
    expect(r.single).toBe('only');
    expect(r.combo / r.comboTries).toBeGreaterThan(0.2);
    expect(r.combo / r.comboTries).toBeLessThan(0.4);
    expect(r.comboWaits).toBe(0);
    expect(r.comboFired).toBe(1);
    expect(r.comboDiffers).toBe(1);
  });

  test('BOS-07 no tiny dot shots any more: aimed shots (candy, void) are slow, and the lobbed ones (fireballs, bubbles, rubble, boulders) are big, follow a short visible arc and are parryable', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = { aimedMax: 0, aimedSeen: new Set(), small: [], lobbed: [] };
      for (const boss of BOSS_ORDER) {
        T.seed(9);
        const sim = T.simulate(boss, 3, 3600);
        sim.spawns.forEach((p) => {
          if (p.r < RAID_PARRY_MIN_R && p.kind !== 'void') out.small.push(boss + ':' + p.kind);
          if (!p.gravity) { out.aimedMax = Math.max(out.aimedMax, Math.hypot(p.vx || 0, p.vy || 0)); out.aimedSeen.add(boss + ':' + p.kind); }
          else out.lobbed.push({ kind: p.kind, life: p.life, lands: p.onLand || 'pops' });
        });
      }
      out.aimedSeen = [...out.aimedSeen].sort();
      out.lobbedKinds = [...new Set(out.lobbed.map((l) => l.kind))].sort();
      out.lobbedMaxLife = Math.max(...out.lobbed.map((l) => l.life));
      out.lobbedLands = [...new Set(out.lobbed.map((l) => l.kind + ':' + l.lands))].sort();
      out.small = [...new Set(out.small)];
      delete out.lobbed;
      return out;
    });
    expect(r.small, 'the tiny dot shots (fangs, pods, plumes, small feathers, bolts) are gone').toEqual([]);
    expect(r.aimedSeen).toEqual(['grinmaw:candy', 'warden:void']);
    expect(r.aimedMax).toBeLessThanOrEqual(3.2);
    expect(r.lobbedKinds).toEqual(['boulder', 'bubble', 'ember', 'quill', 'rubble']);
    expect(r.lobbedMaxLife, 'a lob is airborne for at most ~1.6 s').toBeLessThanOrEqual(110);
    expect(r.lobbedLands).toEqual(['boulder:boulder', 'bubble:bubble', 'ember:pillar', 'quill:pops', 'rubble:rubble']);
  });

  test('BOS-08 phases at 60% and 30% HP: a 100-frame invulnerable beat that clears the arena and unlocks attacks', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('warden');
      const out = {};
      // thresholds
      const phaseAt = (pct) => { T.prepBoss('warden', 1); raidG.boss.lastPhase = 9; raidG.boss.hp = raidG.boss.maxHp * pct; T.step(1); return raidG.boss.phase; };
      out.phases = [phaseAt(1), phaseAt(0.6), phaseAt(0.59), phaseAt(0.3), phaseAt(0.29)];

      // the transition beat
      T.prepBoss('warden', 1);
      raidG.projectiles = [{ x: 10, y: 10, vx: 0, vy: 0, r: 5, life: 50, isBossProjectile: true, isWarning: false, owner: 'x' }];
      raidHazard({ kind: 'pillar', x: 10, life: 60 });
      raidG.boss.hp = raidG.boss.maxHp * 0.5;
      T.step(1);
      out.transition = raidG.boss.transition; out.transitionPhase = raidG.boss.transitionPhase;
      out.cleared = [raidG.projectiles.length, raidG.hazards.length];
      out.attackTimerAfter = raidG.boss.attackTimer >= 149;
      // shots during the beat are blocked
      const hp0 = raidG.boss.hp;
      raidG.playerProjectiles = [{ x: raidG.boss.x, y: raidG.boss.y, vx: 0, vy: 0, life: 50, damage: 3, r: 6 }];
      T.step(1);
      out.blocked = raidG.boss.hp === hp0;
      // the banner is drawn
      const seen = []; const real = raidCtx.fillText.bind(raidCtx);
      raidCtx.fillText = (t, ...a) => { seen.push(String(t)); return real(t, ...a); };
      raidDraw(); raidCtx.fillText = real;
      out.banner = seen.some((t) => t === 'PHASE 2');
      out.noAttackDuring = (() => { T.recordAttacks(); raidG.boss.attackTimer = 1; T.step(50); return T.attackLog.length; })();
      T.step(60);
      out.transitionEnded = raidG.boss.transition;
      // the boss may have started a (random) attack by now - park it so the shot below is not aimed at a faded boss
      raidG.boss.anim = { state: 'idle', timer: 0 }; raidG.boss.attackTimer = 99999; raidG.boss.animAlpha = 1;
      // and afterwards shots hurt again
      const hp1 = raidG.boss.hp;
      raidG.playerProjectiles = [{ x: raidG.boss.x, y: raidG.boss.y, vx: 0, vy: 0, life: 50, damage: 3, r: 6 }];
      T.step(1);
      out.hurtAgain = hp1 - raidG.boss.hp;

      // waits for the current attack animation to finish before starting the beat
      T.prepBoss('grinmaw', 1); raidG.boss.anim = { state: 'windup', timer: 0 }; raidG.boss.hp = raidG.boss.maxHp * 0.5;
      T.step(5); out.deferred = raidG.boss.transition;
      T.until(() => raidG.boss.transition > 0, 200); out.startsAfterAnim = raidG.boss.transition > 0;
      return out;
    });
    expect(r.phases).toEqual([1, 1, 2, 2, 3]);
    expect(r.transition).toBeGreaterThanOrEqual(98);
    expect(r.transitionPhase).toBe(2);
    expect(r.cleared).toEqual([0, 0]);
    expect(r.attackTimerAfter).toBe(true);
    expect(r.blocked).toBe(true);
    expect(r.banner).toBe(true);
    expect(r.noAttackDuring).toBe(0);
    expect(r.transitionEnded).toBe(0);
    expect(r.hurtAgain).toBe(3);
    expect(r.deferred).toBe(0);
    expect(r.startsAfterAnim).toBe(true);
  });

  test('BOS-08 each boss unlocks new attacks only from phase 2', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const collect = (boss, phase) => {
        T.seed(2);
        const seen = new Set();
        for (let i = 0; i < 300; i++) {
          T.prepBoss(boss, phase);
          const b = raidG.boss;
          BOSS_ATTACK_FNS[boss](b);
          seen.add(b.anim.state + (b.anim.kind ? ':' + b.anim.kind : '') + (b.anim.extra ? ':twin' : ''));
        }
        return [...seen].sort();
      };
      const out = {};
      for (const boss of ['grinmaw', 'warden', 'wyrm', 'glutton']) out[boss] = { p1: collect(boss, 1), p2: collect(boss, 2) };
      return out;
    });
    const only2 = (b) => r[b].p2.filter((s) => !r[b].p1.includes(s));
    expect(only2('grinmaw')).toEqual(['summon']);
    expect(only2('warden')).toEqual(['cast']);
    expect(only2('wyrm')).toEqual(['aim']);
    expect(only2('glutton')).toEqual(['inflate:fan', 'sink:twin']);
    expect(r.grinmaw.p1).toEqual(['spit', 'windup', 'withdraw']);
  });

  test('BOS-09 a faded or submerged boss cannot be hit; shots pass through', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('warden');
      const hitFor = (boss, state) => {
        T.prepBoss(boss, 1);
        const b = raidG.boss;
        b.anim = { state, timer: 1, homeX: 500, homeY: 90, targetX: 500, targetY: 400, startX: 500, startY: 90 };
        b.x = 500; b.y = 400;
        const hp0 = b.hp;
        raidG.playerProjectiles = [{ x: 500, y: 400, vx: 0, vy: 0, life: 50, damage: 3, r: 6 }];
        raidBossUpdate();
        return { hit: hp0 - raidG.boss.hp, kept: raidG.playerProjectiles.length };
      };
      const out = {};
      for (const s of ['fade', 'ghost', 'materialize']) out['warden_' + s] = hitFor('warden', s);
      for (const s of ['sink', 'swim', 'rise']) out['glutton_' + s] = hitFor('glutton', s);
      out.idle = (() => { T.prepBoss('glutton', 1); const b = raidG.boss; const hp0 = b.hp; b.x = 500; b.y = BOSS_HOVER_Y.glutton; raidG.playerProjectiles = [{ x: 500, y: BOSS_HOVER_Y.glutton, vx: 0, vy: 0, life: 50, damage: 3, r: 6 }]; raidBossUpdate(); return { hit: hp0 - raidG.boss.hp }; })();
      out.helper = ['grinmaw', 'wyrm', 'bramblehide', 'colossus', 'griffon'].map((t) => { T.prepBoss(t, 1); raidG.boss.anim.state = 'dive'; return raidBossUntargetable(raidG.boss); });
      return out;
    });
    ['warden_fade', 'warden_ghost', 'warden_materialize', 'glutton_sink', 'glutton_swim', 'glutton_rise'].forEach((k) => {
      expect(r[k], k).toEqual({ hit: 0, kept: 1 });
    });
    expect(r.idle.hit).toBe(3);
    expect(r.helper).toEqual([false, false, false, false, false]);
  });

  test('BOS-10 each boss has its own animations and they are published so every client sees them', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (const boss of BOSS_ORDER) {
        T.seed(4);
        out[boss] = T.simulate(boss, 3, 4000).states.filter((s) => s !== 'idle').sort();
      }
      // the animation and the transform values are part of the synced boss object
      T.prepBoss('glutton', 1); raidG.boss.anim = { state: 'swim', timer: 5, targetX: 300, homeX: 500, homeY: 95 }; raidG.boss.animScale = 0.45; raidG.boss.animAlpha = 0.2;
      raidSendBossState();
      const synced = __fb.db.get('bossRaid/9001/gameState/boss');
      out.synced = { state: synced.anim.state, scale: synced.animScale, alpha: synced.animAlpha };
      return out;
    });
    const exclusive = (b, states) => states.every((s) => r[b].includes(s) && !BOSSES.filter((o) => o !== b).some((o) => r[o].includes(s)));
    expect(exclusive('grinmaw', ['windup', 'slam', 'spit', 'withdraw', 'hurl', 'advance', 'summon'])).toBe(true);
    expect(exclusive('warden', ['ghost', 'materialize', 'raise', 'cast', 'strike', 'fade', 'return'])).toBe(true);
    expect(exclusive('wyrm', ['aim', 'dive', 'coil', 'lunge', 'hold', 'climb', 'sweepAim', 'sweepPass', 'sweepOut'])).toBe(true);
    expect(exclusive('glutton', ['sink', 'swim', 'rise', 'bite', 'inflate', 'deflate', 'retreat'])).toBe(true);
    expect(r.synced).toEqual({ state: 'swim', scale: 0.45, alpha: 0.2 });
  });

  test('BOS-11 after its big move each boss is stunned for 120 frames and takes double damage', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = { const: BOSS_STUN_FRAMES };
      const shotDamage = () => {
        const b = raidG.boss; const hp0 = b.hp;
        raidG.playerProjectiles = [{ x: b.x, y: b.y, vx: 0, vy: 0, life: 50, damage: 3, r: 6 }];
        T.step(1);
        return hp0 - raidG.boss.hp;
      };
      const measure = (boss, start, stunState) => {
        T.prepBoss(boss, 1); T.place(500);
        start();
        const startedAt = T.until(() => raidG.boss.anim.state === stunState, 1200);
        const exposedAtEntry = raidG.boss.exposed;
        const dmgStunned = shotDamage();
        let frames = 1; // the frame above already ran inside the stun
        while (raidG.boss.anim.state === stunState && frames < 400) { T.step(1); frames++; }
        raidG.boss.exposed = 0;
        const dmgNormal = shotDamage();
        return { reached: startedAt > 0, exposedAtEntry, dmgStunned, dmgNormal, frames };
      };
      out.grinmaw = measure('grinmaw', () => { raidG.boss.anim = { state: 'windup', timer: 0 }; }, 'dazed');
      out.warden = measure('warden', () => wardenStartVanish(raidG.boss), 'dazed');
      out.wyrm = measure('wyrm', () => wyrmDiveBomb(raidG.boss), 'crash');
      out.glutton = measure('glutton', () => gluttonStartChomp(raidG.boss), 'dazed');
      out.bramblehide = measure('bramblehide', () => { raidG.boss.anim = { state: 'chargeWindup', timer: 0, dir: 1 }; }, 'dazed');
      out.colossus = measure('colossus', () => { raidG.boss.anim = { state: 'slamWindup', timer: 0 }; }, 'dazed');
      out.griffon = measure('griffon', () => griffonWindDive(raidG.boss), 'thud');
      return out;
    });
    expect(r.const).toBe(120);
    for (const b of BOSSES) {
      expect(r[b].reached, b).toBe(true);
      expect(r[b].exposedAtEntry, b + ' stun length').toBeGreaterThanOrEqual(119); // counts down on the frame it starts
      expect(r[b].exposedAtEntry, b + ' stun length').toBeLessThanOrEqual(120);
      expect(r[b].dmgStunned, b + ' damage while stunned').toBe(6);
      expect(r[b].dmgNormal, b + ' normal damage').toBe(3);
      expect(r[b].frames, b + ' frames spent stunned').toBeGreaterThanOrEqual(118);
      expect(r[b].frames, b + ' frames spent stunned').toBeLessThanOrEqual(122);
    }
  });

  test('BOS-12 a stunned boss looks dazed (tilt, sag, dizzy stars) and nothing says it is weak', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('glutton');
      const starPixels = (exposed) => {
        const c = document.createElement('canvas'); c.width = 1000; c.height = 600;
        const ctx = c.getContext('2d');
        const boss = Object.assign({}, raidG.boss, { type: 'glutton', x: 500, y: 300, w: 120, h: 80, exposed, animScale: 1, animAlpha: 1 });
        drawBossDispatch(ctx, boss);
        const d = ctx.getImageData(400, 200, 200, 150).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] > 200 && d[i + 1] < 245 && d[i + 2] < 110 && d[i + 3] > 200) n++; // the stars' yellow
        return n;
      };
      const out = { calm: starPixels(0), dazed: starPixels(60) };
      // no text of any kind announces vulnerability, in any boss state
      const seen = [];
      const f1 = raidCtx.fillText.bind(raidCtx), f2 = raidCtx.strokeText.bind(raidCtx);
      raidCtx.fillText = (t, ...a) => { seen.push(String(t)); return f1(t, ...a); };
      raidCtx.strokeText = (t, ...a) => { seen.push(String(t)); return f2(t, ...a); };
      for (const boss of BOSS_ORDER) {
        T.prepBoss(boss, 1); raidG.boss.exposed = 100; raidDraw();
      }
      raidCtx.fillText = f1; raidCtx.strokeText = f2;
      out.texts = seen.join('|');
      return out;
    });
    expect(r.dazed - r.calm).toBeGreaterThan(30);
    expect(r.texts).not.toMatch(/expos|weak|vulnerab|stun|dazed|2x|x2/i);
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
    expect(html).not.toMatch(/EXPOSED|x2 DAMAGE/);
  });

  test('BOS-13 feedback: screen shake, damage numbers, hurt flash and phase notches on the HP bar', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      const out = {};
      raidFx.lastBossHp = null; raidFx.lastHealth = null; raidFx.shake = 0; raidFx.floaters = []; raidFx.hurtFlash = 0; raidFx.lastTransition = 0;
      raidG.boss.hp = 100; raidLocal.health = 5; raidFxTick();
      raidG.boss.hp = 97; raidFxTick();
      out.small = { text: raidFx.floaters[0].text, big: raidFx.floaters[0].big, shake: raidFx.shake > 0 };
      raidFx.shake = 0; raidG.boss.hp = 91; raidFxTick();
      out.big = { text: raidFx.floaters[1].text, big: raidFx.floaters[1].big, shake: Math.round(raidFx.shake) };
      raidFx.shake = 0; raidLocal.health = 4; raidFxTick();
      out.hurt = { flash: raidFx.hurtFlash, shake: Math.round(raidFx.shake) };
      raidFx.shake = 0; raidG.boss.transition = 100; raidFxTick();
      out.phaseShake = Math.round(raidFx.shake);
      // notches at 60% and 30% of the 700px bar (x = 150 + 700 * pct)
      const xs = []; const mv = raidCtx.moveTo.bind(raidCtx);
      raidCtx.moveTo = (x, y) => { xs.push(Math.round(x)); return mv(x, y); };
      raidDraw(); raidCtx.moveTo = mv;
      out.notches = [570, 360].map((x) => xs.includes(x));
      return out;
    });
    expect(r.small).toEqual({ text: '-3', big: false, shake: true });
    expect(r.big.text).toBe('-6');
    expect(r.big.big).toBe(true);
    expect(r.big.shake, 'a big hit shakes harder than a small one').toBeGreaterThanOrEqual(6);
    expect(r.hurt.flash, 'the red flash fades over about 14 frames').toBeGreaterThanOrEqual(12);
    expect(r.hurt.shake, 'being hit shakes the screen hard').toBeGreaterThanOrEqual(9);
    expect(r.phaseShake, 'a phase change is the biggest shake').toBeGreaterThanOrEqual(18);
    expect(r.notches).toEqual([true, true]);
  });

  test('BOS-13 every hit (not just the stun) briefly shows the hurt pose, a white flash and a hit-stop', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      // raidBossUpdate() -> raidSendBossState() loops back through this host's own
      // raidListenToGame listener and replaces raidG.boss with a fresh clone - so re-read
      // raidG.boss after every call instead of holding one reference across several.
      let b = raidG.boss;
      b.exposed = 0; b.transition = 0; b.invulnerable = false; b.hitFlash = 0;
      raidHitStopTimer = 0;
      raidG.playerProjectiles = [{ x: b.x, y: b.y, vx: 0, vy: 0, life: 50, damage: 3, r: 6 }];
      const hp0 = b.hp;
      raidBossUpdate();
      b = raidG.boss;
      const out = {};
      out.damaged = hp0 - b.hp;
      out.hitFlash = b.hitFlash;
      out.notExposed = b.exposed === 0; // this is a plain hit, not the big phase-transition/stun window
      out.poseIsHurt = bossSpriteFrame(b);
      out.hitStopSet = raidHitStopTimer > 0;

      // The white flash overlay itself, isolated from the "hurt" pose swap it usually comes
      // with: hold the pose fixed (exposed - already shown to give "hurt" on its own) and only
      // toggle hitFlash, averaged over a small patch so one already-bright pixel can't decide it.
      const brightnessAt = (bossX, bossY) => {
        const d = raidCtx.getImageData(Math.round(bossX) - 3, Math.round(bossY) - 3, 6, 6).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
        return sum;
      };
      b.exposed = 50;
      b.hitFlash = 0; raidDraw();
      const before = brightnessAt(b.x, b.y);
      b.hitFlash = 10; raidDraw();
      const after = brightnessAt(b.x, b.y);
      out.flashBrighter = after > before;
      b.exposed = 0;

      // the flash and the reaction pose both fade out again on their own
      for (let i = 0; i < 10; i++) { raidBossUpdate(); b = raidG.boss; }
      out.flashGone = b.hitFlash;
      out.poseBackToIdle = bossSpriteFrame(b).startsWith('idle');

      // hit-stop actually freezes the loop (frame counter, local update and boss sim all pause)
      raidLoopRunning = true; raidHitStopTimer = 3;
      const f0 = raidG.frame;
      raidGameLoop();
      out.frozenFrame = raidG.frame === f0;
      out.hitStopCountedDown = raidHitStopTimer === 2;
      raidLoopRunning = false;
      return out;
    });
    expect(r.damaged).toBe(3);
    expect(r.hitFlash).toBe(10);
    expect(r.notExposed).toBe(true);
    expect(r.poseIsHurt).toBe('hurt');
    expect(r.hitStopSet).toBe(true);
    expect(r.flashBrighter).toBe(true);
    expect(r.flashGone).toBe(0);
    expect(r.poseBackToIdle).toBe(true);
    expect(r.frozenFrame).toBe(true);
    expect(r.hitStopCountedDown).toBe(true);
  });

  test('BOS-14 the boss HP bar is big and fixed at the top - it does not follow the boss', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const barRect = (bossX, bossY, hpPct) => {
        T.prepBoss('grinmaw', 1);
        raidG.boss.x = bossX; raidG.boss.y = bossY; raidG.boss.hp = raidG.boss.maxHp * hpPct;
        const rects = []; const fr = raidCtx.fillRect.bind(raidCtx);
        raidCtx.fillRect = (x, y, w, h) => { if (h === 28) rects.push([x, y, Math.round(w)]); return fr(x, y, w, h); };
        raidDraw(); raidCtx.fillRect = fr;
        return rects.filter((q) => q[1] === 20);
      };
      return { left: barRect(150, 400, 1), right: barRect(850, 90, 1), half: barRect(500, 200, 0.5) };
    });
    expect(r.left).toEqual(r.right);
    expect(r.left[r.left.length - 1]).toEqual([150, 20, 700]);
    expect(r.half[r.half.length - 1]).toEqual([150, 20, 350]);
  });
});
