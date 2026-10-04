// Spec 9.2: each boss's attacks, wind-ups and timings. Frame counts are read from the running game.
const { test, expect } = require('./support/fixtures');

// Page-side helper, evaluated in each test: records [state, frames] runs of the boss animation.
const RUNS = `
  window.runs = (max, stop) => {
    const out = []; let cur = null;
    for (let i = 0; i < max; i++) {
      T.step(1);
      const s = raidG.boss.anim.state;
      if (!cur || cur[0] !== s) { cur = [s, 0]; out.push(cur); }
      cur[1]++;
      if (stop && stop()) break;
    }
    return out;
  };
`;

// Run lengths are measured on the frame a state is *observed*, so allow one frame either way.
const near = (value, expected, tol = 1) => {
  expect(value).toBeGreaterThanOrEqual(expected - tol);
  expect(value).toBeLessThanOrEqual(expected + tol);
};

async function setup(page, boss) {
  await page.evaluate((b) => T.setupRaid(b), boss);
  await page.evaluate(RUNS);
}

test.describe('Grinmaw the Enthroned (BOS-20)', () => {
  test('BOS-20 bombardment: Grinmaw retreats into the background (40), hurls rubble at every player from there in waves, then comes forward (45) and slams; he cannot be hit while far away', async ({ page }) => {
    await setup(page, 'grinmaw');
    const r = await page.evaluate(() => {
      T.prepBoss('grinmaw', 1); T.place(300);
      raidPlayerRef.child('p2').set(Object.assign({}, T.me(), { x: 700 - 18 })); // a second player, kept in the shared player list
      raidG.boss.anim = { state: 'withdraw', timer: 0, homeX: raidG.boss.x, homeY: raidG.boss.y, waves: [20, 100] };
      const out = { thrown: [], waves: [] };
      const seq = []; let cur = null, farHits = 0, nearScale = null, minScale = 9, untargetableWhileFar = true, lastCount = 0;
      for (let f = 0; f < 420; f++) {
        T.step(1);
        const a = raidG.boss.anim;
        if (!cur || cur[0] !== a.state) { cur = [a.state, 0]; seq.push(cur); }
        cur[1]++;
        if (a.state === 'hurl') {
          minScale = Math.min(minScale, raidG.boss.animScale);
          if (!raidBossUntargetable(raidG.boss)) untargetableWhileFar = false;
          const rocks = raidG.projectiles.filter((p) => p.kind === 'rubble');
          if (rocks.length > lastCount) { out.waves.push({ frame: cur[1], n: rocks.length - lastCount }); rocks.slice(lastCount).forEach((p) => out.thrown.push({ onLand: p.onLand, r: p.r, up: p.vy < 0, life: p.life, landX: Math.round(raidProjectileLandingX(p)), fromBoss: Math.hypot(p.x - raidG.boss.x, p.y - raidG.boss.y) < 60 })); }
          lastCount = rocks.length;
        }
        if (a.state === 'slam') break;
      }
      out.seq = seq.map((q) => q[0]); out.lens = seq.map((q) => q[1]);
      out.minScale = minScale; out.untargetableWhileFar = untargetableWhileFar;
      out.terrain = raidG.terrain.length; // rubble bursts, it does not leave anything behind
      out.dazedTargetable = (() => { raidG.boss.anim = { state: 'dazed', timer: 0 }; raidG.boss.animScale = 1; return !raidBossUntargetable(raidG.boss); })();
      return out;
    });
    expect(r.seq).toEqual(['withdraw', 'hurl', 'advance', 'slam']);
    near(r.lens[0], 40);
    near(r.lens[1], 100 + 50);
    near(r.lens[2], 45);
    expect(r.waves.map((w) => w.frame), 'two waves, 80 frames apart (counted from the frame he starts throwing)').toEqual([21, 101]);
    expect(r.waves.map((w) => w.n), 'one rubble per player each wave').toEqual([2, 2]);
    r.thrown.forEach((t) => {
      expect(t.onLand).toBe('rubble');
      expect(t.r, 'big enough to parry').toBeGreaterThanOrEqual(11);
      expect(t.up, 'thrown up and over').toBe(true);
      expect(t.life, 'about a second in the air').toBeLessThanOrEqual(110);
      expect(t.fromBoss, 'from the boss').toBe(true);
    });
    expect(r.thrown.filter((t) => Math.abs(t.landX - 300) < 90).length, 'half of each wave comes down near the first player').toBe(2);
    expect(r.thrown.filter((t) => Math.abs(t.landX - 700) < 90).length).toBe(2);
    expect(r.minScale, 'drawn small, as if far in the background').toBeLessThan(0.7);
    expect(r.untargetableWhileFar).toBe(true);
    expect(r.terrain, 'rubble bursts where it lands but changes nothing on the floor').toBe(0);
    expect(r.dazedTargetable, 'and hittable again once he has come forward').toBe(true);
  });

  test('BOS-20 bombardment is picked from idle, runs 3 waves from phase 2, and ends in the slam and a stun', async ({ page }) => {
    await setup(page, 'grinmaw');
    const r = await page.evaluate(() => {
      const wavesFor = (phase) => { T.prepBoss('grinmaw', phase); for (let i = 0; i < 200; i++) { T.prepBoss('grinmaw', phase); BOSS_ATTACK_FNS.grinmaw(raidG.boss); if (raidG.boss.anim.state === 'withdraw') return raidG.boss.anim.waves.slice(); } return null; };
      const out = { p1: wavesFor(1), p2: wavesFor(2) };
      T.prepBoss('grinmaw', 1); T.place(900);
      raidG.boss.anim = { state: 'withdraw', timer: 0, homeX: raidG.boss.x, homeY: raidG.boss.y, waves: [20, 100] };
      T.until(() => raidG.boss.anim.state === 'dazed', 500);
      out.stunned = raidG.boss.exposed; out.shock = raidG.hazards.filter((h) => h.kind === 'shockwave').length;
      return out;
    });
    expect(r.p1).toEqual([20, 100]);
    expect(r.p2, 'a third wave from phase 2').toEqual([20, 90, 160]);
    expect(r.stunned).toBeGreaterThanOrEqual(119);
    expect(r.shock).toBe(2);
  });

  test('BOS-20 throne slam: rises 60 frames, slams, sends two floor shockwaves, then is stunned; jumping clears them', async ({ page }) => {
    await setup(page, 'grinmaw');
    const r = await page.evaluate(() => {
      T.prepBoss('grinmaw', 1); T.place(300);
      raidG.boss.anim = { state: 'windup', timer: 0 };
      const seq = runs(120, () => raidG.hazards.length > 0);
      const waves = raidG.hazards.filter((h) => h.kind === 'shockwave').map((h) => ({ dir: h.dir, speed: Math.round(h.speed * 100) / 100, atBoss: Math.abs(h.x - raidG.boss.x) < 5 }));
      const rise = (() => { T.prepBoss('grinmaw', 1); raidG.boss.anim = { state: 'windup', timer: 0 }; T.step(40); return raidG.boss.animOffsetY; })();
      const stunned = (() => { T.prepBoss('grinmaw', 1); T.place(300); raidG.boss.anim = { state: 'windup', timer: 0 }; T.until(() => raidG.boss.anim.state === 'dazed', 200); return raidG.boss.exposed; })();
      // a wave rolling toward a player standing 150px to the right hurts a grounded player, not a jumping one
      const cross = (airborne) => {
        T.prepBoss('grinmaw', 1); raidLocal.health = 5;
        raidG.boss.x = 500; raidHazard({ kind: 'shockwave', x: 500, dir: 1, speed: 2.7, life: 300 });
        for (let i = 0; i < 90; i++) { T.place(650, airborne ? raidGROUND_Y - 48 - 90 : undefined, { health: raidLocal.health, invincible: 0 }); T.step(1); }
        return T.me().health;
      };
      // the slam does not change the floor
      const terrain = (() => { T.prepBoss('grinmaw', 1); T.place(900); raidG.boss.anim = { state: 'windup', timer: 0 }; T.until(() => raidG.boss.anim.state === 'dazed', 200); T.step(3); return raidG.terrain.length; })();
      return { seq, waves, rise, stunned, terrain, grounded: cross(false), jumping: cross(true) };
    });
    expect(r.seq.map((s) => s[0])).toEqual(['windup', 'slam', 'dazed']); // the stun starts as the waves are born
    near(r.seq[0][1], 60);
    near(r.seq[1][1], 5);
    expect(r.waves).toEqual([{ dir: -1, speed: 2.7, atBoss: true }, { dir: 1, speed: 2.7, atBoss: true }]);
    expect(r.rise, 'the boss rears up before the slam').toBeLessThan(-10);
    expect(r.stunned).toBeGreaterThanOrEqual(119);
    expect(r.terrain, 'the slam leaves the floor as it was').toBe(0);
    expect(r.grounded).toBeLessThan(5);
    expect(r.jumping).toBe(5);
  });

  test('BOS-20 minion summon (phase 2+): two imps are hurled from the hands, land, then scurry along the floor', async ({ page }) => {
    await setup(page, 'grinmaw');
    const r = await page.evaluate(() => {
      T.prepBoss('grinmaw', 2); T.place(500);
      raidG.boss.anim = { state: 'summon', timer: 0 };
      const frames = T.until(() => raidG.hazards.some((h) => h.kind === 'imp'), 100);
      const imps = raidG.hazards.filter((h) => h.kind === 'imp');
      const start = imps.map((h) => ({ dx: Math.round(h.x - raidG.boss.x), airborne: h.y < raidGROUND_Y - 40 - 20 })).sort((a, b) => a.dx - b.dx);
      T.step(70);
      const landed = raidG.hazards.filter((h) => h.kind === 'imp').map((h) => ({ y: h.y, vy: h.vy, speed: Math.abs(h.vx) }));
      return { frames, count: imps.length, start, landed };
    });
    expect(r.frames).toBe(30);
    expect(r.count).toBe(2);
    expect(Math.abs(r.start[0].dx + 30)).toBeLessThan(5);
    expect(Math.abs(r.start[1].dx - 30)).toBeLessThan(5);
    expect(r.start.every((s) => s.airborne)).toBe(true);
    expect(r.landed).toEqual([{ y: 460, vy: 0, speed: 1.5 }, { y: 460, vy: 0, speed: 1.5 }]);
  });
});

