// The player's body: a small hit box, a long slash, a floaty jump, and touching a boss hurts (BOS-48).
const { test, expect } = require('./support/fixtures');

test.describe('Player hit box (RAI-05)', () => {
  test('RAI-05 the hit box is small: a shot must come within about 17 px of the player centre', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const shot = (x, y) => ({ x, y, vx: 0, vy: 0, r: 10, life: 50, isWarning: false, isBossProjectile: true, owner: 't' });
      const at = (dx, dy) => { T.prepBoss('grinmaw', 1); T.place(300); raidG.projectiles = [shot(300 + dx, 476 + dy)]; T.step(1); return T.me().health; };
      return { c: at(0, 0), near: at(14, 0), edge: at(21, 0), above: at(0, -21) };
    });
    expect(r.c).toBe(4);
    expect(r.near, 'a shot 14 px off still hits').toBe(4);
    expect(r.edge, 'one 21 px off misses (the old box was about 24)').toBe(5);
    expect(r.above).toBe(5);
  });
});

test.describe('Touching a boss hurts (BOS-48)', () => {
  test('BOS-48 touching a boss costs a heart (once per invincibility), standing just beside it does not, and a boss that cannot be hit cannot hurt you either', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('colossus');
      raidContactDamage = true;
      const edge = BOSS_HURT.colossus.bounds.x1; // the golem's right edge, relative to its centre
      const run = (dx, frames, setup) => {
        T.prepBoss('colossus', 1); raidContactDamage = true; raidLocal.health = 5; raidG.boss.attackTimer = 99999;
        raidG.boss.x = 500; if (setup) setup();
        const hp = [];
        for (let f = 0; f < frames; f++) { T.place(500 + dx, undefined, { health: T.me().health, invincible: T.me().invincible }); raidG.boss.x = 500; T.step(1); hp.push(T.me().health); }
        return hp;
      };
      const inside = run(0, 20);
      const longer = (() => { run(0, 1); const hp = []; for (let f = 0; f < 3; f++) { T.step(1); } T.me().invincible = 0; for (let f = 0; f < 2; f++) { T.step(1); hp.push(T.me().health); } return hp; })();
      const beside = run(edge + 9 + 8, 40);
      const justTouching = run(edge + 9 - 4, 5);
      const stunned = run(0, 5, () => { raidG.boss.exposed = 100; });
      const beat = run(0, 5, () => { raidG.boss.transition = 50; });
      const off = run(0, 5, () => { raidContactDamage = false; });
      // an untargetable boss: a submerged Glutton
      T.prepBoss('glutton', 1); raidContactDamage = true; raidLocal.health = 5;
      raidG.boss.anim = { state: 'swim', timer: 5, targetX: 300, homeX: 500, homeY: 95 }; raidG.boss.animScale = 0.45; raidG.boss.animAlpha = 0.2;
      raidG.boss.x = 500; raidG.boss.y = BOSS_HOVER_Y.glutton + 100;
      T.place(500, raidG.boss.y - 24); T.step(3);
      return { inside, longer, beside, justTouching, stunned, beat, off, submerged: T.me().health };
    });
    expect(r.inside[0], 'touching it costs a heart at once').toBe(4);
    expect(r.inside[19], 'only one while the invincibility lasts').toBe(4);
    expect(r.longer[1], 'and another once the invincibility has worn off').toBeLessThan(4);
    expect(r.beside[39], 'standing just clear of its edge is safe').toBe(5);
    expect(r.justTouching[4], 'but only just: the hit box is small, yet it is a real overlap').toBeLessThan(5);
    expect(r.stunned[4], 'a stunned boss still hurts').toBeLessThan(5);
    expect(r.beat[4], 'the invulnerable beat between phases does not').toBe(5);
    expect(r.off[4]).toBe(5);
    expect(r.submerged, 'a submerged boss is not there to touch').toBe(5);
  });

  test('BOS-48 the ground-bound bosses keep their distance while idle, so they do not walk into a player who stands still', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('colossus');
      const out = {};
      for (const type of ['grinmaw', 'warden', 'bramblehide', 'colossus']) {
        T.prepBoss(type, 1); raidContactDamage = true; raidLocal.health = 5; raidG.boss.attackTimer = 99999;
        let minGap = 1e9, hurt = 0;
        for (let f = 0; f < 1500; f++) {
          T.place(150, undefined, { invincible: 0, health: 5 });
          T.step(1);
          minGap = Math.min(minGap, Math.abs(raidG.boss.x - 150));
          if (T.me().health < 5) hurt++;
        }
        out[type] = { minGap: Math.round(minGap), hurt };
      }
      return out;
    });
    for (const b of ['grinmaw', 'warden', 'bramblehide', 'colossus']) {
      expect(r[b].hurt, b + ' never touched a player standing on the floor').toBe(0);
      expect(r[b].minGap, b + ' keeps a stride away').toBeGreaterThan(120);
    }
  });
});

