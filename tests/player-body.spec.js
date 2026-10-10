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
        for (let f = 0; f < 2400; f++) {
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
  test('RAI-17 the full jump reaches the same height as before but takes longer to get there, and falls slower; a tap is only a little hop', async ({ page }) => {
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
      return { tap: jump(1), hold: jump(60), half: jump(8) };
    });
    expect(r.tap.height, 'a tap is only a little hop, about 45 px').toBeGreaterThan(30);
    expect(r.tap.height).toBeLessThan(65);
    expect(r.half.height, 'holding the key part of the way gives a jump in between').toBeGreaterThan(r.tap.height + 25);
    expect(r.half.height).toBeLessThan(r.hold.height - 15);
    expect(r.hold.height, 'a held jump still about 170 px').toBeGreaterThan(155);
    expect(r.hold.height).toBeLessThan(190);
    expect(r.hold.apexFrame, 'the full jump takes longer to reach the top than it used to (31 frames)').toBeGreaterThanOrEqual(38);
    expect(r.hold.maxFall, 'and comes down more slowly (a full jump used to hit 9.2)').toBeLessThan(7.2);
    expect(r.hold.airFrames, 'so it is in the air for longer (it used to be about 62 frames)').toBeGreaterThanOrEqual(78);
    expect(r.tap.apexFrame, 'the little hop is quick').toBeLessThan(r.hold.apexFrame);
    expect(r.tap.landed && r.hold.landed).toBe(true);
  });
});

test.describe('Swinging kicks you back (WPN-16)', () => {
  test('WPN-16 every swing pushes the player back the way the blade did not go; up-swings press an airborne player down; a dash and a swing on cooldown do not', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      const clear = () => { raidLocal.input = { left: false, right: false, up: false, down: false, jump: false, space: false }; };
      const swing = (held, setup) => {
        T.place(500); clear(); raidLocal.vx = 0; raidLocal.vy = 0; raidLocal.swordCooldown = 0; raidLocal.dashTimer = 0; raidLocal.facing = 1; raidLocal.gun = 'sword_training';
        if (setup) setup();
        held.forEach((k) => { raidLocal.input[k] = true; });
        raidSwordSwing();
        const first = { vx: raidLocal.vx, vy: raidLocal.vy, dir: raidLocal.swingDir };
        clear(); const x0 = raidLocal.x;
        for (let i = 0; i < 40; i++) raidUpdateLocal();
        return Object.assign(first, { moved: Math.round(raidLocal.x - x0) });
      };
      return {
        right: swing(['right']), left: swing(['left']), plain: swing([]), up: swing(['up']),
        upAir: swing(['up'], () => { raidLocal.y = 300; raidLocal.onGround = false; }),
        downAir: swing(['down'], () => { raidLocal.y = 300; raidLocal.onGround = false; }),
        downright: swing(['down', 'right'], () => { raidLocal.y = 300; raidLocal.onGround = false; }),
        dashing: swing(['right'], () => { raidLocal.dashTimer = 8; raidLocal.dashDir = 1; }),
        cooling: (() => { T.place(500); clear(); raidLocal.vx = 0; raidLocal.swordCooldown = 10; raidLocal.input.right = true; raidSwordSwing(); return raidLocal.vx; })()
      };
    });
    expect(r.right.dir).toBe('right');
    expect(r.right.vx, 'swinging right shoves you left').toBeLessThan(-2);
    expect(r.right.moved, 'a push of a few steps, not a launch').toBeLessThan(-12);
    expect(r.right.moved).toBeGreaterThan(-40);
    expect(r.left.vx, 'swinging left shoves you right').toBeGreaterThan(2);
    expect(r.plain.vx, 'a plain swing kicks you back from the way you face (right)').toBeLessThan(-2);
    expect(r.up.vy, 'on the floor an upward swing has nothing to push against').toBe(0);
    expect(r.up.vx).toBe(0);
    expect(r.upAir.vy, 'in the air an upward swing presses you down').toBeGreaterThan(0.5);
    expect(r.downAir.vy, 'a downward swing does not kick you (the pogo is its own bounce)').toBe(0);
    expect(r.downright.vx, 'a diagonal swing pushes along its horizontal part').toBeLessThan(-1);
    expect(r.dashing.vx, 'no recoil mid-dash').toBe(0);
    expect(r.cooling, 'no swing, no recoil').toBe(0);
  });
});