test.describe('The Chained Warden (BOS-21)', () => {
  test('BOS-21 chain lash: a marked floor spot, one chain (two from phase 2) that only lands after ~1 second', async ({ page }) => {
    await setup(page, 'warden');
    const r = await page.evaluate(() => {
      const out = {};
      for (const phase of [1, 2]) {
        T.prepBoss('warden', phase); T.place(400);
        wardenChainLash(raidG.boss);
        out['chains' + phase] = raidG.hazards.filter((h) => h.kind === 'chainLash').map((h) => ({ delay: h.delay, near: Math.abs(h.tx - 400) < 120 }));
      }
      // first damage: exactly when the chain lands (t = 62), and never to a jumping player
      const firstHit = (airborne) => {
        T.prepBoss('warden', 1); raidLocal.health = 5;
        raidG.boss.attackTimer = 99999;
        const b = raidG.boss;
        raidHazard({ kind: 'chainLash', tx: 400, ty: raidGROUND_Y - 6, delay: 0, life: 100 });
        for (let f = 1; f <= 100; f++) {
          T.place(400, airborne ? raidGROUND_Y - 48 - 90 : undefined, { health: raidLocal.health, invincible: 0 });
          T.step(1);
          if (T.me().health < 5) return f;
        }
        return -1;
      };
      out.hitGround = firstHit(false); out.hitAir = firstHit(true);
      return out;
    });
    expect(r.chains1).toEqual([{ delay: 0, near: true }]);
    expect(r.chains2.map((c) => c.delay)).toEqual([0, 30]);
    expect(r.hitGround).toBeGreaterThanOrEqual(60);
    expect(r.hitGround).toBeLessThanOrEqual(64);
    expect(r.hitAir).toBe(-1);
  });

  test('BOS-21 vanish strike: fades out (50), drifts unseen (40), materialises (45) on a floor spot, strikes, is stunned, returns', async ({ page }) => {
    await setup(page, 'warden');
    const r = await page.evaluate(() => {
      T.prepBoss('warden', 1); T.place(300);
      wardenStartVanish(raidG.boss);
      const target = raidG.boss.anim.targetX;
      const seq = runs(400, () => raidG.boss.anim.state === 'idle');
      const atStrike = (() => {
        T.prepBoss('warden', 1); T.place(300); wardenStartVanish(raidG.boss);
        T.until(() => raidG.boss.anim.state === 'strike', 300);
        return { x: Math.round(raidG.boss.x), y: Math.round(raidG.boss.y), alpha: raidG.boss.animAlpha };
      })();
      const alphaFading = (() => { T.prepBoss('warden', 1); T.place(300); wardenStartVanish(raidG.boss); T.step(25); return raidG.boss.animAlpha; })();
      const hitAt = (px) => {
        T.prepBoss('warden', 1); raidLocal.health = 5; T.place(300); wardenStartVanish(raidG.boss); raidG.boss.anim.targetX = 300;
        for (let f = 0; f < 200; f++) { T.place(px, undefined, { health: raidLocal.health, invincible: 0 }); T.step(1); if (raidG.boss.anim.state === 'dazed') break; }
        return T.me().health;
      };
      return { target, seq, atStrike, alphaFading, near: hitAt(300), far: hitAt(420) };
    });
    expect(r.target).toBe(300);
    expect(r.seq.map((s) => s[0])).toEqual(['fade', 'ghost', 'materialize', 'strike', 'dazed', 'return', 'idle']);
    const len = Object.fromEntries(r.seq.map((s) => [s[0], s[1]]));
    near(len.fade, 50);
    near(len.ghost, 40);
    near(len.materialize, 45);
    expect(len.strike).toBeGreaterThanOrEqual(9);
    expect(len.strike).toBeLessThanOrEqual(11);
    expect(len.dazed).toBeGreaterThanOrEqual(119);
    expect(len.dazed).toBeLessThanOrEqual(121);
    expect(len.return).toBeGreaterThanOrEqual(39);
    expect(r.atStrike).toEqual({ x: 300, y: 400, alpha: 1 });
    expect(r.alphaFading, 'slowly fading, not instantly').toBeGreaterThan(0.3);
    expect(r.alphaFading).toBeLessThan(0.7);
    expect(r.near).toBe(4);
    expect(r.far).toBe(5);
  });

  test('BOS-21 void orb (phase 2+): grows in the hands, is thrown, hovers 45 frames, then bursts into 8 slow shots', async ({ page }) => {
    await setup(page, 'warden');
    const r = await page.evaluate(() => {
      T.prepBoss('warden', 2); T.place(600);
      wardenVoidOrb(raidG.boss);
      const orb0 = raidG.hazards.find((h) => h.kind === 'voidOrb');
      const target = { tx: orb0.tx, ty: orb0.ty };
      T.step(20); const growing = raidG.hazards.find((h) => h.kind === 'voidOrb');
      const nearBoss = Math.hypot(growing.x - raidG.boss.x, growing.y - (raidG.boss.y + 30)) < 5;
      let hoverPos = null, frames = 0;
      for (let f = 1; f <= 200; f++) {
        T.step(1); frames++;
        const orb = raidG.hazards.find((h) => h.kind === 'voidOrb');
        if (f === 110 && orb) hoverPos = { x: Math.round(orb.x), y: Math.round(orb.y) };
        if (raidG.projectiles.some((p) => p.kind === 'void')) break;
      }
      const shots = raidG.projectiles.filter((p) => p.kind === 'void');
      const angles = shots.map((p) => Math.atan2(p.vy, p.vx)).sort((a, b) => a - b);
      const gaps = angles.slice(1).map((a, i) => a - angles[i]);
      return { target, nearBoss, hoverPos, frames: frames + 20, count: shots.length, speed: Math.hypot(shots[0].vx, shots[0].vy), gaps: gaps.map((g) => Math.round(g * 100) / 100), origin: { x: Math.round(shots[0].x), y: Math.round(shots[0].y) } };
    });
    expect(r.nearBoss).toBe(true);
    expect(r.hoverPos).toEqual({ x: r.target.tx, y: r.target.ty });
    expect(r.frames).toBe(135);
    expect(r.count).toBe(8);
    expect(r.speed).toBeCloseTo(2.4, 1);
    r.gaps.forEach((g) => expect(g).toBeCloseTo(Math.PI / 4, 1));
    // shots leave the orb (they have moved one frame of travel by the time we look)
    expect(Math.hypot(r.origin.x - r.target.tx, r.origin.y - r.target.ty)).toBeLessThan(4);
  });

});