test.describe('The slash is long (WPN-10)', () => {
  test('WPN-10 the slash reaches about 170 px, so a player can hit a boss from beyond touching distance', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('colossus');
      T.prepBoss('colossus', 1); raidContactDamage = true;
      const edge = BOSS_HURT.colossus.bounds.x0; // the golem's left edge (negative)
      raidG.boss.x = 500; raidG.boss.y = raidGROUND_Y - BOSS_HURT.colossus.bounds.y1;
      // stand 40 px clear of its left edge, facing it, and swing
      const px = 500 + edge - 9 - 40;
      T.place(px); raidLocal.facing = 1; raidLocal.swingDir = 'right';
      const p = Object.assign({}, raidLocal, { x: px - 18, y: raidGROUND_Y - 48, facing: 1, swingDir: 'right' });
      const out = { touching: raidBodyTouchesBoss(p, raidG.boss), reaches: raidSwingHitsBoss(p, raidG.boss) };
      const poly = raidSlashWorldPoly(p, 0.43);
      out.reach = Math.max(...poly.map((q) => q[0])) - (px);
      // further back still (230 px clear) the slash does not reach
      const far = Object.assign({}, p, { x: 500 + edge - 9 - 230 - 18 });
      out.farReaches = raidSwingHitsBoss(far, raidG.boss);
      return out;
    });
    expect(r.touching, 'not touching it').toBe(false);
    expect(r.reaches, 'but the slash reaches it').toBe(true);
    expect(r.reach, 'about 170 px out from the body').toBeGreaterThan(150);
    expect(r.farReaches, 'there is still a limit').toBe(false);
  });
});

test.describe('A floatier jump (RAI-17)', () => {
  test('RAI-17 the jump reaches the same height as before but takes longer to get there, and falls slower', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const jump = (hold) => {
        T.place(500); raidLocal.onGround = true; raidLocal.jumpBoosting = false; raidLocal.jumpHoldTimer = 0;
        const groundY = raidLocal.y; let minY = groundY, apexFrame = 0, maxFall = 0, frames = 0, landed = false;
        raidLocal.input.jump = true;
        for (let i = 0; i < 200; i++) {
          if (i >= hold) raidLocal.input.jump = false;
          raidUpdateLocal(); frames++;
          if (raidLocal.y < minY) { minY = raidLocal.y; apexFrame = i; }
          maxFall = Math.max(maxFall, raidLocal.vy);
          if (i > 3 && raidLocal.y === groundY) { landed = true; break; }
        }
        return { height: Math.round(groundY - minY), apexFrame, maxFall: Math.round(maxFall * 100) / 100, airFrames: frames, landed };
      };
      return { tap: jump(1), hold: jump(60) };
    });
    expect(r.tap.height, 'a tap still rises about 120 px').toBeGreaterThan(108);
    expect(r.tap.height).toBeLessThan(128);
    expect(r.hold.height, 'a held jump still about 170 px').toBeGreaterThan(155);
    expect(r.hold.height).toBeLessThan(190);
    expect(r.tap.apexFrame, 'but it takes longer to reach the top (it used to be 31 frames)').toBeGreaterThanOrEqual(38);
    expect(r.tap.maxFall, 'and it comes down more slowly (it used to hit 7.7)').toBeLessThan(6.2);
    expect(r.tap.airFrames, 'so it is in the air for longer (it used to be about 62 frames)').toBeGreaterThanOrEqual(78);
    expect(r.tap.landed && r.hold.landed).toBe(true);
  });
});
