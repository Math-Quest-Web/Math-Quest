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
  test('BOS-20 candy spit: inhales for 26 frames, then fires one slow shot per player from the mouth', async ({ page }) => {
    await setup(page, 'grinmaw');
    const r = await page.evaluate(() => {
      T.prepBoss('grinmaw', 1); T.place(300);
      raidG.boss.anim = { state: 'spit', timer: 0 };
      const frames = T.until(() => raidG.projectiles.length > 0, 100);
      const p = raidG.projectiles[0];
      const count = raidG.projectiles.length;
      const fromMouth = Math.hypot(p.x - raidG.boss.x, p.y - (raidG.boss.y + 30)) < 25;
      const scaleWhileInhaling = (() => { T.prepBoss('grinmaw', 1); raidG.boss.anim = { state: 'spit', timer: 0 }; T.step(20); return raidG.boss.animScale; })();
      return { frames, count, kind: p.kind, speed: Math.hypot(p.vx, p.vy), fromMouth, toward: p.vx < 0, scaleWhileInhaling };
    });
    expect(r.frames).toBe(26);
    expect(r.count).toBe(1);
    expect(r.kind).toBe('candy');
    expect(r.speed).toBeCloseTo(1.7 + 0.35, 1);
    expect(r.fromMouth).toBe(true);
    expect(r.toward).toBe(true);
    expect(r.scaleWhileInhaling, 'the boss visibly swells while inhaling').toBeGreaterThan(1.05);
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
      return { seq, waves, rise, stunned, grounded: cross(false), jumping: cross(true) };
    });
    expect(r.seq.map((s) => s[0])).toEqual(['windup', 'slam', 'dazed']); // the stun starts as the waves are born
    near(r.seq[0][1], 60);
    near(r.seq[1][1], 5);
    expect(r.waves).toEqual([{ dir: -1, speed: 2.7, atBoss: true }, { dir: 1, speed: 2.7, atBoss: true }]);
    expect(r.rise, 'the boss rears up before the slam').toBeLessThan(-10);
    expect(r.stunned).toBeGreaterThanOrEqual(119);
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
  test('BOS-22 triple volley: the body coils, then each head spits one slow fang (frames 24, 44, 64)', async ({ page }) => {
    await setup(page, 'wyrm');
    const r = await page.evaluate(() => {
      T.prepBoss('wyrm', 1); T.place(500);
      wyrmTripleVolley(raidG.boss);
      T.watch();
      const frames = []; let seen = 0;
      for (let f = 1; f <= 100; f++) { T.step(1); if (T.spawns.length > seen) { frames.push(f); seen = T.spawns.length; } }
      const heads = T.spawns.map((p) => Math.round(p.x - p._bx));
      return { frames, kinds: T.spawns.map((p) => p.kind), speeds: T.spawns.map((p) => Math.round(Math.hypot(p.vx, p.vy) * 100) / 100), heads };
    });
    expect(r.frames).toEqual([24, 44, 64]);
    expect(r.kinds).toEqual(['fang', 'fang', 'fang']);
    r.speeds.forEach((s) => expect(s).toBeCloseTo(1.9 + 0.35, 1));
    r.heads.forEach((dx, i) => expect(Math.abs(dx - [-52.5, 0, 52.5][i])).toBeLessThan(12)); // heads: left, middle, right (pulled in with the smaller Wyrm)
  });

  test('BOS-22 fire spit: arcing fireballs (2, or 3 from phase 2) land on a spot and erupt into a flame pillar', async ({ page }) => {
    await setup(page, 'wyrm');
    const r = await page.evaluate(() => {
      const out = {};
      for (const phase of [1, 2]) {
        T.prepBoss('wyrm', phase); T.place(500, 60); // player parked up high so no fireball is stopped mid-flight
        wyrmFireSpit(raidG.boss);
        T.watch();
        T.step(170);
        out['embers' + phase] = T.spawns.filter((p) => p.kind === 'ember').length;
        out['pillars' + phase] = T.hazardSpawns.filter((h) => h.kind === 'pillar').length;
      }
      const ember = T.spawns.find((p) => p.kind === 'ember');
      out.ember = { gravity: ember.gravity, onLand: ember.onLand, life: ember.life, vy: ember.vy, rise: ember.vy < 0 ? (ember.vy * ember.vy) / (2 * ember.gravity) : 0, wanted: RAID_LOB_RISE };
      // the pillar: marker 32 frames, erupts 32-59; only hurts nearby, low players
      const pillar = (dx, airborne) => {
        T.prepBoss('wyrm', 1); raidLocal.health = 5;
        raidHazard({ kind: 'pillar', x: 500, life: 66 });
        for (let f = 1; f <= 70; f++) {
          T.place(500 + dx, airborne ? raidGROUND_Y - 48 - 140 : undefined, { health: raidLocal.health, invincible: 0 });
          T.step(1);
          if (T.me().health < 5) return f;
        }
        return -1;
      };
      out.hitStanding = pillar(0, false); out.hitNear = pillar(30, false); out.hitAside = pillar(80, false); out.hitHigh = pillar(0, true);
      return out;
    });
    expect(r.embers1).toBe(2);
    expect(r.embers2).toBe(3);
    expect(r.pillars1).toBe(2);
    expect(r.pillars2).toBe(3);
    expect(r.ember.onLand).toBe('pillar');
    expect(r.ember.life).toBe(66);
    expect(r.ember.gravity, 'the fireball is lobbed up and over, not flung flat').toBeGreaterThan(0.1);
    expect(r.ember.vy, 'it launches upward').toBeLessThan(0);
    expect(Math.abs(r.ember.rise - r.ember.wanted), 'and peaks about RAID_LOB_RISE above the launch point').toBeLessThan(8);
    expect(r.hitStanding).toBeGreaterThanOrEqual(31);
    expect(r.hitStanding).toBeLessThanOrEqual(34);
    expect(r.hitNear).toBeGreaterThanOrEqual(31);
    expect(r.hitAside, 'stepping 80px aside avoids the flames').toBe(-1);
    expect(r.hitHigh, 'a high jump clears the flames').toBe(-1);
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
  test('BOS-23 belch: inflates for 24 frames, then lobs a slow bubble at each player that lands and pops on the floor', async ({ page }) => {
    await setup(page, 'glutton');
    const r = await page.evaluate(() => {
      T.prepBoss('glutton', 1); T.place(750);
      raidG.boss.anim = { state: 'inflate', timer: 0, kind: 'belch' };
      const scale = (() => { T.step(20); return raidG.boss.animScale; })();
      T.prepBoss('glutton', 1); T.place(750);
      raidG.boss.anim = { state: 'inflate', timer: 0, kind: 'belch' };
      const frames = T.until(() => raidG.projectiles.length > 0, 100);
      const start = raidG.projectiles.map((p) => ({ kind: p.kind, fromMouth: Math.abs(p.x - raidG.boss.x) < 15 }));
      let lastX = 0, maxY = 0, popped = -1;
      for (let f = 1; f <= 200; f++) {
        const b = raidG.projectiles[0];
        if (b) { lastX = b.x; maxY = Math.max(maxY, b.y); }
        T.step(1);
        if (!raidG.projectiles.length) { popped = f; break; }
      }
      return { scale, frames, start, landX: Math.round(lastX), maxY: Math.round(maxY), popped };
    });
    expect(r.frames).toBe(24);
    expect(r.scale, 'visibly swells before belching').toBeGreaterThan(1.15);
    expect(r.start).toEqual([{ kind: 'bubble', fromMouth: true }]);
    expect(Math.abs(r.landX - 750)).toBeLessThan(15);
    expect(r.maxY, 'bubbles never fall through the floor').toBeLessThanOrEqual(500);
    expect(r.popped).toBeGreaterThan(70);
    expect(r.popped).toBeLessThan(100);
  });

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
      return { target, seq, fade, near: bite(300), aside: bite(400), jump: (() => { T.prepBoss('glutton', 1); raidLocal.health = 5; T.place(300); gluttonStartChomp(raidG.boss); for (let f = 0; f < 300; f++) { T.place(300, raidGROUND_Y - 48 - 90, { health: raidLocal.health, invincible: 0 }); T.step(1); if (raidG.boss.anim.state === 'dazed') break; } return T.me().health; })() };
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
  });

  test('BOS-23 bubble fan (phase 2+): five bubbles land across the arena with gaps to stand in', async ({ page }) => {
    await setup(page, 'glutton');
    const r = await page.evaluate(() => {
      T.prepBoss('glutton', 2); T.place(500);
      raidG.boss.anim = { state: 'inflate', timer: 0, kind: 'fan' };
      T.until(() => raidG.projectiles.length > 0, 100);
      const lands = raidG.projectiles.map((p) => Math.round(p.x + p.vx * (p.life - 10))).sort((a, b) => a - b);
      const gaps = lands.slice(1).map((x, i) => x - lands[i]);
      return { count: raidG.projectiles.length, lands, minGap: Math.min(...gaps), within: lands.every((x) => x >= 0 && x <= 1000) };
    });
    expect(r.count).toBe(5);
    expect(r.within).toBe(true);
    expect(r.minGap, 'room to stand between bubbles').toBeGreaterThan(100);
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
  test('BOS-40 root spikes: a 26-frame windup, then a thorn marker under every player and a full 60-frame warning before the spikes erupt', async ({ page }) => {
    await setup(page, 'bramblehide');
    const r = await page.evaluate(() => {
      T.prepBoss('bramblehide', 1); T.place(300);
      raidG.boss.anim = { state: 'rootWindup', timer: 0 };
      const frames = T.until(() => raidG.hazards.some((h) => h.kind === 'thornSpike'), 60);
      const spikes = raidG.hazards.filter((h) => h.kind === 'thornSpike');
      const out = { frames, count: spikes.length, atPlayer: Math.abs(spikes[0].x - 300) < 5, warn: RAID_THORN_WARN, active: RAID_THORN_ACTIVE, life: spikes[0].life };
      // a player who never moves: first damage lands only after the whole warning
      let firstHit = -1;
      for (let i = 1; i <= 120 && firstHit < 0; i++) { T.step(1); if (T.me().health < 5) firstHit = i; }
      out.firstHit = firstHit;
      return out;
    });
    expect(r.frames).toBe(26);
    expect(r.count).toBe(1);
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

  test('BOS-40 ram charge: skids to a stop and trots back to its home spot afterward', async ({ page }) => {
    await setup(page, 'bramblehide');
    const r = await page.evaluate(() => {
      T.prepBoss('bramblehide', 1); T.place(900); // out of the way, so it isn't stopped by a hit
      raidG.boss.anim = { state: 'chargeWindup', timer: 0, dir: raidNearestPlayerDir(raidG.boss) };
      // 45 windup + 36 charging + 120 dazed + 40 trot + 18 settle = 259 frames end to end.
      runs(300, () => raidG.boss.anim.state === 'idle');
      return { home: Math.abs(raidG.boss.x - 500) < 25 };
    });
    expect(r.home, 'ends up back near its ground-anchored home spot, not stranded mid-arena').toBe(true);
  });

  test('BOS-40 bramble toss (phase 2+): a 24-frame windup, then 2 lobbed pods that erupt into thorn spikes on landing', async ({ page }) => {
    await setup(page, 'bramblehide');
    const r = await page.evaluate(() => {
      T.prepBoss('bramblehide', 2); T.place(500);
      // a second player so Bramble Toss has two distinct targets to throw at
      raidG.players.p2 = Object.assign({}, T.me(), { x: 750 });
      raidG.boss.anim = { state: 'tossWindup', timer: 0 };
      const frames = T.until(() => raidG.projectiles.some((p) => p.kind === 'pod'), 60);
      const pods = raidG.projectiles.filter((p) => p.kind === 'pod');
      return { frames, count: pods.length, gravity: pods.every((p) => p.gravity > 0), landsAsThornSpike: pods.every((p) => p.onLand === 'thornSpike') };
    });
    expect(r.frames).toBe(24);
    expect(r.count).toBe(2);
    expect(r.gravity).toBe(true);
    expect(r.landsAsThornSpike).toBe(true);
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
      return {
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
  });

  test('BOS-41 arc discharge: a 28-frame chest-glow windup, then one aimed bolt per player', async ({ page }) => {
    await setup(page, 'colossus');
    const r = await page.evaluate(() => {
      T.prepBoss('colossus', 1); T.place(300);
      raidG.boss.anim = { state: 'chargeGlow', timer: 0 };
      const frames = T.until(() => raidG.projectiles.length > 0, 60);
      const p = raidG.projectiles[0];
      return { frames, count: raidG.projectiles.length, kind: p.kind, speed: Math.hypot(p.vx, p.vy), toward: p.vx < 0 };
    });
    expect(r.frames).toBe(28);
    expect(r.count).toBe(1);
    expect(r.kind).toBe('bolt');
    expect(r.speed).toBeCloseTo(2.1 + 0.3, 1);
    expect(r.toward).toBe(true);
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
      raidG.players.p2 = Object.assign({}, T.me(), { x: 760 - 18 });
      raidG.boss.anim = { state: 'hurlWindup', timer: 0 };
      const frames = T.until(() => raidG.projectiles.length > 0, 80);
      const rocks = raidG.projectiles.map((p) => Object.assign({}, p));
      const lands = rocks.map((p) => Math.round(p.x + p.vx * (p.life - 6))).sort((a, b) => a - b);
      return { frames, count: rocks.length, kinds: [...new Set(rocks.map((p) => p.kind))], gravity: rocks.every((p) => p.gravity > 0), maxLife: Math.max(...rocks.map((p) => p.life)), parryable: rocks.every((p) => raidIsParryable(p)), lands, up: rocks.every((p) => p.vy < 0) };
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

  test('BOS-41 phase gating: boulder hurl is available from phase 1; the overload pulse and the march only from phase 2', async ({ page }) => {
    await setup(page, 'colossus');
    const r = await page.evaluate(() => {
      const collect = (phase) => {
        T.seed(2); const seen = new Set();
        for (let i = 0; i < 300; i++) { T.prepBoss('colossus', phase); BOSS_ATTACK_FNS.colossus(raidG.boss); seen.add(raidG.boss.anim.state); }
        return [...seen].sort();
      };
      return { p1: collect(1), p2: collect(2) };
    });
    expect(r.p1).toEqual(['chargeGlow', 'hurlWindup', 'slamWindup']);
    expect(r.p2).toEqual(['chargeGlow', 'hurlWindup', 'marchWindup', 'pulseWindup', 'slamWindup']);
  });
});

test.describe('Skybound Griffon (BOS-42)', () => {
  test('BOS-42 feather volley: a 26-frame wind-pull windup, then one aimed plume per player', async ({ page }) => {
    await setup(page, 'griffon');
    const r = await page.evaluate(() => {
      T.prepBoss('griffon', 1); T.place(300);
      raidG.boss.anim = { state: 'volleyWindup', timer: 0 };
      const frames = T.until(() => raidG.projectiles.length > 0, 60);
      const p = raidG.projectiles[0];
      return { frames, count: raidG.projectiles.length, kind: p.kind, speed: Math.hypot(p.vx, p.vy) };
    });
    expect(r.frames).toBe(26);
    expect(r.count).toBe(1);
    expect(r.kind).toBe('plume');
    expect(r.speed).toBeCloseTo(2.0 + 0.3, 1);
  });

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

  test('BOS-42 phase gating: strafing run from phase 1; gale storm and feather rain only from phase 2', async ({ page }) => {
    await setup(page, 'griffon');
    const r = await page.evaluate(() => {
      const collect = (phase) => {
        T.seed(2); const seen = new Set();
        for (let i = 0; i < 300; i++) { T.prepBoss('griffon', phase); BOSS_ATTACK_FNS.griffon(raidG.boss); seen.add(raidG.boss.anim.state); }
        return [...seen].sort();
      };
      return { p1: collect(1), p2: collect(2) };
    });
    expect(r.p1).toEqual(['strafeAim', 'swoop', 'volleyWindup']);
    expect(r.p2).toEqual(['rainWindup', 'stormWindup', 'strafeAim', 'swoop', 'volleyWindup']);
  });

  test('BOS-42 gale storm (phase 2+): a 26-frame windup, then 5 lobbed feathers spread across the arena with gaps', async ({ page }) => {
    await setup(page, 'griffon');
    const r = await page.evaluate(() => {
      T.prepBoss('griffon', 2); T.place(500);
      raidG.boss.anim = { state: 'stormWindup', timer: 0 };
      const frames = T.until(() => raidG.projectiles.length > 0, 60);
      const lands = raidG.projectiles.map((p) => Math.round(p.x + p.vx * (p.life - 10))).sort((a, b) => a - b);
      const gaps = lands.slice(1).map((x, i) => x - lands[i]);
      return { frames, count: raidG.projectiles.length, within: lands.every((x) => x >= 0 && x <= 1000), minGap: Math.min(...gaps) };
    });
    expect(r.frames).toBe(26);
    expect(r.count).toBe(5);
    expect(r.within).toBe(true);
    expect(r.minGap).toBeGreaterThan(100);
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
      expect(await reach(page, boss, FULL, ['down']), 'a down swing from a full jump reaches it').toBe(true);
    });
  }
  for (const boss of FLOATERS) {
    test('BOS-44 ' + boss + ' still floats - no swing, in any direction, hits it from the ground, at any point of its idle bob', async ({ page }) => {
      expect(await reach(page, boss, STAND, ALL_DIRS, 60)).toBe(false);
    });
  }
});