test.describe('Trio, the Three-Headed Wyrm (BOS-22)', () => {
  test('BOS-22 flame jets: the body coils, then the heads take turns marking a spot near a player (2, or 3 from phase 2) where a jet of flame erupts; nothing is thrown', async ({ page }) => {
    await setup(page, 'wyrm');
    const r = await page.evaluate(() => {
      const out = {};
      T.prepBoss('wyrm', 1); T.place(500, 60); // parked up high so no jet can touch the player
      wyrmJets(raidG.boss);
      T.watch();
      const frames = []; let seen = 0;
      for (let f = 1; f <= 200; f++) { T.step(1); if (T.hazardSpawns.length > seen) { frames.push(f); seen = T.hazardSpawns.length; } }
      out.frames = frames;
      out.kinds = [...new Set(T.hazardSpawns.map((h) => h.kind))];
      out.projectiles = T.spawns.length;
      out.near = T.hazardSpawns.every((h) => Math.abs(h.x - 500) <= 80);
      out.terrain = raidG.terrain.length;
      T.prepBoss('wyrm', 2); T.place(500, 60); wyrmJets(raidG.boss); T.watch(); T.step(200);
      out.phase2 = T.hazardSpawns.length;
      // a jet is a marked strike: 32 frames of marker, then it hurts only standing players within 38 px
      const hit = (dx) => { T.prepBoss('wyrm', 1); raidLocal.health = 5; raidHazard({ kind: 'pillar', x: 500, life: 66 }); for (let i = 0; i < 70; i++) { T.place(500 + dx, undefined, { health: T.me().health, invincible: 0 }); T.step(1); } return T.me().health; };
      out.on = hit(0); out.beside = hit(120);
      return out;
    });
    expect(r.frames, 'one jet per head turn').toEqual([26, 60]);
    expect(r.kinds).toEqual(['pillar']);
    expect(r.projectiles, 'no projectiles').toBe(0);
    expect(r.near, 'each jet is marked near a player').toBe(true);
    expect(r.terrain, 'and changes nothing on the floor').toBe(0);
    expect(r.phase2).toBe(3);
    expect(r.on).toBeLessThan(5);
    expect(r.beside).toBe(5);
  });

  test('BOS-22 sweep: flies to one edge (50), then swoops across the whole map in a diving arc (110) that is dangerous where it comes low, and returns (45)', async ({ page }) => {
    await setup(page, 'wyrm');
    const r = await page.evaluate(() => {
      const run = (phase) => {
        T.prepBoss('wyrm', phase); T.place(500, 60);
        wyrmSweep(raidG.boss);
        T.watch();
        const a0 = raidG.boss.anim;
        const out = { dir: a0.dir, seq: [], ys: [], xs: [] };
        let cur = null;
        for (let f = 0; f < 260; f++) {
          T.step(1);
          const a = raidG.boss.anim;
          if (!cur || cur[0] !== a.state) { cur = [a.state, 0]; out.seq.push(cur); }
          cur[1]++;
          if (a.state === 'sweepPass') { out.xs.push(raidG.boss.x); out.ys.push(raidG.boss.y); }
          if (a.state === 'idle') break;
        }
        out.names = out.seq.map((q) => q[0]); out.lens = out.seq.map((q) => q[1]);
        out.spawns = T.spawns.length; out.terrain = raidG.terrain.length;
        return out;
      };
      // a grounded player in the low stretch is hit once; one who jumps, or who waits at the ends of the arena, is not
      const pass = (px, airborne) => {
        T.prepBoss('wyrm', 1); raidLocal.health = 5; wyrmSweep(raidG.boss); raidG.boss.anim.dir = 1; raidG.boss.anim.startX = 70; raidG.boss.anim.endX = 930;
        for (let f = 0; f < 260; f++) { T.place(px, airborne ? raidGROUND_Y - 48 - 90 : undefined, { health: T.me().health, invincible: 0 }); T.step(1); if (raidG.boss.anim.state === 'idle') break; }
        return T.me().health;
      };
      return { p1: run(1), p2: run(2), middle: pass(500, false), middleJump: pass(500, true), edge: pass(120, false), farEdge: pass(880, false) };
    });
    for (const k of ['p1', 'p2']) {
      expect(r[k].names).toEqual(['sweepAim', 'sweepPass', 'sweepOut', 'idle']);
      near(r[k].lens[0], 50);
      near(r[k].lens[1], 110);
      near(r[k].lens[2], 45);
      const xs = r[k].xs;
      expect(Math.abs(xs[xs.length - 1] - xs[0]), 'crosses the whole map').toBeGreaterThan(700);
      expect(Math.sign(xs[xs.length - 1] - xs[0])).toBe(r[k].dir);
      expect(Math.max(...r[k].ys) - r[k].ys[0], 'dips low in the middle of the pass').toBeGreaterThan(150);
      expect(r[k].spawns, 'it drops nothing').toBe(0);
      expect(r[k].terrain).toBe(0);
    }
    expect(r.middle, 'caught in the low stretch').toBeLessThan(5);
    expect(r.middleJump, 'a jump clears it').toBe(5);
    expect(r.edge, 'the ends of the arena are safe').toBe(5);
    expect(r.farEdge).toBe(5);
  });

  test('BOS-22 dive bomb (phase 2+): flies over the target (45), dives (26), crashes and is stunned, then climbs back', async ({ page }) => {
    await setup(page, 'wyrm');
    const r = await page.evaluate(() => {
      T.prepBoss('wyrm', 2); T.place(700);
      wyrmDiveBomb(raidG.boss);
      const target = raidG.boss.anim.targetX;
      const seq = runs(400, () => raidG.boss.anim.state === 'idle');
      const hitAt = (px) => {
        T.prepBoss('wyrm', 2); raidLocal.health = 5; T.place(700); wyrmDiveBomb(raidG.boss);
        for (let f = 0; f < 200; f++) { T.place(px, undefined, { health: raidLocal.health, invincible: 0 }); T.step(1); if (raidG.boss.anim.state === 'crash') break; }
        return T.me().health;
      };
      const crashPos = (() => { T.prepBoss('wyrm', 2); T.place(700); wyrmDiveBomb(raidG.boss); T.until(() => raidG.boss.anim.state === 'crash', 200); return { x: Math.round(raidG.boss.x), y: Math.round(raidG.boss.y) }; })();
      return { target, seq, near: hitAt(700), far: hitAt(500), crashPos };
    });
    expect(r.target).toBe(700);
    expect(r.seq.map((s) => s[0])).toEqual(['aim', 'dive', 'crash', 'climb', 'idle']);
    const len = Object.fromEntries(r.seq.map((s) => [s[0], s[1]]));
    near(len.aim, 45);
    near(len.dive, 26);
    expect(len.crash).toBeGreaterThanOrEqual(119);
    expect(len.crash).toBeLessThanOrEqual(121);
    expect(len.climb).toBeGreaterThanOrEqual(49);
    expect(r.near).toBe(4);
    expect(r.far).toBe(5);
    expect(r.crashPos).toEqual({ x: 700, y: 425 });
  });
});