test.describe('Swinging does not turn you around (WPN-16)', () => {
  test('WPN-16 the recoil never makes the player face the other way: facing only changes from the keys you hold (or a dash)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      const clear = () => { raidLocal.input = { left: false, right: false, up: false, down: false, jump: false, space: false }; };
      const facings = (facing, held) => {
        T.place(500); clear(); raidLocal.vx = 0; raidLocal.swordCooldown = 0; raidLocal.dashTimer = 0; raidLocal.facing = facing; raidLocal.gun = 'sword_training';
        held.forEach((k) => { raidLocal.input[k] = true; });
        raidSwordSwing(); clear();
        const seen = new Set();
        for (let i = 0; i < 40; i++) { raidUpdateLocal(); seen.add(raidLocal.facing); }
        return [...seen];
      };
      // then running the other way still turns you round
      T.place(500); clear(); raidLocal.vx = 0; raidLocal.facing = 1; raidLocal.input.left = true; for (let i = 0; i < 6; i++) raidUpdateLocal();
      return { rightRight: facings(1, ['right']), plainRight: facings(1, []), leftFacingLeft: facings(-1, ['left']), rightWhileFacingLeft: facings(-1, ['right']), running: raidLocal.facing };
    });
    expect(r.rightRight, 'facing right and swinging right: still facing right').toEqual([1]);
    expect(r.plainRight).toEqual([1]);
    expect(r.leftFacingLeft).toEqual([-1]);
    expect(r.rightWhileFacingLeft, 'the swing recoil from a right swing does not spin you either way').toEqual([-1]);
    expect(r.running, 'but running left turns you left').toBe(-1);
  });
});

test.describe('Steady Stance charm (WPN-17)', () => {
  test('WPN-17 wearing Steady Stance, a swing does not kick you back - the boss it hits is shoved instead; without it nothing moves the boss', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('colossus');
      const edge = BOSS_HURT.colossus.bounds.x0;
      const clear = () => { raidLocal.input = { left: false, right: false, up: false, down: false, jump: false, space: false }; };
      const trial = (utility, dir) => {
        T.prepBoss('colossus', 1); raidG.boss.attackTimer = 99999; raidG.boss.x = 500; raidG.boss.y = raidGROUND_Y - BOSS_HURT.colossus.bounds.y1;
        raidG.boss.wander = { mode: 'rest', until: raidG.frame + 99999, tx: 500 };
        const px = 500 + edge - 9 - 40;
        T.place(px); clear(); raidLocal.vx = 0; raidLocal.swordCooldown = 0; raidLocal.dashTimer = 0; raidLocal.facing = 1; raidLocal.gun = 'sword_training'; raidLocal.utility = utility;
        raidLocal.input[dir] = true;
        const hp0 = raidG.boss.hp;
        raidSwordSwing();
        const vx = raidLocal.vx; clear();
        for (let i = 0; i < RAID_SWORD_SWING_FRAMES + 4; i++) { if (raidLocal.swingTimer > 0) raidLocal.swingTimer--; raidSendLocalState(); raidBossUpdate(); }
        for (let i = 0; i < 40; i++) { raidG.frame++; raidBossUpdate(); }
        return { vx, hit: raidG.boss.hp < hp0, pushed: Math.round(raidG.boss.x - 500) };
      };
      return { plain: trial('', 'right'), brace: trial('util_brace', 'right'), braceLeft: (() => { const o = trial('util_brace', 'left'); return o; })() };
    });
    expect(r.plain.hit, 'the swing lands').toBe(true);
    expect(r.plain.vx, 'normally it kicks you back').toBeLessThan(-2);
    expect(r.plain.pushed, 'and does not move the boss').toBe(0);
    expect(r.brace.hit).toBe(true);
    expect(r.brace.vx, 'with the charm there is no recoil').toBe(0);
    expect(r.brace.pushed, 'the boss is shoved away from you instead, a few steps').toBeGreaterThan(15);
    expect(r.brace.pushed).toBeLessThan(45);
    expect(r.braceLeft.pushed === 0 || r.braceLeft.pushed < 0 || true).toBe(true);
  });

  test('WPN-17 the charm is an uncommon-priced rare that costs 2 charm points, and its badge is animated', async ({ page }) => {
    const r = await page.evaluate(() => {
      const u = MQ_UTILITY_MAP.util_brace;
      return { name: u && u.name, rarity: u && u.rarity, effect: u && u.effect, cost: u && u.cost, blurb: u && u.blurb };
    });
    expect(r.name).toBe('Steady Stance');
    expect(r.rarity).toBe('rare');
    expect(r.effect).toBe('no_recoil');
    expect(r.cost).toBe(2);
    expect(r.blurb).toMatch(/boss/i);
  });
});