test.describe('The Glutton (BOS-23)', () => {

  test('BOS-23 chomp: sinks and fades (48), swims as a shadow (52), rises on a marker (40), bites, is stunned, retreats', async ({ page }) => {
    await setup(page, 'glutton');
    const r = await page.evaluate(() => {
      T.prepBoss('glutton', 1); T.place(300);
      gluttonStartChomp(raidG.boss);
      const target = raidG.boss.anim.targetX;
      const seq = runs(500, () => raidG.boss.anim.state === 'idle');
      const fade = (() => {
        T.prepBoss('glutton', 1); T.place(300); gluttonStartChomp(raidG.boss);
        T.step(48); const sunk = { alpha: raidG.boss.animAlpha, scale: raidG.boss.animScale };
        T.step(52); const swum = { x: Math.round(raidG.boss.x), alpha: raidG.boss.animAlpha };
        T.step(40);
        return { sunk, swum, surfaced: { x: Math.round(raidG.boss.x), y: Math.round(raidG.boss.y), alpha: raidG.boss.animAlpha, scale: Math.round(raidG.boss.animScale * 100) / 100 } };
      })();
      const bite = (px) => {
        T.prepBoss('glutton', 1); raidLocal.health = 5; T.place(300); gluttonStartChomp(raidG.boss);
        for (let f = 0; f < 300; f++) { T.place(px, undefined, { health: raidLocal.health, invincible: 0 }); T.step(1); if (raidG.boss.anim.state === 'dazed') break; }
        return T.me().health;
      };
      const biteMud = (() => { T.prepBoss('glutton', 1); T.place(960); gluttonStartChomp(raidG.boss); raidG.boss.anim.targetX = 300; T.step(160); return raidG.terrain.length; })();
      return { biteMud, target, seq, fade, near: bite(300), aside: bite(400), jump: (() => { T.prepBoss('glutton', 1); raidLocal.health = 5; T.place(300); gluttonStartChomp(raidG.boss); for (let f = 0; f < 300; f++) { T.place(300, raidGROUND_Y - 48 - 90, { health: raidLocal.health, invincible: 0 }); T.step(1); if (raidG.boss.anim.state === 'dazed') break; } return T.me().health; })() };
    });
    expect(r.target).toBe(300);
    expect(r.seq.map((s) => s[0])).toEqual(['sink', 'swim', 'rise', 'bite', 'dazed', 'retreat', 'idle']);
    const len = Object.fromEntries(r.seq.map((s) => [s[0], s[1]]));
    near(len.sink, 48);
    near(len.swim, 52);
    near(len.rise, 40);
    near(len.bite, 12);
    expect(len.dazed).toBeGreaterThanOrEqual(119);
    expect(len.dazed).toBeLessThanOrEqual(121);
    expect(len.retreat).toBeGreaterThanOrEqual(47);
    expect(r.fade.sunk.alpha, 'faded almost out').toBeLessThan(0.3);
    expect(r.fade.sunk.scale, 'and shrunk into the background').toBeLessThan(0.5);
    expect(r.fade.swum.x, 'swam to the marked spot').toBe(300);
    expect(r.fade.surfaced.x).toBe(300);
    expect(r.fade.surfaced.alpha).toBe(1);
    expect(r.near, 'staying on the marker gets bitten').toBe(4);
    expect(r.aside, 'stepping 100px aside avoids the bite').toBe(5);
    expect(r.jump, 'jumping the bite works too').toBe(5);
    expect(r.biteMud, 'the bite changes nothing on the floor').toBe(0);
  });

  test('BOS-23 gulp: it drops to the floor (40), inhales (70) and drags everyone toward it, then clamps shut (bite) and is stunned; running away, a dash or a jump at the clamp beats it', async ({ page }) => {
    await setup(page, 'glutton');
    const r = await page.evaluate(() => {
      T.prepBoss('glutton', 1); T.place(900);
      gluttonGulp(raidG.boss);
      const seq = runs(500, () => raidG.boss.anim.state === 'idle');
      const bossX = (() => { T.prepBoss('glutton', 1); T.place(900); raidG.boss.x = 400; gluttonGulp(raidG.boss); T.until(() => raidG.boss.anim.state === 'inhale', 100); return Math.round(raidG.boss.x); })();
      // the pull itself: a player standing 250 px away drifts toward the boss during the inhale
      const pull = (() => {
        T.prepBoss('glutton', 1); T.place(750); raidG.boss.x = 500; gluttonGulp(raidG.boss);
        T.until(() => raidG.boss.anim.state === 'inhale', 100);
        const x0 = raidPx(raidLocal); for (let i = 0; i < 30; i++) { T.step(1, { local: true }); }
        return Math.round(x0 - raidPx(raidLocal));
      })();
      const lone = (() => { T.prepBoss('glutton', 1); T.place(750); raidG.boss.x = 500; gluttonGulp(raidG.boss); T.until(() => raidG.boss.anim.state === 'dazed', 400); return T.me().health; })();
      return { seq, bossX, pull, lone, terrain: raidG.terrain.length };
    });
    expect(r.seq.map((s) => s[0])).toEqual(['descend', 'inhale', 'bite', 'dazed', 'retreat', 'idle']);
    const len = Object.fromEntries(r.seq.map((s) => [s[0], s[1]]));
    near(len.descend, 40);
    near(len.inhale, 70);
    near(len.bite, 12);
    expect(len.dazed).toBeGreaterThanOrEqual(119);
    expect(r.bossX, 'it drops straight down where it is').toBe(400);
    expect(r.pull, 'the inhale drags a player toward it').toBeGreaterThan(40);
    expect(r.terrain).toBe(0);
  });

  test('BOS-23 twin chomp (phase 2+): two bites in a row at two different spots, stunned only after the second', async ({ page }) => {
    await setup(page, 'glutton');
    const r = await page.evaluate(() => {
      T.prepBoss('glutton', 2); T.place(300);
      raidPlayerRef.child('p2').set(Object.assign({}, T.me(), { x: 760 - 18 }));
      gluttonStartChomp(raidG.boss, 1);
      const bites = []; let lastState = '';
      for (let f = 0; f < 700; f++) {
        T.place(960, 60); raidPlayerRef.child('p2').update({ x: 960 - 18, y: 60 });
        T.step(1);
        const st = raidG.boss.anim.state;
        if (st === 'bite' && lastState !== 'bite') bites.push(Math.round(raidG.boss.x));
        lastState = st;
        if (st === 'idle') break;
      }
      const seen = (() => { T.seed(2); const set = new Set(); for (let i = 0; i < 300; i++) { T.prepBoss('glutton', 2); BOSS_ATTACK_FNS.glutton(raidG.boss); set.add(raidG.boss.anim.state + ':' + (raidG.boss.anim.extra || 0)); } return [...set].sort(); })();
      const seen1 = (() => { T.seed(2); const set = new Set(); for (let i = 0; i < 300; i++) { T.prepBoss('glutton', 1); BOSS_ATTACK_FNS.glutton(raidG.boss); set.add(raidG.boss.anim.state + ':' + (raidG.boss.anim.extra || 0)); } return [...set].sort(); })();
      return { bites, seen, seen1 };
    });
    expect(r.bites.length, 'two bites').toBe(2);
    expect(Math.abs(r.bites[1] - r.bites[0]), 'in different places').toBeGreaterThan(60);
    expect(r.seen1, 'phase 1: a single chomp or a gulp').toEqual(['descend:0', 'sink:0']);
    expect(r.seen, 'phase 2 adds the twin chomp').toEqual(['descend:0', 'sink:0', 'sink:1']);
  });

  test('BOS-23 feast: periodically clamps shut and is invulnerable for 80 frames after a warning; any attack ends it', async ({ page }) => {
    await setup(page, 'glutton');
    const r = await page.evaluate(() => {
      T.prepBoss('glutton', 1);
      const b = () => raidG.boss;
      b().feastCooldown = 30; b().invulnerable = false;
      T.step(6); const warning = b().feastWarning;
      T.until(() => b().invulnerable, 100);
      const clamped = { invulnerable: b().invulnerable, timer: b().feastTimer };
      const hp0 = b().hp;
      raidG.playerProjectiles = [{ x: b().x, y: b().y, vx: 0, vy: 0, life: 50, damage: 3, r: 6 }];
      T.step(1);
      const blocked = b().hp === hp0;
      const frames = T.until(() => !b().invulnerable, 200);
      // an attack starting mid-clamp cancels it, so the boss is never invulnerable through its own recovery
      T.prepBoss('glutton', 1); b().invulnerable = true; b().feastTimer = 50; b().feastCooldown = 0;
      gluttonAttack(b());
      return { warning, clamped, blocked, clampFrames: frames, cancelled: b().invulnerable === false };
    });
    expect(r.warning).toBe(true);
    expect(r.clamped.invulnerable).toBe(true);
    expect(r.clamped.timer).toBeGreaterThanOrEqual(78);
    expect(r.blocked).toBe(true);
    expect(r.clampFrames).toBeGreaterThanOrEqual(75);
    expect(r.clampFrames).toBeLessThanOrEqual(80);
    expect(r.cancelled).toBe(true);
  });
});

test.describe('Bramblehide the Ravenous (BOS-40)', () => {
  test('BOS-40 root spikes: a 26-frame windup, then a thicket of thorn markers (3, or 5 from phase 2) centred on every player, each wide and tall, with a full 60-frame warning', async ({ page }) => {
    await setup(page, 'bramblehide');
    const r = await page.evaluate(() => {
      T.prepBoss('bramblehide', 1); T.place(300);
      raidG.boss.anim = { state: 'rootWindup', timer: 0 };
      const frames = T.until(() => raidG.hazards.some((h) => h.kind === 'thornSpike'), 60);
      const spikes = raidG.hazards.filter((h) => h.kind === 'thornSpike');
      const xs = spikes.map((h) => Math.round(h.x)).sort((a, b) => a - b);
      const out = { frames, count: spikes.length, xs, atPlayer: spikes.some((h) => Math.abs(h.x - 300) < 5), warn: RAID_THORN_WARN, active: RAID_THORN_ACTIVE, life: spikes[0].life, half: RAID_THORN_HALF, height: RAID_THORN_HEIGHT };
      // phase 2: five
      T.prepBoss('bramblehide', 2); T.place(500); bramblehideRootSpikes(raidG.boss);
      out.phase2 = raidG.hazards.filter((h) => h.kind === 'thornSpike').length;
      // a gap between two thorns is a safe spot: standing in it for the whole attack costs nothing
      T.prepBoss('bramblehide', 1); raidLocal.health = 5; T.place(300); bramblehideRootSpikes(raidG.boss);
      for (let i = 0; i < 100; i++) { T.place(380, undefined, { invincible: 0, health: 5 }); T.step(1); }
      out.gapHealth = T.me().health;
      T.prepBoss('bramblehide', 1); T.place(300); bramblehideRootSpikes(raidG.boss);
      raidLocal.health = 5;
      // a player who never moves: first damage lands only after the whole warning
      let firstHit = -1;
      for (let i = 1; i <= 120 && firstHit < 0; i++) { T.step(1); if (T.me().health < 5) firstHit = i; }
      out.firstHit = firstHit;
      return out;
    });
    expect(r.frames).toBe(26);
    expect(r.count, 'three thorn clumps for one player').toBe(3);
    expect(r.xs[1] - r.xs[0], 'spaced out, with a gap to stand in').toBeGreaterThanOrEqual(2 * r.half + 40);
    expect(r.half, 'much wider than the old 38 px').toBeGreaterThanOrEqual(50);
    expect(r.height, 'and taller than the old 68 px').toBeGreaterThanOrEqual(100);
    expect(r.phase2, 'five from phase 2').toBe(5);
    expect(r.gapHealth, 'a player standing between two clumps is safe').toBe(5);
    expect(r.atPlayer).toBe(true);
    expect(r.warn, 'the thorn marker is shown for a full second before the strike').toBe(60);
    expect(r.active).toBe(28);
    expect(r.life, 'the hazard lives through its warning and its strike').toBeGreaterThanOrEqual(r.warn + r.active);
    expect(r.firstHit, 'no damage until the warning has run out').toBeGreaterThanOrEqual(r.warn - 2);
    expect(r.firstHit).toBeLessThanOrEqual(r.warn + 4);
  });

  test('BOS-40 a landed bramble pod gets the same long thorn warning, and walking out of the marker avoids the spikes', async ({ page }) => {
    await setup(page, 'bramblehide');
    const r = await page.evaluate(() => {
      T.prepBoss('bramblehide', 2); T.place(700);
      raidG.projectiles = [{ x: 300, y: raidGROUND_Y - 20, vx: 0, vy: 3, gravity: 0.1, r: 10, life: 50, isWarning: false, isBossProjectile: true, kind: 'pod', onLand: 'thornSpike' }];
      T.step(3);
      const spike = raidG.hazards.find((h) => h.kind === 'thornSpike');
      const out = { life: spike ? spike.life : 0 };
      // standing 60 px aside from the marker's centre for its whole life: untouched
      raidLocal.health = 5;
      for (let i = 0; i < 100; i++) { T.place(spike.x + 60, undefined, { invincible: 0, health: 5 }); T.step(1); }
      out.asideHealth = T.me().health;
      return out;
    });
    expect(r.life).toBeGreaterThanOrEqual(60 + 28 - 4);
    expect(r.asideHealth).toBe(5);
  });

  test('BOS-40 ram charge: a 45-frame lean with a marked lane, then a slower 36-frame dash across (about 12 px/frame at most); stunned after', async ({ page }) => {
    await setup(page, 'bramblehide');
    const r = await page.evaluate(() => {
      T.prepBoss('bramblehide', 1); T.place(700); // player to the right of the boss (x=500)
      const startX = raidG.boss.x;
      raidG.boss.anim = { state: 'chargeWindup', timer: 0, dir: raidNearestPlayerDir(raidG.boss) };
      let lastX = null, maxStep = 0, laneSet = false;
      const seq = runs(120, () => {
        const a = raidG.boss.anim;
        if (a.state === 'chargeWindup' && typeof a.targetX === 'number') laneSet = true;
        if (a.state === 'charging') { if (lastX !== null) maxStep = Math.max(maxStep, Math.abs(raidG.boss.x - lastX)); lastX = raidG.boss.x; }
        return a.state === 'dazed';
      });
      const movedToward = raidG.boss.x > startX + 100; // dashed rightward, toward the player
      return {
        seq: seq.map((s) => s[0]), lens: seq.map((s) => s[1]), movedToward, hit: T.me().health < 5, maxStep, laneSet,
        stunned: raidG.boss.exposed >= 119
      };
    });
    expect(r.seq).toEqual(['chargeWindup', 'charging', 'dazed']);
    near(r.lens[0], 45);
    near(r.lens[1], 36);
    expect(r.maxStep, 'the dash is slower than before (it used to cover 23 px/frame)').toBeLessThanOrEqual(12.5);
    expect(r.laneSet, 'the lane it will run along is fixed from the start of the windup').toBe(true);
    expect(r.movedToward, 'the boar\'s own x crosses the arena toward the player it started closest to').toBe(true);
    expect(r.hit, 'a stationary player in its path takes contact damage').toBe(true);
    expect(r.stunned).toBe(true);
  });

  test('BOS-40 ram charge: it changes nothing on the floor (no hedge, no leftovers)', async ({ page }) => {
    await setup(page, 'bramblehide');
    const r = await page.evaluate(() => {
      T.prepBoss('bramblehide', 1); T.place(960); // far away: not hit
      raidG.boss.anim = { state: 'chargeWindup', timer: 0, dir: 1 };
      runs(300, () => raidG.boss.anim.state === 'idle');
      return { terrain: raidG.terrain.length };
    });
    expect(r.terrain).toBe(0);
  });

  test('BOS-40 ram charge: skids to a stop and trots back to its home spot afterward', async ({ page }) => {
    await setup(page, 'bramblehide');
    const r = await page.evaluate(() => {
      T.prepBoss('bramblehide', 1); T.place(900); // out of the way, so it isn't stopped by a hit
      raidG.boss.anim = { state: 'chargeWindup', timer: 0, dir: raidNearestPlayerDir(raidG.boss) };
      // 45 windup + 36 charging + 120 dazed + 40 trot + 18 settle = 259 frames end to end.
      runs(300, () => raidG.boss.anim.state === 'idle');
      return { home: raidG.boss.anim.state === 'idle' && raidG.boss.x > 120 && raidG.boss.x < 880 };
    });
    expect(r.home, 'ends up back in the middle of the arena and idle, not stranded at the wall').toBe(true);
  });

  test('BOS-40 thorn wave (phase 2+): a 30-frame rear-up, then five thorn clumps are marked in a line toward the nearest player and erupt one after another', async ({ page }) => {
    await setup(page, 'bramblehide');
    const r = await page.evaluate(() => {
      T.prepBoss('bramblehide', 2); T.place(900); raidG.boss.x = 300;
      raidG.boss.anim = { state: 'waveWindup', timer: 0 };
      const frames = T.until(() => raidG.hazards.some((h) => h.kind === 'thornSpike'), 80);
      const spikes = raidG.hazards.filter((h) => h.kind === 'thornSpike');
      const out = { frames, count: spikes.length, xs: spikes.map((h) => Math.round(h.x)).sort((a, b) => a - b), delays: spikes.map((h) => h.delay).sort((a, b) => a - b), projectiles: raidG.projectiles.length };
      // the first marker is shown for the whole 60 frames; later ones erupt later still
      const strikeFrame = (dx) => { T.prepBoss('bramblehide', 2); raidLocal.health = 5; raidHazard({ kind: 'thornSpike', x: 500, delay: dx, life: dx + RAID_THORN_WARN + RAID_THORN_ACTIVE + 2 }); for (let i = 1; i <= 200; i++) { T.place(500, undefined, { health: T.me().health, invincible: 0 }); T.step(1); if (T.me().health < 5) return i; } return -1; };
      out.first = strikeFrame(0); out.third = strikeFrame(28);
      out.terrain = raidG.terrain.length;
      out.attacks1 = (() => { T.seed(3); const set = new Set(); for (let i = 0; i < 300; i++) { T.prepBoss('bramblehide', 1); BOSS_ATTACK_FNS.bramblehide(raidG.boss); set.add(raidG.boss.anim.state); } return [...set].sort(); })();
      out.attacks2 = (() => { T.seed(3); const set = new Set(); for (let i = 0; i < 300; i++) { T.prepBoss('bramblehide', 2); BOSS_ATTACK_FNS.bramblehide(raidG.boss); set.add(raidG.boss.anim.state); } return [...set].sort(); })();
      return out;
    });
    expect(r.frames).toBe(30);
    expect(r.count).toBe(5);
    expect(r.projectiles, 'nothing is thrown').toBe(0);
    expect(r.xs[0], 'a line starting beside the boar').toBeGreaterThan(300);
    expect(r.xs[1] - r.xs[0], 'spaced with gaps').toBeGreaterThanOrEqual(130);
    expect(r.delays).toEqual([0, 14, 28, 42, 56]);
    expect(r.first).toBeGreaterThanOrEqual(58 - 4);
    expect(r.third - r.first, 'staggered').toBeGreaterThanOrEqual(26);
    expect(r.terrain).toBe(0);
    expect(r.attacks1).toEqual(['chargeWindup', 'rootWindup']);
    expect(r.attacks2).toEqual(['chargeWindup', 'rootWindup', 'waveWindup']);
  });

});

test.describe('Ironclad Colossus (BOS-41)', () => {
  test('BOS-41 earthquake stomp: a 40-frame windup, then a quake erupts from directly under the golem; stunned after', async ({ page }) => {
    await setup(page, 'colossus');
    const r = await page.evaluate(() => {
      T.prepBoss('colossus', 1); T.place(500);
      raidG.boss.anim = { state: 'slamWindup', timer: 0 };
      const seq = runs(120, () => raidG.boss.anim.state === 'dazed');
      const quakes = raidG.hazards.filter((h) => h.kind === 'quake');
      const pillars = raidG.terrain.filter((t) => t.kind === 'pillar').map((t) => ({ dx: Math.round(t.x - raidG.boss.x), top: t.top, life: t.life, age: t.age, w: t.w }));
      return {
        pillars,
        seq: seq.map((s) => s[0]), rise: seq[0][1], count: quakes.length,
        atBoss: quakes.length ? Math.abs(quakes[0].x - raidG.boss.x) < 3 : false,
        dusted: raidG.slamAnimations.some((s) => Math.abs(s.x - raidG.boss.x) < 3),
        stunned: raidG.boss.exposed >= 119
      };
    });
    expect(r.seq).toEqual(['slamWindup', 'slamDown', 'dazed']);
    near(r.rise, 40);
    expect(r.count).toBe(1);
    expect(r.atBoss, "the quake erupts from directly under the golem's own feet, not a distant marked spot").toBe(true);
    expect(r.dusted, 'a dust/impact burst lands at the same spot as the quake').toBe(true);
    expect(r.stunned).toBe(true);
    // the stomp also changes the terrain: three stone pillars rise out of the floor around the arena
    expect(r.pillars.length, 'three pillars').toBe(3);
    r.pillars.forEach((p) => {
      expect(Math.abs(p.dx), 'never right on top of the golem').toBeGreaterThanOrEqual(150);
      expect(p.top, 'a jump can reach the top').toBeGreaterThanOrEqual(500 - 110);
      expect(p.life, 'they stand for about 12 seconds').toBeGreaterThan(600);
    });
    expect(new Set(r.pillars.map((p) => p.dx)).size, 'in different places').toBe(3);
  });

  test('BOS-41 the blue arc-discharge bolts are gone, and a pillar is cover: it stops the overload pulse', async ({ page }) => {
    await setup(page, 'colossus');
    const r = await page.evaluate(() => {
      const out = { hasDischarge: typeof colossusArcDischarge, states: Object.keys(MQ_BOSS_SFX.colossus) };
      out.attacks = (() => { const seen = new Set(); T.seed(3); for (let i = 0; i < 400; i++) { T.prepBoss('colossus', 3); BOSS_ATTACK_FNS.colossus(raidG.boss); seen.add(raidG.boss.anim.state); } return [...seen].sort(); })();
      // a pulse with a pillar between the golem and a player: the player behind the pillar is safe, the other is not
      T.prepBoss('colossus', 2); raidLocal.health = 5;
      raidG.boss.x = 500;
      const p = raidTerrainAdd({ kind: 'pillar', x: 700, w: 80, top: raidGROUND_Y - 100, life: -1 }); p.age = 40;
      raidPlayerRef.child('p2').set(Object.assign({}, T.me(), { x: 150 - 18, health: 5, invincible: 0 }));
      colossusOverloadPulse(raidG.boss);
      const hp = { behind: 5, open: 5 };
      for (let f = 0; f < 200; f++) {
        raidPlayerRef.child('p2').update({ x: 150 - 18, y: raidGROUND_Y - 48, health: raidG.players.p2 ? raidG.players.p2.health : 5, invincible: 0 });
        T.place(850, undefined, { health: raidLocal.health, invincible: 0 });
        T.step(1);
      }
      out.behind = T.me().health; out.open = raidG.players.p2 ? raidG.players.p2.health : 5;
      return out;
    });
    expect(r.hasDischarge, 'the aimed blue bolts are gone').toBe('undefined');
    expect(r.states).not.toContain('chargeGlow');
    expect(r.attacks).toEqual(['hurlWindup', 'marchWindup', 'pulseWindup', 'slamWindup']);
    expect(r.behind, 'a player behind the pillar is shielded from the wave').toBe(5);
    expect(r.open, 'a player in the open is hit').toBeLessThan(5);
  });

  test('BOS-41 overload pulse (phase 2+): a 34-frame windup, then two ground shockwaves in both directions', async ({ page }) => {
    await setup(page, 'colossus');
    const r = await page.evaluate(() => {
      T.prepBoss('colossus', 2); T.place(500);
      raidG.boss.anim = { state: 'pulseWindup', timer: 0 };
      const frames = T.until(() => raidG.hazards.some((h) => h.kind === 'shockwave'), 60);
      const waves = raidG.hazards.filter((h) => h.kind === 'shockwave').map((h) => h.dir).sort();
      return { frames, waves };
    });
    expect(r.frames).toBe(34);
    expect(r.waves).toEqual([-1, 1]);
  });
});

test.describe('Ironclad Colossus new moves (BOS-41)', () => {
  test('BOS-41 boulder hurl: a 36-frame windup, then one big, parryable boulder per player lobbed to where they stood', async ({ page }) => {
    await setup(page, 'colossus');
    const r = await page.evaluate(() => {
      T.prepBoss('colossus', 1); T.place(250);
      raidPlayerRef.child('p2').set(Object.assign({}, T.me(), { x: 760 - 18 }));
      raidG.boss.anim = { state: 'hurlWindup', timer: 0 };
      const frames = T.until(() => raidG.projectiles.length > 0, 80);
      const rocks = raidG.projectiles.map((p) => Object.assign({}, p));
      const lands = rocks.map((p) => Math.round(p.x + p.vx * (p.life - 6))).sort((a, b) => a - b);
      // each boulder bursts where it lands and a stone pillar rises there; never more than six stand at once
      T.place(960); raidPlayerRef.child('p2').update({ x: 960 - 18 }); T.step(120);
      const pillars = raidG.terrain.filter((t) => t.kind === 'pillar').map((t) => Math.round(t.x)).sort((a, b) => a - b);
      raidClearTerrain();
      for (let i = 0; i < 9; i++) RAID_LAND_FX.boulder(100 + i * 90);
      const capped = raidG.terrain.filter((t) => t.kind === 'pillar').length;
      return { pillars, capped, onLand: rocks.map((p) => p.onLand), frames, count: rocks.length, kinds: [...new Set(rocks.map((p) => p.kind))], gravity: rocks.every((p) => p.gravity > 0), maxLife: Math.max(...rocks.map((p) => p.life)), parryable: rocks.every((p) => raidIsParryable(p)), lands, up: rocks.every((p) => p.vy < 0) };
    });
    expect(r.frames).toBe(36);
    expect(r.count).toBe(2);
    expect(r.kinds).toEqual(['boulder']);
    expect(r.gravity).toBe(true);
    expect(r.up, 'lobbed up and over, not flung flat').toBe(true);
    expect(r.maxLife, 'airborne for at most ~1.6 s').toBeLessThanOrEqual(110);
    expect(r.parryable, 'a big boulder is one of the shots a swing can parry').toBe(true);
    expect(Math.abs(r.lands[0] - 250)).toBeLessThan(15);
    expect(Math.abs(r.lands[1] - 760)).toBeLessThan(15);
    expect(r.onLand).toEqual(['boulder', 'boulder']);
    expect(r.pillars.length, 'a pillar rises where each one lands').toBe(2);
    expect(Math.abs(r.pillars[0] - 250)).toBeLessThan(20);
    expect(Math.abs(r.pillars[1] - 760)).toBeLessThan(20);
    expect(r.capped, 'the arena never fills up: at most six pillars, the oldest crumble first').toBe(6);
  });

  test('BOS-41 seismic march (phase 2+): a 40-frame windup, then three marked tremors stepping toward the nearest player that erupt one after another', async ({ page }) => {
    await setup(page, 'colossus');
    const r = await page.evaluate(() => {
      T.prepBoss('colossus', 2); T.place(900);
      raidG.boss.anim = { state: 'marchWindup', timer: 0 };
      const frames = T.until(() => raidG.hazards.some((h) => h.kind === 'tremor'), 80);
      const tr = raidG.hazards.filter((h) => h.kind === 'tremor').map((h) => ({ x: h.x, delay: h.delay, life: h.life })).sort((a, b) => a.delay - b.delay);
      const out = { frames, tr, bossX: raidG.boss.x, warn: RAID_TREMOR_WARN, active: RAID_TREMOR_ACTIVE };
      // each tremor only hurts in its own strike window, only grounded players next to it
      const hitFrame = (idx, airborne, dx) => {
        T.prepBoss('colossus', 2); raidLocal.health = 5;
        raidG.hazards = [];
        raidHazard({ kind: 'tremor', x: 600, delay: 20 * idx, life: 20 * idx + RAID_TREMOR_WARN + RAID_TREMOR_ACTIVE + 4 });
        for (let f = 1; f <= 120; f++) {
          T.place(600 + dx, airborne ? raidGROUND_Y - 48 - 90 : undefined, { health: 5, invincible: 0 });
          T.step(1);
          if (T.me().health < 5) return f;
        }
        return -1;
      };
      out.first = hitFrame(0, false, 0); out.third = hitFrame(2, false, 0); out.jumped = hitFrame(0, true, 0); out.aside = hitFrame(0, false, 80);
      return out;
    });
    expect(r.frames).toBe(40);
    expect(r.tr.length).toBe(3);
    expect(r.tr.map((t) => t.delay)).toEqual([0, 20, 40]);
    r.tr.forEach((t, i) => expect(t.x, 'each step is further from the golem, toward the player').toBeGreaterThan((i ? r.tr[i - 1].x : r.bossX) + 60));
    expect(r.warn, 'at least 40 frames of marker before any tremor erupts').toBeGreaterThanOrEqual(40);
    expect(r.first).toBeGreaterThanOrEqual(r.warn - 2);
    expect(r.first).toBeLessThanOrEqual(r.warn + 4);
    expect(r.third - r.first, 'later tremors erupt later, in rhythm').toBeGreaterThanOrEqual(36);
    expect(r.jumped, 'a jump clears a tremor').toBe(-1);
    expect(r.aside, 'so does stepping 80 px away').toBe(-1);
  });

  test('BOS-41 phase gating: stomp, boulder hurl and the seismic march from phase 1; the overload pulse only from phase 2', async ({ page }) => {
    await setup(page, 'colossus');
    const r = await page.evaluate(() => {
      const collect = (phase) => {
        T.seed(2); const seen = new Set();
        for (let i = 0; i < 300; i++) { T.prepBoss('colossus', phase); BOSS_ATTACK_FNS.colossus(raidG.boss); seen.add(raidG.boss.anim.state); }
        return [...seen].sort();
      };
      return { p1: collect(1), p2: collect(2) };
    });
    expect(r.p1).toEqual(['hurlWindup', 'marchWindup', 'slamWindup']);
    expect(r.p2).toEqual(['hurlWindup', 'marchWindup', 'pulseWindup', 'slamWindup']);
  });
});

test.describe('Skybound Griffon (BOS-42)', () => {

  test('BOS-42 wind dive: swoops over the target (40), hovers looking down and tracking them for 2.5 s, locks on, plunges (24), crashes and is stunned, then soars back', async ({ page }) => {
    await setup(page, 'griffon');
    const r = await page.evaluate(() => {
      T.prepBoss('griffon', 1); T.place(700);
      griffonWindDive(raidG.boss);
      const out = { xs: [], ys: [], look: [] };
      let moved = false;
      const seq = runs(400, () => {
        const a = raidG.boss.anim;
        if (a.state === 'track') {
          if (!moved) { moved = true; }
          // the player walks to 400 early in the track, then to 200 once the lock-on has begun
          const lockedNow = a.timer > RAID_GRIFFON_TRACK_FRAMES - RAID_GRIFFON_LOCK_FRAMES;
          T.place(lockedNow ? 200 : 400);
          out.xs.push(raidG.boss.x); out.ys.push(raidG.boss.y); out.look.push(griffonLookDown(raidG.boss));
        }
        return a.state === 'thud';
      });
      out.seq = seq.map((s) => s[0]); out.lens = seq.map((s) => s[1]);
      out.stunned = raidG.boss.exposed >= 119;
      out.landedX = raidG.boss.x;
      out.trackFrames = RAID_GRIFFON_TRACK_FRAMES; out.lockFrames = RAID_GRIFFON_LOCK_FRAMES;
      out.lookIdle = (() => { T.prepBoss('griffon', 1); return griffonLookDown(raidG.boss); })();
      return out;
    });
    expect(r.seq).toEqual(['swoop', 'track', 'plunge', 'thud']);
    near(r.lens[0], 40);
    near(r.lens[1], 150);
    near(r.lens[2], 24);
    expect(r.trackFrames, 'it tracks for 2.5 s').toBe(150);
    // while tracking it follows the player (700 -> 400) at a modest speed...
    const followPart = r.xs.slice(0, r.trackFrames - r.lockFrames);
    expect(Math.abs(followPart[followPart.length - 1] - 400), 'ends up over the player it was tracking').toBeLessThan(15);
    followPart.slice(1).forEach((x, i) => expect(Math.abs(x - followPart[i]), 'tracking speed').toBeLessThanOrEqual(3.6));
    // ...then locks on: the last 30 frames it no longer follows, so walking away works
    const lockPart = r.xs.slice(r.trackFrames - r.lockFrames + 1);
    expect(Math.max(...lockPart) - Math.min(...lockPart), 'locked in place').toBeLessThan(0.5);
    expect(Math.abs(r.landedX - lockPart[0]), 'it dives where it locked on').toBeLessThan(2);
    expect(r.ys.every((y) => y < 100), 'it hovers high while tracking').toBe(true);
    expect(r.look[30], 'it looks straight down while tracking').toBe(1);
    expect(r.lookIdle, 'and looks ahead normally otherwise').toBe(0);
    expect(r.stunned).toBe(true);
  });

  test('BOS-42 strafing run: flies to the far edge (60-frame lane warning), then sweeps across low and slow-ish; a jump clears it, once per player', async ({ page }) => {
    await setup(page, 'griffon');
    const r = await page.evaluate(() => {
      const run = (airborne) => {
        T.prepBoss('griffon', 1); raidLocal.health = 5;
        T.place(300);
        raidG.boss.anim = { state: 'strafeAim', timer: 0, dir: 1 };
        let hits = 0, lastHp = 5, seq = [], cur = null, maxStep = 0, lastX = null, lowY = null;
        for (let f = 0; f < 260; f++) {
          T.place(500, airborne ? raidGROUND_Y - 48 - 90 : undefined, { health: raidLocal.health, invincible: 0 });
          T.step(1);
          const a = raidG.boss.anim;
          if (!cur || cur[0] !== a.state) { cur = [a.state, 0]; seq.push(cur); }
          cur[1]++;
          if (a.state === 'strafe') { if (lastX !== null) maxStep = Math.max(maxStep, Math.abs(raidG.boss.x - lastX)); lastX = raidG.boss.x; lowY = raidG.boss.y; }
          const h = T.me().health;
          if (h < lastHp) hits += lastHp - h;
          lastHp = h;
          if (a.state === 'idle' && f > 20) break;
        }
        return { seq: seq.map((q) => q[0]), lens: seq.map((q) => q[1]), hits, maxStep, lowY };
      };
      return { ground: run(false), air: run(true), lowEnough: raidGROUND_Y - 120 };
    });
    expect(r.ground.seq.slice(0, 3)).toEqual(['strafeAim', 'strafe', 'strafeReturn']);
    near(r.ground.lens[0], 60);
    near(r.ground.lens[1], 70);
    expect(r.ground.maxStep, 'about 13 px/frame, and it was marked 60 frames earlier').toBeLessThanOrEqual(14);
    expect(r.ground.lowY, 'it sweeps low enough that standing still is not safe').toBeGreaterThan(r.lowEnough);
    expect(r.ground.hits, 'a grounded player in the lane is hit exactly once').toBe(1);
    expect(r.air.hits, 'a player who jumps over it is not hit').toBe(0);
  });

  test('BOS-42 feather rain (phase 2+): a 40-frame windup, then five marked feather drops spaced apart that strike one after another', async ({ page }) => {
    await setup(page, 'griffon');
    const r = await page.evaluate(() => {
      T.prepBoss('griffon', 2); T.place(500);
      raidG.boss.anim = { state: 'rainWindup', timer: 0 };
      const frames = T.until(() => raidG.hazards.some((h) => h.kind === 'featherFall'), 80);
      const xs = raidG.hazards.filter((h) => h.kind === 'featherFall').map((h) => Math.round(h.x)).sort((a, b) => a - b);
      const out = { frames, xs, warn: RAID_FEATHERFALL_WARN, active: RAID_FEATHERFALL_ACTIVE };
      const hitFrame = (airborne, dx) => {
        T.prepBoss('griffon', 2); raidLocal.health = 5; raidG.hazards = [];
        raidHazard({ kind: 'featherFall', x: 500, delay: 0, life: RAID_FEATHERFALL_WARN + RAID_FEATHERFALL_ACTIVE + 4 });
        for (let f = 1; f <= 90; f++) {
          T.place(500 + dx, airborne ? raidGROUND_Y - 48 - 90 : undefined, { health: 5, invincible: 0 });
          T.step(1);
          if (T.me().health < 5) return f;
        }
        return -1;
      };
      out.stand = hitFrame(false, 0); out.air = hitFrame(true, 0); out.aside = hitFrame(false, 70);
      return out;
    });
    expect(r.frames).toBe(40);
    expect(r.xs.length).toBe(5);
    r.xs.slice(1).forEach((x, i) => expect(x - r.xs[i], 'drops are spaced so there is always room to stand').toBeGreaterThan(100));
    expect(r.warn, 'a long marker before each drop').toBeGreaterThanOrEqual(45);
    expect(r.stand).toBeGreaterThanOrEqual(r.warn - 2);
    expect(r.stand).toBeLessThanOrEqual(r.warn + 4);
    expect(r.air, 'it is a full-height column, so jumping does not help').toBeGreaterThan(0);
    expect(r.aside, 'stepping 70 px aside does').toBe(-1);
  });

  test('BOS-42 the arena has two permanent cloud platforms to hop onto', async ({ page }) => {
    await setup(page, 'griffon');
    const r = await page.evaluate(() => {
      T.prepBoss('griffon', 1); raidResetTerrain('griffon');
      const clouds = raidG.terrain.filter((t) => t.kind === 'platform').map((t) => ({ x: t.x, top: t.top, life: t.life, theme: t.theme }));
      raidClearTerrain();
      return { clouds };
    });
    expect(r.clouds.length).toBe(2);
    r.clouds.forEach((c) => { expect(c.life).toBe(-1); expect(c.theme).toBe('griffon'); expect(500 - c.top).toBeLessThanOrEqual(110); });
  });

  test('BOS-42 attacks: wind dive, strafing run and feather rain; nothing is thrown (rain gets three columns, five from phase 2)', async ({ page }) => {
    await setup(page, 'griffon');
    const r = await page.evaluate(() => {
      const collect = (phase) => {
        T.seed(2); const seen = new Set();
        for (let i = 0; i < 300; i++) { T.prepBoss('griffon', phase); BOSS_ATTACK_FNS.griffon(raidG.boss); seen.add(raidG.boss.anim.state); }
        return [...seen].sort();
      };
      return { p1: collect(1), p2: collect(2) };
    });
    expect(r.p1).toEqual(['rainWindup', 'strafeAim', 'swoop']);
    expect(r.p2).toEqual(['rainWindup', 'strafeAim', 'swoop']);
  });

});

test.describe('Ground-anchored bosses (BOS-43)', () => {
  const heightAboveGround = async (page, type) => page.evaluate(async (t) => {
    await T.setupRaid(t);
    const ys = [];
    for (let i = 0; i < 40; i++) { T.step(1); ys.push(raidGROUND_Y - raidG.boss.y); }
    return { min: Math.min(...ys), max: Math.max(...ys) };
  }, type);

  test('BOS-43 Bramblehide sits at floor height with only a small bob', async ({ page }) => {
    const r = await heightAboveGround(page, 'bramblehide');
    expect(r.max, 'stays within its own half-height plus a few px of bob').toBeLessThan(50 + 10);
  });

  test('BOS-43 Colossus sits at floor height with only a small bob', async ({ page }) => {
    const r = await heightAboveGround(page, 'colossus');
    expect(r.max, 'stays within its own half-height plus a few px of bob').toBeLessThan(85 + 10);
  });

  test('BOS-43 Grinmaw (a floating boss, for contrast) hovers clear of the floor - but low (BOS-44)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const bottoms = [];
      for (let i = 0; i < 40; i++) { T.step(1); bottoms.push(raidGROUND_Y - (raidG.boss.y + BOSS_HURT.grinmaw.bounds.y1)); } // gap between the body's bottom and the floor
      return { min: Math.min(...bottoms), max: Math.max(...bottoms) };
    });
    expect(r.min, 'the body still floats well above the floor').toBeGreaterThan(110);
    expect(r.max, 'but low - a small hop reaches it').toBeLessThan(180);
  });

  const canMeleeGrounded = async (page, type) => page.evaluate(async (t) => {
    await T.setupRaid(t);
    T.step(1); // let the boss's ground-anchored position (BOS-43) settle before reading boss.x/y
    raidLocal.gun = 'sword_training';
    raidLocal.facing = 1;
    T.place(raidG.boss.x);
    raidLocal.input = { left: false, right: false, up: false, down: false, space: false };
    raidLocal.swordCooldown = 0;
    const hp0 = raidG.boss.hp;
    raidSwordSwing();
    for (let i = 0; i < RAID_SWORD_SWING_FRAMES; i++) {
      if (raidLocal.swingTimer > 0) raidLocal.swingTimer--;
      raidSendLocalState();
      raidCheckSwordSwings(raidG.boss);
    }
    return raidG.boss.hp < hp0;
  }, type);

  test('BOS-43 a grounded player can melee Bramblehide without jumping', async ({ page }) => {
    expect(await canMeleeGrounded(page, 'bramblehide')).toBe(true);
  });

  test('BOS-43 a grounded player can melee Colossus without jumping', async ({ page }) => {
    expect(await canMeleeGrounded(page, 'colossus')).toBe(true);
  });

  test('BOS-43 a grounded player cannot melee a floating boss (Grinmaw) without jumping', async ({ page }) => {
    expect(await canMeleeGrounded(page, 'grinmaw')).toBe(false);
  });
});

test.describe('Bosses hover near the ground (BOS-44)', () => {
  // For every boss: can a swing from a player whose body centre is at a given height, standing right under the
  // boss, touch the boss's drawn body at any point of the swing? (The real slash against the real silhouette.)
  const reach = (page, type, playerCentreY, dirs, frames = 1) => page.evaluate(async ([t, y, ds, n]) => {
    await T.setupRaid(t);
    T.prepBoss(t, 1); // idle only, no attacks
    T.step(2); // let the boss settle into its idle position
    let hit = false;
    for (let f = 0; f < n && !hit; f++) {
      if (f) T.step(7); // sample the idle bob / path across about 3 more seconds
      const b = raidG.boss;
      for (const d of ds) {
        const p = { x: b.x - 18, y: y - 24, facing: 1, swingDir: d, utility: '' }; // y is the player's centre
        if (raidSwingHitsBoss(p, b)) hit = true;
      }
    }
    return hit;
  }, [type, playerCentreY, dirs, frames]);
  // body-centre height: standing / at the top of a tap jump (about 120 px) / at the top of a full held jump (about 170 px)
  const STAND = 500 - 24, HOP = 500 - 24 - 120, FULL = 500 - 24 - 170;
  const FLOATERS = ['grinmaw', 'warden', 'wyrm', 'glutton', 'griffon'];
  const ALL_DIRS = ['side', 'up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright'];

  for (const boss of ['grinmaw', 'warden', 'wyrm', 'glutton', 'griffon', 'bramblehide', 'colossus']) {
    test('BOS-44 ' + boss + ' can be hit with a swing from the top of a small hop', async ({ page }) => {
      expect(await reach(page, boss, HOP, ALL_DIRS), 'a swing from a tap-height jump reaches it').toBe(true);
    });
    test('BOS-44 ' + boss + ' can be pogoed from the top of a held jump', async ({ page }) => {
      expect(await reach(page, boss, FULL, ['down'], 40), 'a down swing from a full jump reaches it at some point of its patrol').toBe(true);
    });
  }
  for (const boss of FLOATERS) {
    test('BOS-44 ' + boss + ' still floats - no swing, in any direction, hits it from the ground, at any point of its idle bob', async ({ page }) => {
      expect(await reach(page, boss, STAND, ALL_DIRS, 60)).toBe(false);
    });
  }
});

test.describe('Bosses keep moving (BOS-47)', () => {
  for (const boss of ['grinmaw', 'warden', 'wyrm', 'glutton', 'bramblehide', 'colossus', 'griffon']) {
    test(`BOS-47 ${boss} never stands still while idle: it covers ground, and the ground-bound ones follow the nearest player`, async ({ page }) => {
      await setup(page, boss);
      const r = await page.evaluate((type) => {
        const run = (playerX) => {
          T.prepBoss(type, 1); T.place(playerX, 60); // up on a ledge so nothing is in the way
          raidG.boss.attackTimer = 99999;
          const xs = [];
          for (let f = 0; f < 900; f++) { T.place(playerX, 60); T.step(1); if (f >= 300) xs.push(raidG.boss.x); }
          let travelled = 0; for (let i = 1; i < xs.length; i++) travelled += Math.abs(xs[i] - xs[i - 1]);
          const windows = []; // how far it moves in each second of the last ten
          for (let i = 0; i + 60 < xs.length; i += 60) { let d = 0; for (let j = i + 1; j <= i + 60; j++) d += Math.abs(xs[j] - xs[j - 1]); windows.push(d); }
          return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, range: Math.max(...xs) - Math.min(...xs), perFrame: travelled / (xs.length - 1), minWindow: Math.min(...windows), y: raidG.boss.y, anim: raidG.boss.anim.state };
        };
        return { left: run(150), right: run(850) };
      }, boss);
      expect(r.left.anim).toBe('idle');
      for (const k of ['left', 'right']) {
        expect(r[k].perFrame, 'moves all the time').toBeGreaterThan(0.3);
        expect(r[k].range, 'and covers real ground').toBeGreaterThan(120);
        expect(r[k].minWindow, 'every second of it').toBeGreaterThan(8);
      }
      if (['grinmaw', 'warden', 'bramblehide', 'colossus'].includes(boss)) {
        expect(r.left.mean, 'follows a player on the left').toBeLessThan(400);
        expect(r.right.mean, 'follows a player on the right').toBeGreaterThan(600);
      }
    });
  }
});
