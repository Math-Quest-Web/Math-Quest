// Spec sections 8 and 10.1: multiplayer model, player mechanics, difficulty, math-off, coin rewards.
// Frames are stepped by hand (window.T) so every test is deterministic.
const { test, expect } = require('./support/fixtures');

const keyDown = (page, key) => page.evaluate((k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k })), key);
const keyUp = (page, key) => page.evaluate((k) => document.dispatchEvent(new KeyboardEvent('keyup', { key: k })), key);

test.describe('Multiplayer model (spec 8.1)', () => {
  test('RAI-01 the lowest player id is host; only the host simulates and publishes the boss', async ({ page }) => {
    await page.evaluate(() => T.setupRaid('grinmaw'));

    // election: a player id that sorts first wins; when it leaves, we become host
    let r = await page.evaluate(async () => {
      await raidPlayerRef.child('a_first').set({ x: 1, y: 1, health: 5 });
      raidIsHost = false; raidCheckHost(); await new Promise((r) => setTimeout(r, 20));
      const withEarlier = raidIsHost;
      await raidPlayerRef.child('a_first').remove();
      raidCheckHost(); await new Promise((r) => setTimeout(r, 20));
      return { withEarlier, afterLeave: raidIsHost };
    });
    expect(r).toEqual({ withEarlier: false, afterLeave: true });

    // a non-host neither simulates nor writes boss state
    r = await page.evaluate(() => {
      T.prepBoss('grinmaw', 1);
      raidG.boss.attackTimer = 1;
      raidIsHost = false;
      __fb.db.log.length = 0;
      raidBossUpdate(); raidSendBossState();
      return { attackTimer: raidG.boss.attackTimer, anim: raidG.boss.anim.state, writes: __fb.db.log.filter((l) => l.path.includes('gameState')).length };
    });
    expect(r).toEqual({ attackTimer: 1, anim: 'idle', writes: 0 });

    // the host publishes the boss (including its animation) to gameState
    r = await page.evaluate(() => {
      raidIsHost = true; T.prepBoss('warden', 1); raidG.boss.hp = 77; raidG.boss.anim = { state: 'fade', timer: 3 };
      raidSendBossState();
      const gs = __fb.db.get('bossRaid/9001/gameState');
      return { hp: gs.boss.hp, type: gs.boss.type, anim: gs.boss.anim.state, has: ['projectiles', 'hazards', 'gameOver', 'victory', 'lastUpdate'].filter((k) => k in gs || gs[k] === undefined).length };
    });
    expect(r.hp).toBe(77);
    expect(r.type).toBe('warden');
    expect(r.anim).toBe('fade');

    // a client renders whatever the host published
    r = await page.evaluate(async () => {
      raidIsHost = false;
      const boss = Object.assign({}, raidG.boss, { hp: 42, phase: 2 });
      await raidGameStateRef.update({ boss: boss, lastUpdate: Date.now() + 5000, gameOver: false, victory: false });
      return { hp: raidG.boss.hp, phase: raidG.boss.phase };
    });
    expect(r).toEqual({ hp: 42, phase: 2 });
  });

  test('RAI-02 each player publishes position, health, shield, facing, skin and weapon', async ({ page }) => {
    const p = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      mqProfile.equipped.skin = 'skin_wizard'; mqProfile.owned.skin_wizard = 1;
      raidLocal.skin = 'skin_wizard'; raidLocal.gun = 'sword_frost';
      raidLocal.x = 321; raidLocal.y = 400; raidLocal.facing = -1; raidLocal.shield = true;
      raidSendLocalState();
      return __fb.db.get('bossRaid/9001/players/' + raidMyId);
    });
    expect(Object.keys(p)).toEqual(expect.arrayContaining(['x', 'y', 'health', 'shield', 'invincible', 'facing', 'skin', 'gun', 'lastUpdate']));
    expect(p).toMatchObject({ x: 321, y: 400, health: 5, shield: true, facing: -1, skin: 'skin_wizard', gun: 'sword_frost' });
    expect(p, 'guns, ammo and reloading are gone').not.toHaveProperty('reload');
  });

  test('RAI-05 hit checks use the player centre and remote players are drawn where they really are', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      const out = { px: raidPx({ x: 282 }), airborneGround: raidAirborne({ y: raidGROUND_Y - 48 }), airborneJump: raidAirborne({ y: raidGROUND_Y - 48 - 60 }) };
      const shot = (x, y) => ({ x, y, vx: 0, vy: 0, r: 10, life: 50, isWarning: false, isBossProjectile: true, owner: 't' });
      // player centre is (300, 476): a shot there hits
      T.place(300);
      raidG.projectiles = [shot(300, 476)]; T.step(1);
      out.hitCentre = T.me().health;
      // the old (wrong) hit point - 18px left and 48px above the centre - must not hit
      T.prepBoss('grinmaw', 1); T.place(300);
      raidG.projectiles = [shot(282, 428)]; T.step(1);
      out.hitOldPoint = T.me().health;

      // remote players are drawn at their stored position (no offset)
      const calls = [];
      const real = window.drawPlayerCuphead;
      window.drawPlayerCuphead = function (ctx, x, y, w, h, facing, hp, mhp, sh, inv, isLocal) { calls.push({ x, y, isLocal }); return real.apply(this, arguments); };
      raidG.players = Object.assign({}, raidG.players, { remote: { x: 600, y: 452, health: 5, facing: 1 } });
      raidDraw();
      window.drawPlayerCuphead = real;
      out.remote = calls.find((c) => !c.isLocal);
      return out;
    });
    expect(r.px).toBe(300);
    expect(r.airborneGround).toBe(false);
    expect(r.airborneJump).toBe(true);
    expect(r.hitCentre).toBe(4);
    expect(r.hitOldPoint).toBe(5);
    expect(r.remote).toEqual({ x: 600, y: 452, isLocal: false });
  });
});

test.describe('Player controls and stats (spec 8.2)', () => {
  test('RAI-10 keyboard: arrows move, Z jumps, Up only aims, Space/X swing, Shift/E shields, C dashes', async ({ page }) => {
    await page.evaluate(() => T.setupRaid('grinmaw'));
    await keyDown(page, 'ArrowLeft'); expect(await page.evaluate(() => raidLocal.input.left)).toBe(true);
    await keyUp(page, 'ArrowLeft'); expect(await page.evaluate(() => raidLocal.input.left)).toBe(false);
    await keyDown(page, 'ArrowRight'); expect(await page.evaluate(() => raidLocal.input.right)).toBe(true);
    await keyUp(page, 'ArrowRight');
    await keyDown(page, 'ArrowUp'); expect(await page.evaluate(() => raidLocal.input.up)).toBe(true);
    expect(await page.evaluate(() => raidLocal.input.jump), 'Up only aims - it is not a jump key').toBe(false);
    await keyUp(page, 'ArrowUp'); expect(await page.evaluate(() => raidLocal.input.up)).toBe(false);
    await keyDown(page, 'z'); expect(await page.evaluate(() => raidLocal.input.jump)).toBe(true);
    expect(await page.evaluate(() => raidLocal.input.up), 'Z only jumps - it does not aim up').toBe(false);
    await keyUp(page, 'z'); expect(await page.evaluate(() => raidLocal.input.jump)).toBe(false);

    await keyDown(page, ' '); // Space swings the sword
    expect(await page.evaluate(() => raidLocal.swingTimer)).toBe(await page.evaluate(() => RAID_SWORD_SWING_FRAMES));
    await page.evaluate(() => { raidLocal.swordCooldown = 0; raidLocal.swingTimer = 0; });
    await keyDown(page, 'x'); // Hollow Knight-style "attack" key swings it too
    expect(await page.evaluate(() => raidLocal.swingTimer)).toBe(await page.evaluate(() => RAID_SWORD_SWING_FRAMES));
    await keyDown(page, 'e');
    expect(await page.evaluate(() => raidLocal.shield)).toBe(true);
    await page.evaluate(() => { raidLocal.shield = false; });
    await keyDown(page, 'Shift');
    expect(await page.evaluate(() => raidLocal.shield)).toBe(true);
    await keyDown(page, 'c'); // Hollow Knight-style dash key (X is "attack" now, not dash)
    expect(await page.evaluate(() => raidLocal.dashCooldown)).toBe(180);
    await keyDown(page, 'x'); // attack, not dash, while X means attack
    expect(await page.evaluate(() => raidLocal.dashCooldown)).toBe(180); // unchanged - X never dashes
    await keyDown(page, 'r'); // there is no reload key any more
    expect(await page.evaluate(() => typeof raidStartReload)).toBe('undefined');
  });

  test('RAI-10 holding Up never makes the player jump - it only aims the swing upward', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.gun = 'sword_training';
      T.place(500);
      raidLocal.onGround = true; raidLocal.vy = 0;
      const groundY = raidLocal.y;
      // Up held on the ground: nothing happens
      raidLocal.input.up = true;
      let lifted = false;
      for (let i = 0; i < 20; i++) { raidUpdateLocal(); if (raidLocal.y < groundY - 1 || raidLocal.vy < 0) lifted = true; }
      // ...and Up still aims the swing upward without leaving the ground
      raidLocal.swordCooldown = 0;
      raidSwordSwing();
      const aimsUp = raidLocal.swingDir === 'up';
      raidUpdateLocal();
      const stayedGrounded = raidLocal.onGround === true && raidLocal.y === groundY;
      raidLocal.input.up = false;
      // Up in the air does not spend Second Wind's extra jump either
      raidLocal.utility = 'util_double';
      T.place(500, raidGROUND_Y - 48 - 120);
      raidLocal.onGround = false; raidLocal.vy = 2; raidLocal.airJumpsUsed = 0;
      raidLocal.input.up = true; raidLocal.wasUpPressed = false; raidLocal.wasJumpPressed = false;
      raidUpdateLocal();
      const noAirJump = raidLocal.vy > 0 && raidLocal.airJumpsUsed === 0;
      raidLocal.input.up = false;
      // the jump key still jumps, and Up held at the same time still aims up
      T.place(500); raidLocal.onGround = true; raidLocal.vy = 0; raidLocal.utility = null;
      raidLocal.input.jump = true; raidUpdateLocal();
      const jumpKeyJumps = raidLocal.vy < 0;
      raidLocal.input.jump = false;
      return { lifted, aimsUp, stayedGrounded, noAirJump, jumpKeyJumps };
    });
    expect(r.lifted, 'Up alone never lifts the player off the ground').toBe(false);
    expect(r.aimsUp, 'Up still aims the sword upward').toBe(true);
    expect(r.stayedGrounded, 'and swinging upward does not jump either').toBe(true);
    expect(r.noAirJump, 'Up does not trigger the double jump').toBe(true);
    expect(r.jumpKeyJumps, 'the jump key (Z) is what jumps').toBe(true);
  });

  test('RAI-11 five hearts, 30 frames of invincibility after a hit, defeat when a player reaches zero', async ({ page }) => {
    const out = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const o = { start: raidLocal.health, defeatedAfter: [] };
      raidDamagePlayer(raidMyId, T.me(), 1);
      o.afterHit = T.me().health; o.invincible = T.me().invincible; o.defeatedAfter.push(raidG.gameOver);
      raidDamagePlayer(raidMyId, T.me(), 1); // ignored while invincible
      o.afterSecond = T.me().health;
      for (let i = 0; i < 4; i++) { T.place(500, undefined, { invincible: 0 }); raidDamagePlayer(raidMyId, T.me(), 1); o.defeatedAfter.push(raidG.gameOver); }
      return o;
    });
    expect(out.start).toBe(5);
    expect(out.afterHit).toBe(4);
    expect(out.invincible).toBe(30);
    expect(out.afterSecond).toBe(4);
    // hits 1-4 leave the raid running; the fifth hit (5 hearts gone) is a defeat
    expect(out.defeatedAfter).toEqual([false, false, false, false, true]);
  });

  test('RAI-11 raidDamagePlayer marks its player object invincible synchronously, not only via the async Firebase write', async ({ page }) => {
    // Regression test: raidDamagePlayer used to only fire an async raidPlayerRef.update(...)
    // and never mutate the `p` object it was handed. Two damage sources resolved in the same
    // synchronous pass (e.g. a hazard and a boss projectile overlapping the same player in one
    // raidBossUpdate() call) would each see invincible===0 and both land, because the guard at
    // the top of the function only reflects reality once the Firebase round-trip completes -
    // which, on the real (non-stub) SDK, is never within the same synchronous turn.
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const p = { health: 5, invincible: 0, shield: false, wardUsed: false };
      raidDamagePlayer(raidMyId, p, 1);
      const afterFirst = { health: p.health, invincible: p.invincible };
      raidDamagePlayer(raidMyId, p, 1); // same object, called before any round-trip could land
      const afterSecond = { health: p.health, invincible: p.invincible };

      // the ward branch must be synchronous too
      const w = { health: 5, invincible: 0, shield: false, utility: 'util_ward', wardUsed: false };
      raidDamagePlayer(raidMyId, w, 1);
      const wardAfterFirst = { health: w.health, wardUsed: w.wardUsed, invincible: w.invincible };
      raidDamagePlayer(raidMyId, w, 1); // ward already used, invincible should still block this
      const wardAfterSecond = { health: w.health };
      return { afterFirst, afterSecond, wardAfterFirst, wardAfterSecond };
    });
    expect(r.afterFirst).toEqual({ health: 4, invincible: 30 });
    expect(r.afterSecond).toEqual({ health: 4, invincible: 30 });
    expect(r.wardAfterFirst).toEqual({ health: 5, wardUsed: true, invincible: 30 });
    expect(r.wardAfterSecond).toEqual({ health: 5 });
  });

  test('RAI-15 shield blocks for 90 frames; starts with 2 charges (max 3) and recharges every 7 seconds', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = { start: raidMathShieldCharges, max: raidMaxShieldCharges, regen: RAID_SHIELD_REGEN_FRAMES };
      raidShieldRegenTimer = 0; // setupRaid already ran one frame; start the recharge clock at 0
      raidTryShield();
      out.charges = raidMathShieldCharges; out.shield = raidLocal.shield; out.timer = raidLocal.shieldTimer;
      // while shielded, damage is blocked
      raidDamagePlayer(raidMyId, Object.assign({}, T.me(), { shield: raidLocal.shield, invincible: 0 }), 1);
      raidLocal.input = { left: false, right: false, up: false, space: false };
      for (let i = 0; i < 90; i++) raidUpdateLocal();
      out.shieldOff = raidLocal.shield;
      // charge regen: 1 -> 2 after 420 frames -> 3, then capped
      out.regen1 = raidMathShieldCharges;
      for (let i = 0; i < 329; i++) raidUpdateLocal(); // 90 + 329 = 419 frames since the charge was spent
      out.beforeRegen = raidMathShieldCharges;
      raidUpdateLocal();
      out.afterRegen = raidMathShieldCharges;
      for (let i = 0; i < 1000; i++) raidUpdateLocal();
      out.capped = raidMathShieldCharges;
      // no charges: pressing shield does nothing (no math prompt any more)
      raidMathShieldCharges = 0; raidTryShield();
      out.emptyShield = raidLocal.shield; out.mathUi = raidShowMathUI;
      return out;
    });
    expect(r.start).toBe(2);
    expect(r.max).toBe(3);
    expect(r.regen).toBe(420);
    expect(r.charges).toBe(1);
    expect(r.shield).toBe(true);
    expect(r.timer).toBe(90);
    expect(r.shieldOff).toBe(false);
    expect(r.beforeRegen).toBe(1);
    expect(r.afterRegen).toBe(2);
    expect(r.capped).toBe(3);
    expect(r.emptyShield).toBe(false);
    expect(r.mathUi).toBe(false);
  });

  test('RAI-16 dash: burst of speed, 14 invincible frames, 180-frame cooldown', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.facing = 1;
      raidTryDash();
      const out = { cooldown: raidLocal.dashCooldown, invincible: raidLocal.invincible, vx: raidLocal.vx, dashSpeed: RAID_DASH_SPEED };
      raidLocal.vx = 0; raidTryDash(); out.secondBlocked = raidLocal.vx === 0;
      for (let i = 0; i < 179; i++) raidUpdateLocal();
      out.almost = raidLocal.dashCooldown;
      raidUpdateLocal();
      out.ready = raidLocal.dashCooldown; out.hud = (raidUpdateUI(), document.getElementById('raidDashState').textContent);
      return out;
    });
    expect(r).toEqual({ cooldown: 180, invincible: 14, vx: r.dashSpeed, dashSpeed: r.dashSpeed, secondBlocked: true, almost: 1, ready: 0, hud: 'READY' });
    expect(r.dashSpeed, 'the dash is faster than the old 12 px/frame').toBeGreaterThan(12);
  });

  test('RAI-16 the dash burst is not immediately undone by the normal running speed cap, and leaves a trail', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.facing = 1;
      raidLocal.input = { left: false, right: false, up: false, space: false };
      raidTryDash();
      const vxDuringDash = [];
      for (let i = 0; i < RAID_DASH_FRAMES; i++) { vxDuringDash.push(raidLocal.vx); raidUpdateLocal(); }
      const trailDuringDash = raidLocal.trail.length;
      const vxAfterDash = raidLocal.vx;
      for (let i = 0; i < 5; i++) raidUpdateLocal();
      return { vxDuringDash, trailDuringDash, vxAfterDash, vxSettled: raidLocal.vx, dashSpeed: RAID_DASH_SPEED };
    });
    // every frame of the dash keeps the full burst speed - not clamped back to the run cap of 7
    expect(r.vxDuringDash.every((v) => v === r.dashSpeed)).toBe(true);
    expect(r.trailDuringDash).toBeGreaterThan(0);
    expect(r.vxAfterDash).toBe(r.dashSpeed);
    expect(Math.abs(r.vxSettled)).toBeLessThanOrEqual(7); // back under normal control once the dash ends
  });

  test('RAI-16 a dash keeps your height - no gravity while it lasts - and carries a little farther than before', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.facing = 1;
      raidLocal.input = { left: false, right: false, up: false, down: false, jump: false, space: false };

      // airborne and falling: the dash holds the exact height for its whole length
      T.place(300, raidGROUND_Y - 48 - 90);
      raidLocal.onGround = false; raidLocal.vy = 5; raidLocal.dashCooldown = 0;
      const y0 = raidLocal.y, x0 = raidLocal.x;
      raidTryDash();
      const ys = [];
      for (let i = 0; i < RAID_DASH_FRAMES; i++) { raidUpdateLocal(); ys.push(raidLocal.y); }
      const heldHeight = ys.every((y) => y === y0);
      const vyDuring = raidLocal.vy;
      const distance = raidLocal.x - x0;
      raidUpdateLocal(); raidUpdateLocal();
      const fallsAgainAfter = raidLocal.y > y0;

      // grounded: stays grounded the whole dash (not flickering airborne)
      T.place(300);
      raidLocal.onGround = true; raidLocal.vy = 0; raidLocal.dashCooldown = 0;
      raidTryDash();
      const groundedStates = [];
      for (let i = 0; i < RAID_DASH_FRAMES; i++) { raidUpdateLocal(); groundedStates.push(raidLocal.onGround); }

      // the jump key does nothing mid-dash (it would be zeroed next frame anyway)
      T.place(300);
      raidLocal.onGround = true; raidLocal.vy = 0; raidLocal.dashCooldown = 0;
      raidTryDash();
      raidLocal.input.jump = true; raidUpdateLocal(); raidLocal.input.jump = false;
      const noJumpMidDash = raidLocal.vy === 0 && raidLocal.y === raidGROUND_Y - 48;
      return { heldHeight, vyDuring, distance, fallsAgainAfter, groundedAll: groundedStates.every((g) => g === true), noJumpMidDash };
    });
    expect(r.heldHeight, 'gravity does not move you during a dash').toBe(true);
    expect(r.vyDuring).toBe(0);
    expect(r.distance, 'a little farther than the old 120 px dash').toBeGreaterThan(135);
    expect(r.distance).toBeLessThan(190);
    expect(r.fallsAgainAfter, 'gravity takes over again once the dash ends').toBe(true);
    expect(r.groundedAll, 'a grounded dash never counts as airborne').toBe(true);
    expect(r.noJumpMidDash).toBe(true);
  });

  test('RAI-17 running tops out near 3 px/frame and a tap jump rises about 100 px', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.place(100);
      let maxV = 0;
      raidLocal.input.right = true;
      for (let i = 0; i < 100; i++) { raidUpdateLocal(); maxV = Math.max(maxV, Math.abs(raidLocal.vx)); }
      raidLocal.input.right = false;
      T.place(500); raidLocal.onGround = true;
      const groundY = raidLocal.y;
      raidLocal.input.jump = true; raidUpdateLocal(); raidLocal.input.jump = false;
      let minY = raidLocal.y;
      for (let i = 0; i < 120; i++) { raidUpdateLocal(); minY = Math.min(minY, raidLocal.y); }
      return { maxV, rise: groundY - minY, backOnGround: raidLocal.y === groundY };
    });
    expect(r.maxV, 'a bit slower than the old ~4 px/frame').toBeLessThan(3.6);
    expect(r.maxV).toBeGreaterThan(2.5);
    expect(r.rise, 'much lower than the old ~210 px jump').toBeGreaterThan(85);
    expect(r.rise).toBeLessThan(125);
    expect(r.backOnGround).toBe(true);
  });

  test('RAI-17 holding the jump key rises higher than a quick tap (variable-height jump)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const jump = (holdFrames) => {
        T.place(500);
        raidLocal.onGround = true;
        raidLocal.jumpBoosting = false;
        raidLocal.jumpHoldTimer = 0;
        const groundY = raidLocal.y;
        raidLocal.input.jump = true;
        let minY = groundY;
        for (let i = 0; i < holdFrames; i++) { raidUpdateLocal(); minY = Math.min(minY, raidLocal.y); }
        raidLocal.input.jump = false;
        for (let i = 0; i < 150; i++) { raidUpdateLocal(); minY = Math.min(minY, raidLocal.y); }
        return groundY - minY;
      };
      return {
        tap: jump(1),
        fullHold: jump(30),
        constants: { grav: RAID_GRAVITY, vy: RAID_JUMP_VY, holdGrav: RAID_JUMP_HOLD_GRAVITY, holdFrames: RAID_JUMP_HOLD_FRAMES }
      };
    });
    // the same height as before (0.25 / -7.7 / 0.1 / 12 frames), reached 25% more slowly
    expect(r.constants.grav).toBeCloseTo(0.25 * 0.5625, 6);
    expect(r.constants.vy).toBeCloseTo(-7.7 * 0.75, 6);
    expect(r.constants.holdGrav).toBeCloseTo(0.1 * 0.5625, 6);
    expect(r.constants.holdFrames).toBe(16);
    expect(r.tap).toBeGreaterThan(85);
    expect(r.tap).toBeLessThan(125);
    expect(r.fullHold, 'holding the whole way up still rises beyond a tap').toBeGreaterThan(r.tap + 30);
    expect(r.fullHold, 'but a full jump is still low').toBeLessThan(190);
  });

  test('RAI-18 the boss hit area is the boss silhouette itself: shots hit inside it and miss beside it, so the wide Wyrm is hit at its wing where Grinmaw is not', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('wyrm');
      const out = {};
      // a point in the middle of the widest stored rectangle (inside), and one 25 px past the silhouette (outside)
      // settle the boss into its idle spot, then fire a bolt at (dx, dy) from its centre; the boss then moves a
      // pixel or two on the same update, so inside points are the middle of the widest rectangle
      const settle = (type) => { T.prepBoss(type, 1); T.step(1); raidG.boss.animScale = 1; return raidG.boss; };
      const hitAt = (type, dx, dy) => {
        const b = settle(type);
        const hp0 = b.hp;
        raidG.playerProjectiles = [{ x: b.x + dx, y: b.y + dy, vx: 0, vy: 0, life: 50, damage: 3, r: 6 }];
        raidBossUpdate();
        return hp0 - b.hp;
      };
      for (const type of ['grinmaw', 'warden', 'wyrm', 'glutton', 'bramblehide', 'colossus', 'griffon']) {
        const b = settle(type);
        const rects = raidBossRects(b);
        const widest = rects.reduce((m, q) => (q[2] - q[0] > m[2] - m[0] ? q : m), rects[0]);
        const inside = [(widest[0] + widest[2]) / 2 - b.x, (widest[1] + widest[3]) / 2 - b.y];
        out[type] = { inside: hitAt(type, inside[0], inside[1]), outside: hitAt(type, BOSS_HURT[type].bounds.x1 + 25, 0) };
      }
      // the Wyrm's wing tips are far out; the same spot is empty air beside Grinmaw
      out.wyrmWing = hitAt('wyrm', 90, 20);
      out.grinmawSameSpot = hitAt('grinmaw', 90, 20);
      out.bounds = Object.fromEntries(Object.keys(BOSS_HURT).map((t) => [t, BOSS_HURT[t].bounds]));
      return out;
    });
    for (const t of ['grinmaw', 'warden', 'wyrm', 'glutton', 'bramblehide', 'colossus', 'griffon']) {
      expect(r[t].inside, t + ': a shot inside the silhouette hits').toBe(3);
      expect(r[t].outside, t + ': a shot beside it misses').toBe(0);
    }
    expect(r.wyrmWing, 'the Wyrm is wide enough to be hit at its wing').toBe(3);
    expect(r.grinmawSameSpot, 'where Grinmaw is not').toBe(0);
    expect(r.bounds.wyrm.x1 - r.bounds.wyrm.x0, 'the Wyrm is wider than Grinmaw even at 0.75x').toBeGreaterThan(r.bounds.grinmaw.x1 - r.bounds.grinmaw.x0);
  });

  test('RAI-19 taking a hit knocks the player back, flashes white and briefly freezes the game (hit-stop)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidHitStopTimer = 0;
      raidLocal.facing = 1; raidLocal.vx = 0; raidLocal.vy = 0;
      // as raidDamagePlayer would on the host, but observed the way every client actually finds
      // out - through its own player-list listener - so this also covers non-host players.
      await raidPlayerRef.child(raidMyId).update({ health: 4, invincible: 30 });
      const out = {};
      out.knockedBack = raidLocal.vx < 0; // pushed opposite of facing (+1)
      out.poppedUp = raidLocal.vy < 0;
      out.hitStop = raidHitStopTimer > 0;

      // the bright flash renders during the first ~6 of the 30 invincibility frames
      // (40, 76) sits in the lower torso, comfortably inside the body fill and clear of both
      // the outline stroke and the smaller (WPN-20), feet-anchored head's shadow trail.
      const flashAt = (invincible) => {
        const c = document.createElement('canvas'); c.width = 80; c.height = 100;
        const ctx = c.getContext('2d');
        drawPlayerCuphead(ctx, 20, 40, 36, 48, 1, 4, 5, false, invincible, true, { noBar: true, noShadow: true, noGun: true, t: 0 });
        return ctx.getImageData(40, 76, 1, 1).data;
      };
      const bright = flashAt(28), late = flashAt(10);
      out.veryWhite = bright[0] > 245 && bright[1] > 225 && bright[2] > 225;
      out.laterNotAsWhite = !(late[0] > 245 && late[1] > 225 && late[2] > 225);

      // no reaction on a health increase, or once already dead
      raidHitStopTimer = 0; raidLocal.vx = 0;
      await raidPlayerRef.child(raidMyId).update({ health: 5 });
      out.noReactionOnHeal = raidHitStopTimer === 0 && raidLocal.vx === 0;
      raidLocal.health = 0;
      await raidPlayerRef.child(raidMyId).update({ health: 0 });
      out.noReactionWhenAlreadyDead = raidHitStopTimer === 0 && raidLocal.vx === 0;
      return out;
    });
    expect(r.knockedBack).toBe(true);
    expect(r.poppedUp).toBe(true);
    expect(r.hitStop).toBe(true);
    expect(r.veryWhite).toBe(true);
    expect(r.laterNotAsWhite).toBe(true);
    expect(r.noReactionOnHeal).toBe(true);
    expect(r.noReactionWhenAlreadyDead).toBe(true);
  });

  test('RAI-20 the player bobs and leans while moving on the ground, but holds still in the air', async ({ page }) => {
    const r = await page.evaluate(() => {
      const hash = (look, t) => {
        const c = document.createElement('canvas'); c.width = 80; c.height = 120;
        const ctx = c.getContext('2d');
        drawPlayerCuphead(ctx, 20, 30, 36, 48, 1, 5, 5, false, 0, true, Object.assign({ noBar: true, noShadow: true, t }, look));
        const d = ctx.getImageData(0, 0, 80, 120).data;
        let h = 7; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) % 1000000007;
        return h;
      };
      return {
        idleDiffers: hash({ vx: 0, onGround: true }, 0) !== hash({ vx: 0, onGround: true }, 30),
        runDiffers: hash({ vx: 6, onGround: true }, 0) !== hash({ vx: 6, onGround: true }, 8),
        airborneSame: hash({ vx: 6, onGround: false }, 0) === hash({ vx: 6, onGround: false }, 30)
      };
    });
    expect(r.idleDiffers, 'idle bob still animates over time').toBe(true);
    expect(r.runDiffers, 'running bob/lean animates over time').toBe(true);
    expect(r.airborneSame, 'no bob or lean while airborne').toBe(true);
  });

  test('RAI-21 landing and launching pop a decaying squash-stretch on raidLocal', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};

      // Falling onto the ground triggers a 'land' pop on the landing frame only.
      T.place(500, raidGROUND_Y - 48 - 50);
      raidLocal.onGround = false;
      raidLocal.vy = 5;
      raidLocal.squashKind = null; raidLocal.squashTimer = 0;
      let landedAt = -1;
      for (let i = 0; i < 30 && landedAt < 0; i++) { raidUpdateLocal(); if (raidLocal.onGround) landedAt = i; }
      out.landedKind = raidLocal.squashKind;
      out.landedTimerFull = raidLocal.squashTimer === RAID_SQUASH_FRAMES;
      // it decays back to a falsy kind within RAID_SQUASH_FRAMES more frames
      for (let i = 0; i < RAID_SQUASH_FRAMES; i++) raidUpdateLocal();
      out.decayedTimer = raidLocal.squashTimer;

      // A ground jump pops a 'launch' stretch immediately.
      T.place(500);
      raidLocal.onGround = true;
      raidLocal.jumpBoosting = false;
      raidLocal.squashKind = null; raidLocal.squashTimer = 0;
      raidLocal.input.jump = true;
      raidUpdateLocal();
      raidLocal.input.jump = false;
      out.launchKind = raidLocal.squashKind;
      out.launchTimerFull = raidLocal.squashTimer === RAID_SQUASH_FRAMES;

      // Pure helper checks.
      out.landScale = raidSquashScale('land', RAID_SQUASH_FRAMES);
      out.launchScale = raidSquashScale('launch', RAID_SQUASH_FRAMES);
      out.neutralScale = raidSquashScale(null, 0);
      out.expiredScale = raidSquashScale('land', 0);

      return out;
    });
    expect(r.landedKind).toBe('land');
    expect(r.landedTimerFull).toBe(true);
    expect(r.decayedTimer).toBe(0);
    expect(r.launchKind).toBe('launch');
    expect(r.launchTimerFull).toBe(true);
    expect(r.landScale.sx).toBeGreaterThan(1); // wide
    expect(r.landScale.sy).toBeLessThan(1); // flat
    expect(r.launchScale.sx).toBeLessThan(1); // thin
    expect(r.launchScale.sy).toBeGreaterThan(1); // tall
    expect(r.neutralScale).toEqual({ sx: 1, sy: 1 });
    expect(r.expiredScale).toEqual({ sx: 1, sy: 1 });
  });

  test('RAI-21 air-pose lean reacts to vertical speed, and swing follow-through leans the body toward the swing', async ({ page }) => {
    const r = await page.evaluate(() => {
      return {
        risingLeansBack: raidAirLean(-15) < 0,
        fallingLeansForward: raidAirLean(15) > 0,
        apexNeutral: raidAirLean(0) === 0,
        clamped: raidAirLean(-999) === raidAirLean(-15) && raidAirLean(999) === raidAirLean(15),
        noSwingNoLean: raidSwingBodyLean('right', 0, 1) === 0,
        rightLeansPositive: raidSwingBodyLean('right', 0.5, 1) > 0,
        leftLeansNegative: raidSwingBodyLean('left', 0.5, 1) < 0,
        upNoHorizontalLean: raidSwingBodyLean('up', 0.5, 1) === 0,
        sideFollowsFacing: raidSwingBodyLean('side', 0.5, -1) < 0 && raidSwingBodyLean('side', 0.5, 1) > 0,
        downrightPositive: raidSwingBodyLean('downright', 0.5, 1) > 0,
        downleftNegative: raidSwingBodyLean('downleft', 0.5, 1) < 0
      };
    });
    expect(r.risingLeansBack).toBe(true);
    expect(r.fallingLeansForward).toBe(true);
    expect(r.apexNeutral).toBe(true);
    expect(r.clamped, 'extreme vy values clamp rather than growing unbounded').toBe(true);
    expect(r.noSwingNoLean).toBe(true);
    expect(r.rightLeansPositive).toBe(true);
    expect(r.leftLeansNegative).toBe(true);
    expect(r.upNoHorizontalLean).toBe(true);
    expect(r.sideFollowsFacing).toBe(true);
    expect(r.downrightPositive).toBe(true);
    expect(r.downleftNegative).toBe(true);
  });

  test('RAI-21 dash afterimages replay the real motion pose (vx/onGround/swingDir/swing) instead of a forced idle stance', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.gun = 'sword_training';
      T.place(500, 200); // airborne
      raidLocal.onGround = false;
      raidLocal.swordCooldown = 0;
      raidLocal.input = { left: false, right: false, up: false, down: true, space: false };
      raidSwordSwing(); // swingDir 'down', swingTimer counting down
      raidLocal.input.down = false;
      raidLocal.facing = 1;
      raidTryDash();
      // A few dash frames, so the swing has some real progress by the time a ghost is captured
      // (the very first frame after raidSwordSwing() still reads swingTimer at its full value,
      // since the decrement for this frame hasn't run yet at push time).
      raidUpdateLocal(); raidUpdateLocal(); raidUpdateLocal();
      const g = raidLocal.trail[raidLocal.trail.length - 1];
      return {
        capturedVx: g.vx, capturedOnGround: g.onGround, capturedSwingDir: g.swingDir,
        capturedSwingIsProgress: g.swing > 0 && g.swing < 1,
        matchesLiveVx: g.vx === raidLocal.vx, matchesLiveOnGround: g.onGround === raidLocal.onGround
      };
    });
    expect(r.capturedVx).not.toBe(0);
    expect(r.capturedOnGround).toBe(false);
    expect(r.capturedSwingDir).toBe('down');
    expect(r.capturedSwingIsProgress, 'captures the swing progress, not just whether it is swinging').toBe(true);
    expect(r.matchesLiveVx).toBe(true);
    expect(r.matchesLiveOnGround).toBe(true);
  });

  test('RAI-22 a sword swing has an attack pose: anticipation pulls back, the strike lunges toward the swing, recovery settles', async ({ page }) => {
    const r = await page.evaluate(() => {
      const idle = raidAttackPose('right', 0, 1);
      const windup = raidAttackPose('right', 0.1, 1);
      const strike = raidAttackPose('right', 0.4, 1);
      const recovered = raidAttackPose('right', 0.999, 1);
      const leftStrike = raidAttackPose('left', 0.4, 1);
      const upStrike = raidAttackPose('up', 0.55, 1); // peak of the lunge
      const sideFacingLeft = raidAttackPose('side', 0.4, -1);
      const hash = (swing) => {
        const c = document.createElement('canvas'); c.width = 80; c.height = 120;
        const ctx = c.getContext('2d');
        drawPlayerCuphead(ctx, 20, 30, 36, 48, 1, 5, 5, false, 0, true, { noBar: true, noShadow: true, noGun: true, t: 0, swing, swingDir: 'right' });
        const d = ctx.getImageData(0, 0, 80, 120).data;
        let h = 7; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) % 1000000007;
        return h;
      };
      return {
        idle, windupDx: windup.dx, windupSy: windup.sy, strikeDx: strike.dx, recoveredDx: recovered.dx,
        leftStrikeDx: leftStrike.dx, upStrikeDy: upStrike.dy, upStrikeSy: upStrike.sy, sideFacingLeftDx: sideFacingLeft.dx,
        posesDiffer: hash(0.1) !== hash(0.4) && hash(0.4) !== hash(0.8)
      };
    });
    expect(r.idle).toEqual({ dx: 0, dy: 0, rot: 0, sx: 1, sy: 1 });
    expect(r.windupDx, 'anticipation pulls back away from the swing').toBeLessThan(0);
    expect(r.windupSy, 'anticipation crouches').toBeLessThan(1);
    expect(r.strikeDx, 'the strike lunges toward the swing').toBeGreaterThan(0);
    expect(Math.abs(r.recoveredDx), 'recovery settles back to neutral').toBeLessThan(0.5);
    expect(r.leftStrikeDx, 'absolute direction: a left swing lunges left').toBeLessThan(0);
    expect(r.upStrikeDy, 'an up swing lunges up').toBeLessThan(0);
    expect(r.upStrikeSy, 'an up swing stretches tall').toBeGreaterThan(1);
    expect(r.sideFacingLeftDx, 'the default swing follows facing').toBeLessThan(0);
    expect(r.posesDiffer, 'the body is drawn differently at each phase of the swing').toBe(true);
  });

  test('RAI-23 taking a hit plays a hurt pose (recoil, tilt, squash) that eases out, and the local player gets a hit burst', async ({ page }) => {
    const r = await page.evaluate(() => {
      const none = raidHurtPose(0, 1);
      const dashing = raidHurtPose(21, 1); // dash i-frames are not a hurt pose
      const impact = raidHurtPose(30, 1);
      const easing = raidHurtPose(26, 1);
      const flipped = raidHurtPose(30, -1);
      const hash = (invincible) => {
        const c = document.createElement('canvas'); c.width = 80; c.height = 120;
        const ctx = c.getContext('2d');
        drawPlayerCuphead(ctx, 20, 30, 36, 48, 1, 5, 5, false, invincible, true, { noBar: true, noShadow: true, noGun: true, t: 0 });
        const d = ctx.getImageData(0, 0, 80, 120).data;
        let h = 7; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) % 1000000007;
        return h;
      };
      // the hit burst: spawned when the local health drops, expires after its own lifetime
      raidFx.lastHealth = 5; raidFx.bursts = [];
      raidLocal.health = 5; raidFxTick();
      const before = raidFx.bursts.length;
      raidLocal.health = 4; raidFxTick();
      const spawned = raidFx.bursts.length;
      for (let i = 0; i < 20; i++) raidFxTick();
      const expired = raidFx.bursts.length;
      raidLocal.health = 5; raidFx.lastHealth = 5;
      return {
        none, dashing, impactRot: impact.rot, impactDx: impact.dx, impactSy: impact.sy, easingRot: easing.rot,
        flippedRot: flipped.rot, poseDrawn: hash(23) !== hash(0), before, spawned, expired
      };
    });
    expect(r.none).toEqual({ dx: 0, rot: 0, sx: 1, sy: 1 });
    expect(r.dashing, 'dash invincibility is not a hurt pose').toEqual({ dx: 0, rot: 0, sx: 1, sy: 1 });
    expect(r.impactRot, 'recoils (tilts back, away from the facing)').toBeLessThan(0);
    expect(r.impactDx).toBeLessThan(0);
    expect(r.impactSy, 'squashes on impact').toBeLessThan(1);
    expect(Math.abs(r.easingRot), 'eases out over the following frames').toBeLessThan(Math.abs(r.impactRot));
    expect(r.flippedRot, 'recoil is mirrored for a left-facing player').toBeGreaterThan(0);
    expect(r.poseDrawn, 'the hurt pose changes how the body is drawn').toBe(true);
    expect(r.before).toBe(0);
    expect(r.spawned, 'a hit burst spawns when the local health drops').toBe(1);
    expect(r.expired, 'the burst expires').toBe(0);
  });
});

test.describe('Equipment: weapons and utility (spec 8.5)', () => {

  test('WPN-01 the weapon slot is always a sword: a fresh save equips the Training Nail, X/Space swings it, and an old gun id falls back safely', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      out.defaultWeapon = mqDefaultProfile().equipped.gun;
      out.defaultOwnedGun = Object.keys(mqDefaultProfile().owned).filter((k) => k.startsWith('gun_'));
      out.noGunItems = MQ_ITEMS.filter((i) => i.type === 'gun' || /^gun_/.test(i.id)).length;
      raidLocal.gun = 'sword_training';
      raidLocal.swordCooldown = 0; raidLocal.swingTimer = 0;
      raidSwordSwing();
      out.swung = raidLocal.swingTimer === RAID_SWORD_SWING_FRAMES;
      // a teammate on an old client may still publish a gun id: it must draw as a sword, not crash
      const c = document.createElement('canvas'); c.width = 120; c.height = 120;
      let drew = true;
      try { drawPlayerCuphead(c.getContext('2d'), 40, 40, 36, 48, 1, 5, 5, false, 0, false, { gun: 'gun_standard', swing: 0.3, noBar: true, noShadow: true }); } catch (e) { drew = false; }
      out.legacyIdDraws = drew;
      // ...and none of the shooting machinery exists any more
      out.gone = ['raidShootProjectile', 'raidStartReload', 'raidAttack', 'raidGunMuzzle', 'drawPlayerBullet', 'mqDrawGun'].filter((n) => typeof window[n] !== 'undefined');
      out.goneState = ['raidAmmo', 'raidMaxAmmo', 'raidReloadTimer', 'raidShotsRef'].filter((n) => { try { return typeof eval(n) !== 'undefined'; } catch (e) { return false; } });
      return out;
    });
    expect(r.defaultWeapon).toBe('sword_training');
    expect(r.defaultOwnedGun).toEqual([]);
    expect(r.noGunItems, 'there are no gun items left').toBe(0);
    expect(r.swung, 'the attack swings the sword').toBe(true);
    expect(r.legacyIdDraws, 'an old gun id from a save or an old client draws as the default sword').toBe(true);
    expect(r.gone, 'no shooting functions remain').toEqual([]);
    expect(r.goneState, 'no ammo/reload/relay state remains').toEqual([]);
  });

  test('WPN-02 a side swing damages the boss only on real hitbox overlap, at most once per swing, and respects its cooldown', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.gun = 'sword_training';
      raidLocal.facing = 1;
      raidLocal.input = { left: false, right: false, up: false, down: false, space: false };

      // Steps the swing to completion without touching raidUpdateLocal's movement/gravity, so
      // the player's placed position stays exact - only swingTimer needs to count down through
      // the "blade extended" window while raidBossUpdate resolves it each frame, same as a live
      // raid (raidSendLocalState syncs raidG.players, raidBossUpdate checks it).
      const stepSwing = (extra = 0) => {
        for (let i = 0; i < RAID_SWORD_SWING_FRAMES + extra; i++) {
          if (raidLocal.swingTimer > 0) raidLocal.swingTimer--;
          raidSendLocalState();
          raidBossUpdate();
        }
      };

      // out of reach: grounded, boss is well overhead
      T.place(500);
      raidLocal.swordCooldown = 0;
      let hpBefore = raidG.boss.hp;
      raidSwordSwing();
      const startedFull = raidLocal.swingTimer === RAID_SWORD_SWING_FRAMES;
      stepSwing();
      const missedHit = raidG.boss.hp === hpBefore;

      // in reach: jump up to the boss's height, swing to the side
      T.place(raidG.boss.x, raidG.boss.y - 24);
      raidLocal.swordCooldown = 0;
      hpBefore = raidG.boss.hp;
      raidSwordSwing();
      stepSwing(4); // keep checking a few frames past the end - must not hit twice
      const connected = raidG.boss.hp === hpBefore - RAID_SWORD_DAMAGE;
      const cooldownSet = raidLocal.swordCooldown === RAID_SWORD_COOLDOWN_FRAMES;

      // cooldown blocks an immediate second swing
      hpBefore = raidG.boss.hp;
      raidSwordSwing();
      stepSwing();
      const secondBlocked = raidG.boss.hp === hpBefore;

      return { startedFull, missedHit, connected, cooldownSet, secondBlocked };
    });
    expect(r.startedFull, 'the swing animation plays even on a miss').toBe(true);
    expect(r.missedHit, 'out of reach deals no damage').toBe(true);
    expect(r.connected, 'in reach deals RAID_SWORD_DAMAGE exactly once').toBe(true);
    expect(r.cooldownSet).toBe(true);
    expect(r.secondBlocked, 'cooldown blocks an immediate second swing').toBe(true);
  });

  test('WPN-05 up and down swings hit in their own direction, not to the side, and the down key is wired', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.gun = 'sword_training';
      raidLocal.facing = 1;
      // Calls raidCheckSwordSwings directly rather than the full raidBossUpdate - that avoids
      // grinmaw's own idle float re-positioning the boss out from under the fixed y values this
      // test places it at, and tests exactly the piece of logic being verified here.
      const stepSwing = () => {
        for (let i = 0; i < RAID_SWORD_SWING_FRAMES; i++) {
          if (raidLocal.swingTimer > 0) raidLocal.swingTimer--;
          raidSendLocalState();
          raidCheckSwordSwings(raidG.boss);
        }
      };

      // Grounded, boss directly overhead (its body bottom close enough for the up slash to reach,
      // far enough that the side slash does not): an up-swing should connect, a plain side swing not.
      raidG.boss.x = 500; raidG.boss.y = 276; // the body spans y 196..400 (grinmaw, BOSS_HURT)
      T.place(500);
      raidLocal.input = { left: false, right: false, up: false, down: false, space: false };
      raidLocal.swordCooldown = 0;
      let hpBefore = raidG.boss.hp;
      raidSwordSwing(); // dir resolves to 'side' since up/down are not held
      stepSwing();
      const sideMissesOverhead = raidG.boss.hp === hpBefore;

      raidLocal.swordCooldown = 0;
      raidLocal.input.up = true;
      hpBefore = raidG.boss.hp;
      raidSwordSwing(); // dir resolves to 'up'
      const dirWasUp = raidLocal.swingDir === 'up';
      raidLocal.input.up = false;
      stepSwing();
      const upConnects = raidG.boss.hp === hpBefore - RAID_SWORD_DAMAGE;

      // Boss below the player (e.g. a ground boss while airborne): a down-swing should connect.
      raidG.boss.y = raidGROUND_Y - 20;
      T.place(500, raidGROUND_Y - 48 - 120);
      raidLocal.swordCooldown = 0;
      raidLocal.input.down = true;
      hpBefore = raidG.boss.hp;
      raidSwordSwing();
      const dirWasDown = raidLocal.swingDir === 'down';
      raidLocal.input.down = false;
      stepSwing();
      const downConnects = raidG.boss.hp === hpBefore - RAID_SWORD_DAMAGE;

      // ArrowDown/S key wiring (WPN-05)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      const downKeyed = raidLocal.input.down === true;
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }));
      const downKeyReleased = raidLocal.input.down === false;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
      const sKeyed = raidLocal.input.down === true;
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 's' }));

      return { sideMissesOverhead, dirWasUp, upConnects, dirWasDown, downConnects, downKeyed, downKeyReleased, sKeyed };
    });
    expect(r.sideMissesOverhead, 'a plain side swing does not reach straight overhead').toBe(true);
    expect(r.dirWasUp).toBe(true);
    expect(r.upConnects, 'an up-swing reaches a boss directly overhead').toBe(true);
    expect(r.dirWasDown).toBe(true);
    expect(r.downConnects, 'a down-swing reaches a boss directly below').toBe(true);
    expect(r.downKeyed).toBe(true);
    expect(r.downKeyReleased).toBe(true);
    expect(r.sKeyed).toBe(true);
  });

  test('WPN-05 8-way aiming: left/right/diagonals resolve from held movement keys, in absolute world-space (not facing-relative)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};

      // raidResolveSwingDir is pure - table-drive every combination, including cancelling pairs.
      const combos = [
        [{}, 'side'],
        [{ up: true }, 'up'], [{ down: true }, 'down'],
        [{ left: true }, 'left'], [{ right: true }, 'right'],
        [{ up: true, left: true }, 'upleft'], [{ up: true, right: true }, 'upright'],
        [{ down: true, left: true }, 'downleft'], [{ down: true, right: true }, 'downright'],
        [{ up: true, down: true }, 'side'], // cancels
        [{ left: true, right: true }, 'side'], // cancels
        [{ up: true, left: true, right: true }, 'up'] // left/right cancel, up survives
      ];
      out.resolved = combos.map(([held]) =>
        raidResolveSwingDir(Object.assign({ left: false, right: false, up: false, down: false }, held)));
      out.expected = combos.map(([, dir]) => dir);

      const extent = (p, dir, s) => {
        const poly = raidSlashWorldPoly(Object.assign({}, p, { swingDir: dir }), s);
        const xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]);
        const far = poly.reduce((m, q) => (q[0] > m[0] ? q : m), poly[0]);
        return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), hand: poly.hand, farRight: far };
      };

      // Absolute, not facing-relative: facing right but holding Left must still aim left.
      raidLocal.gun = 'sword_training';
      raidLocal.facing = 1;
      raidLocal.input = { left: true, right: false, up: false, down: false, space: false };
      raidLocal.swordCooldown = 0;
      raidSwordSwing();
      out.dirWasLeft = raidLocal.swingDir === 'left';
      const cx = raidPx(raidLocal);
      out.leftOfCentre = extent(raidLocal, raidLocal.swingDir, 0.43).x0 < cx - 60;
      // Same again facing left (mirrored) - still absolute: it still reaches well to the left.
      raidLocal.facing = -1;
      out.leftWhenFacingLeft = extent(raidLocal, 'left', 0.43).x0 < cx - 60;
      raidLocal.facing = 1;

      // 'right' reaches forward along the hand's own height; a diagonal reaches right and down.
      const right = extent(raidLocal, 'right', 0.43);
      out.rightReaches = right.x1 > cx + 60;
      out.rightOnHandLine = Math.abs(right.farRight[1] - right.hand[1]) < 25; // within the slash's own height (the body leans a little as it swings)
      const dr = extent(raidLocal, 'downright', 0.43);
      out.diagRightAndDown = dr.x1 > cx + 30 && dr.y1 > raidLocal.y + 24 + 40;

      // Connect/miss: boss on the downright slash, downright swing connects, a plain up swing does not.
      const stepSwing = () => {
        for (let i = 0; i < RAID_SWORD_SWING_FRAMES; i++) {
          if (raidLocal.swingTimer > 0) raidLocal.swingTimer--;
          raidSendLocalState();
          raidCheckSwordSwings(raidG.boss);
        }
      };
      T.place(500);
      const spot = T.slashPoint(Object.assign({}, raidLocal, { swingDir: 'downright' }));
      raidG.boss.x = spot.x; raidG.boss.y = spot.y;
      raidLocal.input = { left: false, right: true, up: false, down: true, space: false };
      raidLocal.swordCooldown = 0;
      let hpBefore = raidG.boss.hp;
      raidSwordSwing();
      out.dirWasDownright = raidLocal.swingDir === 'downright';
      raidLocal.input = { left: false, right: false, up: false, down: false, space: false };
      stepSwing();
      out.downrightConnects = raidG.boss.hp === hpBefore - RAID_SWORD_DAMAGE;

      raidLocal.swordCooldown = 0;
      raidLocal.input.up = true;
      raidG.boss.y += 120; // clearly below the player, well outside an upward slash
      hpBefore = raidG.boss.hp;
      raidSwordSwing();
      raidLocal.input.up = false;
      stepSwing();
      out.upMissesDiagonalTarget = raidG.boss.hp === hpBefore;

      return out;
    });
    expect(r.resolved).toEqual(r.expected);
    expect(r.dirWasLeft).toBe(true);
    expect(r.leftOfCentre, 'holding Left aims left regardless of facing').toBe(true);
    expect(r.leftWhenFacingLeft, 'and it is the same when facing left: absolute, not mirrored by facing').toBe(true);
    expect(r.rightReaches).toBe(true);
    expect(r.rightOnHandLine, 'the right slash points along the hand\'s own height').toBe(true);
    expect(r.diagRightAndDown).toBe(true);
    expect(r.dirWasDownright).toBe(true);
    expect(r.downrightConnects, 'a downright swing reaches a target diagonally down-right').toBe(true);
    expect(r.upMissesDiagonalTarget, 'a plain up swing does not reach a target below').toBe(true);
  });

  test('WPN-04 every sword has its own slash: its own colours and a different effect, so a teammate\'s sword is easy to tell apart', async ({ page }) => {
    const r = await page.evaluate(() => {
      const ids = MQ_SWORDS.map((s) => s.id);
      const out = { ids, styles: {}, colour: {}, inside: {}, solid: {} };
      const W = 400, H = 300;
      for (const id of ids) {
        out.styles[id] = mqSlashStyle(id);
        // the slash alone: the same pose drawn with and without it
        let r = 0, g = 0, b = 0, n = 0, outside = 0, solid = 0;
        for (const s of [0.4, 0.5, 0.6]) {
          const p = { x: 182, y: 126, facing: 1, swingDir: 'right', utility: '' };
          const poly = raidSlashWorldPoly(p, s);
          const look = { skin: 'skin_classic', gun: id, swing: s, swingDir: 'right', slashScale: 1, noBar: true, noShadow: true, t: 20 };
          const a = document.createElement('canvas'); a.width = W; a.height = H;
          drawPlayerCuphead(a.getContext('2d'), p.x, p.y, 36, 48, 1, 5, 5, false, 0, true, look);
          const b0 = document.createElement('canvas'); b0.width = W; b0.height = H;
          drawPlayerCuphead(b0.getContext('2d'), p.x, p.y, 36, 48, 1, 5, 5, false, 0, true, Object.assign({}, look, { slashScale: 0 }));
          const da = a.getContext('2d').getImageData(0, 0, W, H).data, db = b0.getContext('2d').getImageData(0, 0, W, H).data;
          const inPoly = (x, y) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; } return ins; };
          const distEdge = (x, y) => { let m = 1e9; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [ax, ay] = poly[j], [bx, by] = poly[i]; const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))); m = Math.min(m, Math.hypot(x - ax - t * dx, y - ay - t * dy)); } return m; };
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const changed = da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3];
            if (!changed) continue;
            if (da[i + 3] >= 220) { solid++; if (!inPoly(x, y) && distEdge(x, y) > 3) outside++; r += da[i]; g += da[i + 1]; b += da[i + 2]; n++; }
          }
        }
        out.colour[id] = n ? [r / n, g / n, b / n] : [0, 0, 0];
        out.inside[id] = outside; out.solid[id] = solid;
      }
      // the small trail the shop preview draws for a swing stays white
      const c = document.createElement('canvas'); c.width = 100; c.height = 100;
      const ctx = c.getContext('2d'); ctx.translate(50, 70);
      mqDrawSword(ctx, 'sword_frost', 0, 0, 1, 0.5, 5, 'side');
      const d = ctx.getImageData(0, 0, 100, 100).data;
      out.previewWhite = false;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] > 230 && d[i + 2] > 230 && d[i + 3] > 80) { out.previewWhite = true; break; }
      return out;
    });
    expect(r.ids.length).toBe(5);
    expect(r.ids.map((id) => r.styles[id].fx), 'five different slash effects').toEqual(['none', 'leaf', 'crystal', 'void', 'sun']);
    const col = (id) => r.colour[id];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (const id of r.ids) {
      expect(r.solid[id], id + ' draws a solid slash').toBeGreaterThan(300);
      expect(r.inside[id], id + ': its effects stay inside the hit area (WPN-15)').toBe(0);
    }
    for (let i = 0; i < r.ids.length; i++) for (let j = i + 1; j < r.ids.length; j++) {
      expect(dist(col(r.ids[i]), col(r.ids[j])), r.ids[i] + ' and ' + r.ids[j] + ' slashes are clearly different colours').toBeGreaterThan(40);
    }
    expect(Math.min(...col('sword_training')), 'the Training Nail slash is plain white').toBeGreaterThan(200);
    expect(col('sword_moss')[1], 'Moss Blade is green').toBeGreaterThan(col('sword_moss')[0] + 15);
    expect(col('sword_frost')[2], 'Frostbite Edge is icy blue').toBeGreaterThan(col('sword_frost')[0] + 20);
    expect(col('sword_void')[0] + col('sword_void')[1] + col('sword_void')[2], 'Voidbone Fang is dark').toBeLessThan(col('sword_training')[0] * 2);
    expect(col('sword_void')[2], 'and violet').toBeGreaterThan(col('sword_void')[1] + 20);
    expect(col('sword_dawn')[0], 'Dawnbreaker is gold').toBeGreaterThan(col('sword_dawn')[2] + 60);
    expect(r.previewWhite, 'the shop preview trail stays white').toBe(true);
  });

  test('WPN-10 the swing reaches far: a big white crescent in front of the hand, swept top to bottom, with the same reach in every direction', async ({ page }) => {
    const r = await page.evaluate(() => {
      const base = { x: 300, y: 452, facing: 1, utility: '' };
      const cx = raidPx(base);
      const ext = (dir, s, over) => {
        const poly = raidSlashWorldPoly(Object.assign({ swingDir: dir }, base, over || {}), s);
        const xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]);
        const cyAvg = ys.reduce((a, b) => a + b, 0) / ys.length;
        return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), hand: poly.hand, R: poly.R, cyAvg };
      };
      const side = ext('side', 0.45), right = ext('right', 0.45), left = ext('left', 0.45), up = ext('up', 0.45), down = ext('down', 0.45);
      const flipped = ext('side', 0.45, { facing: -1 });
      const early = ext('side', 0.2), late = ext('side', 0.65);
      const out = {
        reachSide: side.x1 - side.hand[0], reachFromBody: side.x1 - cx, sameAsRight: Math.abs(side.x1 - right.x1) < 0.01,
        reachLeft: left.hand[0] - left.x0, reachUp: up.hand[1] - up.y0, reachDown: down.y1 - down.hand[1],
        R: side.R, height: side.y1 - side.y0, behindHand: Math.max(0, side.hand[0] - side.x0),
        mirrored: flipped.hand[0] - flipped.x0, earlyY: early.cyAvg, lateY: late.cyAvg,
        notYet: raidSlashWorldPoly(Object.assign({ swingDir: 'side' }, base), 0), faded: raidSlashWorldPoly(Object.assign({ swingDir: 'side' }, base), 0.95),
        squash: RAID_SWORD_SLASH_SQUASH
      };
      // The live weapon no longer draws the crescent itself (drawPlayerCuphead fills it from the polygon):
      // the blade rests at its held angle, the old small trail arcs are gone, the shop preview keeps its own.
      const alphaAt = (swing, slashScale, dx, dy, id) => {
        const c = document.createElement('canvas'); c.width = 500; c.height = 500;
        const ctx = c.getContext('2d');
        mqDrawWeapon(ctx, id || 'sword_frost', 250, 250, 1, swing, 5, 'side', slashScale);
        return ctx.getImageData(250 + dx, 250 + dy, 1, 1).data[3];
      };
      out.oldTrailSpot = alphaAt(0.45, 1, 40, -11, 'sword_training');
      out.restingBlade = alphaAt(0.45, 1, -19, -23, 'sword_training');
      out.previewTrailSpot = alphaAt(0.45, undefined, 40, -11, 'sword_training');
      return out;
    });
    expect(r.reachFromBody, 'it reaches about 190 px out from the body, as drawn').toBeGreaterThan(165);
    expect(r.reachFromBody).toBeLessThan(215);
    expect(r.sameAsRight).toBe(true);
    expect(Math.abs(r.reachUp - r.reachSide), 'up and down are the side slash turned a quarter: the same reach').toBeLessThan(10);
    expect(Math.abs(r.reachDown - r.reachSide)).toBeLessThan(10);
    expect(Math.abs(r.reachLeft - r.reachSide), 'and so is left').toBeLessThan(2);
    expect(r.R, 'the crescent radius is the scaled slash radius').toBeGreaterThan(130);
    expect(r.R).toBeLessThan(220);
    expect(r.height, 'the arc is compressed across its direction: shorter than it is far-reaching').toBeLessThan(r.R * 1.2);
    expect(r.squash).toBeLessThan(0.7);
    expect(r.behindHand, 'the slash does not wrap round behind the hand').toBeLessThan(2);
    expect(r.mirrored, 'mirrored for a left-facing player').toBeGreaterThan(90);
    expect(r.lateY, 'it sweeps from the top of the arc to the bottom').toBeGreaterThan(r.earlyY + 10);
    expect(r.notYet, 'nothing yet before the swing opens up').toBeNull();
    expect(r.faded, 'and nothing once it has faded away').toBeNull();
    expect(r.oldTrailSpot, 'the old small trail arcs are gone from the live swing').toBe(0);
    expect(r.restingBlade, 'the blade rests at its held angle instead of swinging').toBeGreaterThan(100);
    expect(r.previewTrailSpot, 'the shop preview still draws its own small swing').toBeGreaterThan(0);
  });

  test('WPN-03 the utility slot: Swift Boots, Vital Core, Feather Cloak, Lucky Charm and Warding Sigil each apply their effect', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};

      raidLocal.utility = 'util_boots';
      out.dashCooldown = raidDashCooldownFrames(); // 180 * 0.75

      raidLocal.utility = 'util_heart';
      out.maxHealth = raidMaxHealthForLoadout(); // 5 + 1

      raidLocal.utility = 'util_feather';
      out.jumpHold = raidJumpHoldFrames(); out.baseHold = RAID_JUMP_HOLD_FRAMES;

      raidLocal.utility = 'util_ward';
      const p = Object.assign({}, T.me(), { utility: 'util_ward', wardUsed: false, shield: false, invincible: 0 });
      raidDamagePlayer(raidMyId, p, 1);
      const afterWard = await raidPlayerRef.child(raidMyId).once('value');
      out.wardAbsorbed = afterWard.val().wardUsed === true && afterWard.val().health === p.health;
      // a second hit (wardUsed already true) goes through normally - past its invincibility too
      raidDamagePlayer(raidMyId, Object.assign({}, afterWard.val(), { invincible: 0 }), 1);
      const afterSecond = await raidPlayerRef.child(raidMyId).once('value');
      out.secondHitLandsAfterWard = afterSecond.val().health === p.health - 1;

      mqProfile.equipped.utility = 'util_coin';
      currentDifficulty = 'normal';
      raidLocal.health = raidLocal.maxHealth = 5;
      out.coinBonus = mqAwardRaidVictory().coins; // (120 + 5*10) * 1.1, rounded
      return out;
    });
    expect(r.dashCooldown).toBe(135);
    expect(r.maxHealth).toBe(6);
    expect(r.jumpHold).toBe(Math.round(r.baseHold * 1.3)); // Feather Cloak: +30% hold time
    expect(r.wardAbsorbed, 'the first hit is absorbed and marks wardUsed').toBe(true);
    expect(r.secondHitLandsAfterWard, 'only the first hit per raid is warded').toBe(true);
    expect(r.coinBonus).toBe(187);
  });

  test('WPN-03 the new charms: Nimble Treads, Iron Skin, Reinforced Plating, Mending Charm, Long Reach and Phantom Step each apply their effect', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};

      raidLocal.utility = 'util_boots2';
      out.maxSpeed = raidMaxSpeed(); // 7 * 1.15
      const runTop = () => { T.place(100); raidLocal.vx = 0; raidLocal.input = { left: false, right: true, up: false, down: false, jump: false, space: false }; let m = 0; for (let i = 0; i < 80; i++) { raidUpdateLocal(); m = Math.max(m, raidLocal.vx); } raidLocal.input.right = false; return m; };
      const saveUtil = raidLocal.utility;
      raidLocal.utility = null; const baseRun = runTop();
      raidLocal.utility = 'util_boots2'; const nimbleRun = runTop();
      raidLocal.utility = saveUtil;
      out.runFaster = nimbleRun > baseRun * 1.1;

      raidLocal.utility = 'util_iron';
      out.knockbackMult = raidKnockbackMult(); // 0.5

      raidLocal.utility = 'util_shield';
      out.shieldDuration = raidShieldDurationFrames(); // round(90 * 1.3)

      raidLocal.utility = 'util_regen';
      out.shieldRegen = raidShieldRegenFrames(); // round(420 / 1.5)

      raidLocal.utility = 'util_range';
      out.attackRangeMult = raidAttackRangeMult(); // 1.25
      const reachOf = (u) => { const poly = raidSlashWorldPoly({ x: 300, y: 452, facing: 1, swingDir: 'side', utility: u }, 0.43); return poly.reduce((m, q) => Math.max(m, q[0]), -1e9) - poly.hand[0]; };
      out.reachRatio = reachOf('util_range') / reachOf(''); // Long Reach: +25% on the drawn slash and so on its hit area

      raidLocal.utility = 'util_dashi';
      out.dashIframes = raidDashInvincibleFrames(); // round(14 * 1.5)

      raidLocal.utility = null;
      out.defaultSpeed = raidMaxSpeed();
      out.defaultKnockback = raidKnockbackMult();
      out.defaultShieldDuration = raidShieldDurationFrames();
      out.defaultShieldRegen = raidShieldRegenFrames();
      out.defaultRangeMult = raidAttackRangeMult();
      out.defaultDashIframes = raidDashInvincibleFrames();
      return out;
    });
    expect(r.maxSpeed).toBeCloseTo(8.05, 5);
    expect(r.runFaster, 'Nimble Treads really make the player run faster').toBe(true);
    expect(r.knockbackMult).toBe(0.5);
    expect(r.shieldDuration).toBe(117);
    expect(r.shieldRegen).toBe(280);
    expect(r.attackRangeMult).toBe(1.25);
    expect(r.reachRatio, 'Long Reach grows the slash (and so the hit area) by 25%').toBeCloseTo(1.25, 2);
    expect(r.dashIframes).toBe(21);
    // defaults (no utility equipped) are unaffected
    expect(r.defaultSpeed).toBe(7);
    expect(r.defaultKnockback).toBe(1);
    expect(r.defaultShieldDuration).toBe(90);
    expect(r.defaultShieldRegen).toBe(420);
    expect(r.defaultRangeMult).toBe(1);
    expect(r.defaultDashIframes).toBe(14);
  });

  test('WPN-13 several worn charms all apply at once, for every player (host-side effects read the synced list)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      raidLocal.utility = 'util_boots,util_heart,util_boots2,util_iron';
      out.dash = raidDashCooldownFrames(); out.hearts = raidMaxHealthForLoadout(); out.speed = raidMaxSpeed(); out.knock = raidKnockbackMult();
      // an explicit list (a teammate's synced charms) is honoured by the per-player readers
      out.range = raidAttackRangeMult('util_boots,util_range');
      const reachOf = (u) => { const poly = raidSlashWorldPoly({ x: 300, y: 452, facing: 1, swingDir: 'side', utility: u }, 0.43); return poly.reduce((m, q) => Math.max(m, q[0]), -1e9) - poly.hand[0]; };
      out.rangeBox = reachOf('util_coin,util_range') / reachOf('');
      out.noRange = raidAttackRangeMult('util_boots,util_coin');
      // Warding Sigil among other charms still absorbs the first hit
      raidLocal.utility = 'util_boots,util_ward';
      const p = Object.assign({}, T.me(), { utility: 'util_boots,util_ward', wardUsed: false, shield: false, invincible: 0 });
      raidDamagePlayer(raidMyId, p, 1);
      out.warded = p.wardUsed === true && p.health === 5;
      // the Familiar is spawned for a player wearing it alongside others
      raidG.players[raidMyId].utility = 'util_boots,util_minion';
      raidG.minions = []; raidUpdateMinions(raidG.boss);
      out.minions = raidG.minions.length;
      raidLocal.utility = null;
      return out;
    });
    expect(r.dash).toBe(135);
    expect(r.hearts).toBe(6);
    expect(r.speed).toBeCloseTo(8.05, 5);
    expect(r.knock).toBe(0.5);
    expect(r.range).toBe(1.25);
    expect(r.rangeBox, 'Long Reach among other charms still grows the slash').toBeCloseTo(1.25, 2);
    expect(r.noRange).toBe(1);
    expect(r.warded).toBe(true);
    expect(r.minions).toBe(1);
  });

  test('WPN-14 the ten new charms each apply their effect (and nothing changes without them)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      const none = () => { raidLocal.utility = ''; };
      // Quick Hands: shorter sword cooldown
      none(); raidLocal.swordCooldown = 0; raidSwordSwing(); out.cdBase = raidLocal.swordCooldown;
      raidLocal.utility = 'util_hands'; raidLocal.swordCooldown = 0; raidSwordSwing(); out.cdHands = raidLocal.swordCooldown;
      // Whetstone: more sword damage; Opportunist: more damage while the boss is stunned
      const swordHit = (utility, exposed) => {
        T.prepBoss('grinmaw', 1); raidG.boss.x = 500; raidG.boss.y = 300; raidG.boss.exposed = exposed;
        T.place(500 - 50, 300 - 24, { utility, swingTimer: RAID_SWORD_HIT_WINDOW_START, swingDir: 'right', facing: 1 });
        raidSendLocalState();
        raidG.players[raidMyId].swingTimer = RAID_SWORD_HIT_WINDOW_START; raidG.players[raidMyId].swingDir = 'right'; raidG.players[raidMyId].utility = utility;
        raidSwingHitState = {};
        const hp0 = raidG.boss.hp;
        raidCheckSwordSwings(raidG.boss);
        return hp0 - raidG.boss.hp;
      };
      out.hitBase = swordHit('', 0); out.hitWhet = swordHit('util_whet', 0);
      out.stunBase = swordHit('', 100); out.stunHunter = swordHit('util_hunter', 100);
      out.stunBoth = swordHit('util_whet,util_hunter', 100);
      // Pogo Spring: a higher bounce
      none(); out.pogoBase = raidPogoVy(); raidLocal.utility = 'util_spring'; out.pogoSpring = raidPogoVy();
      // Light Step: gravity is lighter while falling (and unchanged while rising)
      const fall = (utility) => {
        raidLocal.utility = utility; raidLocal.dashTimer = 0; raidLocal.input = { left: false, right: false, up: false, down: false, jump: false, space: false };
        T.place(500, 100); raidLocal.onGround = false; raidLocal.vy = 0; raidLocal.jumpBoosting = false;
        for (let i = 0; i < 20; i++) raidUpdateLocal();
        return raidLocal.y;
      };
      out.fallBase = fall(''); out.fallLight = fall('util_cloud');
      raidLocal.utility = 'util_cloud'; T.place(500, 300); raidLocal.onGround = false; raidLocal.vy = -5; raidUpdateLocal();
      out.riseGravity = raidLocal.vy - (-5); // still RAID_GRAVITY going up
      // Long Stride: a longer dash
      none(); raidLocal.dashCooldown = 0; raidTryDash(); out.dashBase = raidLocal.dashTimer;
      raidLocal.utility = 'util_stride'; raidLocal.dashCooldown = 0; raidLocal.dashTimer = 0; raidTryDash(); out.dashStride = raidLocal.dashTimer;
      // Thick Skin: longer invincibility after being hit
      const hurtFrames = (utility) => { const p = Object.assign({}, T.me(), { utility, wardUsed: true, shield: false, invincible: 0, health: 5 }); raidDamagePlayer(raidMyId, p, 1); return p.invincible; };
      out.hurtBase = hurtFrames(''); out.hurtHide = hurtFrames('util_hide');
      // Golden Idol: +25% coins (adds to Lucky Charm's +10%)
      const coins = (utility) => { mqProfile.equipped.utility = utility; currentDifficulty = 'normal'; raidLocal.health = raidLocal.maxHealth = 5; return mqAwardRaidVictory().coins; };
      out.coinBase = coins(''); out.coinIdol = coins('util_idol'); out.coinBoth = coins('util_coin,util_idol');
      // Titan Heart: +2 hearts, stacks with Vital Core
      raidLocal.utility = 'util_titan'; out.titan = raidMaxHealthForLoadout();
      raidLocal.utility = 'util_titan,util_heart'; out.titanHeart = raidMaxHealthForLoadout();
      // Deflector: parries reach further
      const tipOf = (p) => { let tip = null; for (let t = 12; t >= 3; t--) { const poly = raidSlashWorldPoly(p, raidSwingProgress(t)); if (poly) poly.forEach((q) => { if (!tip || q[0] > tip[0]) tip = q; }); } return tip; };
      const parried = (utility, gap) => {
        T.prepBoss('grinmaw', 1); raidG.boss.x = 900; raidG.boss.y = 300;
        T.place(300, undefined, { swingTimer: 0, swingDir: 'right', facing: 1, utility });
        const me = raidG.players[raidMyId];
        const tip = tipOf(Object.assign({}, me, { swingDir: 'right', facing: 1, utility })); // the farthest the plain slash ever reaches
        raidG.projectiles = [{ x: tip[0] + 12 + gap, y: tip[1], vx: 0, vy: 0, r: 12, life: 50, isWarning: false, isBossProjectile: true, kind: 'candy' }];
        raidParryState = {};
        for (let t = RAID_SWORD_SWING_FRAMES; t >= 0; t--) { // the host's parry check, one frame at a time through the swing
          Object.assign(raidG.players[raidMyId], { swingTimer: t, swingDir: 'right', facing: 1, utility });
          raidParryProjectiles();
        }
        return raidG.projectiles.length === 0;
      };
      out.parryBase = parried('', 14); out.parryDeflect = parried('util_deflect', 14); out.parryFar = parried('util_deflect', 90);
      out.parryTouching = parried('', -10);
      none();
      return out;
    });
    expect(r.cdBase).toBe(26);
    expect(r.cdHands, 'Quick Hands: cooldown -25%').toBe(Math.round(26 * 0.75));
    expect(r.hitBase).toBe(4);
    expect(r.hitWhet, 'Whetstone: +25% sword damage').toBe(5);
    expect(r.stunBase).toBe(8);
    expect(r.stunHunter, 'Opportunist: +50% on a stunned boss').toBe(12);
    expect(r.stunBoth).toBe(15);
    expect(r.pogoSpring, 'Pogo Spring: +30% bounce').toBeCloseTo(r.pogoBase * 1.3, 5);
    expect(r.fallLight, 'Light Step: a falling player has dropped less far after 20 frames').toBeLessThan(r.fallBase);
    expect(r.riseGravity, 'but rising is unchanged').toBeCloseTo(0.25 * 0.75 * 0.75, 5);
    expect(r.dashStride, 'Long Stride: +30% dash length').toBe(Math.round(r.dashBase * 1.3));
    expect(r.hurtBase).toBe(30);
    expect(r.hurtHide, 'Thick Skin: +50% invincibility after a hit').toBe(45);
    expect(r.coinBase).toBe(170);
    expect(r.coinIdol, 'Golden Idol: +25% coins').toBe(213);
    expect(r.coinBoth, 'with Lucky Charm the bonuses add: +35%').toBe(230);
    expect(r.titan).toBe(7);
    expect(r.titanHeart).toBe(8);
    expect(r.parryBase, 'without Deflector a shot just outside the blade is not parried').toBe(false);
    expect(r.parryDeflect, 'Deflector: the parry reaches further').toBe(true);
    expect(r.parryFar).toBe(false);
    expect(r.parryTouching).toBe(true);
  });

  test('WPN-06 Second Wind grants exactly one extra jump in the air, refilled on landing, and only while equipped', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      // Edge-detected: press (up true on a frame where it was false before), then release,
      // so a held key can't be mistaken for a fresh press on the next attempt.
      const pressJump = () => {
        raidLocal.input.jump = true; raidUpdateLocal();
        raidLocal.input.jump = false; raidUpdateLocal();
      };

      // without the charm: airborne and "falling" (vy > 0) - a jump press should not boost it
      raidLocal.utility = null;
      T.place(500, raidGROUND_Y - 48 - 100); raidLocal.onGround = false; raidLocal.airJumpsUsed = 0; raidLocal.vy = 2;
      pressJump();
      const noCharmBlocked = raidLocal.vy > 0; // gravity only, no fresh negative (upward) boost

      // with the charm: one air jump gives a fresh upward boost
      raidLocal.utility = 'util_double';
      T.place(500, raidGROUND_Y - 48 - 100); raidLocal.onGround = false; raidLocal.airJumpsUsed = 0; raidLocal.vy = 2;
      pressJump();
      const afterAirJump = { vy: raidLocal.vy, used: raidLocal.airJumpsUsed, boosting: raidLocal.jumpBoosting };
      // a second air jump is blocked (only one charge) - still falling, no second boost
      raidLocal.vy = 2;
      pressJump();
      const secondBlocked = raidLocal.vy > 0;
      // landing refills it
      T.place(500, raidGROUND_Y - 48); raidLocal.onGround = false;
      raidUpdateLocal(); // lands, onGround becomes true, airJumpsUsed resets
      const refilled = raidLocal.airJumpsUsed === 0;
      // how high does an air jump carry compared with the first (ground) jump?
      const rise = (airborne) => {
        raidLocal.utility = 'util_double';
        if (airborne) { T.place(500, 150); raidLocal.onGround = false; raidLocal.airJumpsUsed = 0; raidLocal.vy = 0; raidLocal.input.jump = false; raidLocal.wasJumpPressed = false; }
        else { T.place(500); raidLocal.onGround = true; raidLocal.jumpBoosting = false; }
        const y0 = raidLocal.y; let minY = y0;
        raidLocal.input.jump = true; raidUpdateLocal(); raidLocal.input.jump = false;
        for (let i = 0; i < 80; i++) { raidUpdateLocal(); minY = Math.min(minY, raidLocal.y); }
        return y0 - minY;
      };
      const groundRise = rise(false), airRise = rise(true);
      return { noCharmBlocked, afterAirJump, secondBlocked, refilled, groundRise, airRise };
    });
    expect(r.noCharmBlocked, 'no extra jump without the charm').toBe(true);
    expect(r.afterAirJump.vy).toBeLessThan(0);
    expect(r.afterAirJump.used).toBe(1);
    expect(r.afterAirJump.boosting, 'an air jump is a fixed small hop - holding does not boost it').toBe(false);
    expect(r.airRise, 'the double jump does not jump as far as the first jump').toBeLessThan(r.groundRise * 0.75);
    expect(r.airRise).toBeGreaterThan(20);
    expect(r.secondBlocked, 'only one air jump per landing').toBe(true);
    expect(r.refilled, 'landing refills the air jump').toBe(true);
  });

  test('WPN-07 Spectral Familiar spawns an orbiting minion for its owner that fires at the boss and despawns when unequipped', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.utility = 'util_minion';
      raidSendLocalState();
      raidBossUpdate();
      const spawned = raidG.minions.length === 1 && raidG.minions[0].ownerId === raidMyId;
      const p0 = { x: raidG.minions[0].x, y: raidG.minions[0].y };
      for (let i = 0; i < 10; i++) raidBossUpdate();
      const orbited = raidG.minions[0].x !== p0.x || raidG.minions[0].y !== p0.y;
      raidG.playerProjectiles = [];
      for (let i = 0; i < 90; i++) raidBossUpdate();
      const fired = raidG.playerProjectiles.some((p) => p.kind === 'minionBolt' && p.owner === raidMyId);
      const hpBefore = raidG.boss.hp;
      for (let i = 0; i < 200; i++) raidBossUpdate();
      const damaged = raidG.boss.hp < hpBefore;
      // unequipping despawns it
      raidLocal.utility = null;
      raidSendLocalState();
      raidBossUpdate();
      const despawned = raidG.minions.length === 0;
      return { spawned, orbited, fired, damaged, despawned };
    });
    expect(r.spawned, 'a minion spawns for the owner').toBe(true);
    expect(r.orbited, 'the minion orbits, it does not sit still').toBe(true);
    expect(r.fired, 'the minion fires a weak bolt at the boss').toBe(true);
    expect(r.damaged, 'the minion bolt damages the boss through the normal pipeline').toBe(true);
    expect(r.despawned, 'unequipping the charm removes the minion').toBe(true);
  });

  test('WPN-08 a downward air-attack that connects with the boss bounces the player upward (pogo)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.gun = 'sword_training';
      // Calls raidCheckLocalPogo directly, decrementing swingTimer by hand rather than running
      // the full raidUpdateLocal - isolates exactly the logic under test, same reasoning WPN-05's
      // stepSwing() uses raidCheckSwordSwings directly instead of the full raidBossUpdate.
      const stepPogo = () => {
        for (let i = 0; i < RAID_SWORD_SWING_FRAMES; i++) {
          if (raidLocal.swingTimer > 0) raidLocal.swingTimer--;
          raidCheckLocalPogo();
        }
      };
      const primeDownSwing = () => {
        raidLocal.swordCooldown = 0;
        raidLocal.input = { left: false, right: false, up: false, down: true, space: false };
        raidSwordSwing();
        raidLocal.input.down = false;
      };

      // Airborne, boss positioned exactly under the down-swing's own hitbox: should bounce.
      T.place(500, 200);
      raidLocal.onGround = false;
      raidLocal.vy = 4;
      primeDownSwing();
      const box = (() => { const s = T.slashPoint(raidLocal, 8); return { cx: s.x, cy: s.y }; })(); // a spot inside the drawn slash
      raidG.boss.type = 'grinmaw';
      raidG.boss.x = box.cx; raidG.boss.y = box.cy;
      raidG.boss.anim = { state: 'idle', timer: 0 }; raidG.boss.invulnerable = false; raidG.boss.transition = 0;
      stepPogo();
      const bounced = raidLocal.vy === RAID_POGO_VY;
      const stillAirborne = raidLocal.onGround === false;
      const jumpBoostCleared = raidLocal.jumpBoosting === false;

      // The same already-resolved swing does not bounce a second time.
      raidLocal.vy = 4;
      stepPogo();
      const noDoubleBounce = raidLocal.vy === 4;

      // Grounded: a connecting down-swing never bounces.
      raidLocal.onGround = true;
      raidLocal.vy = 0;
      primeDownSwing();
      stepPogo();
      const groundedNoBounce = raidLocal.vy === 0;

      // A non-downward swing (side) never bounces, even airborne and overlapping.
      raidLocal.onGround = false;
      raidLocal.vy = 4;
      raidLocal.swordCooldown = 0;
      raidLocal.input = { left: false, right: false, up: false, down: false, space: false };
      raidSwordSwing();
      const sideBox = (() => { const s = T.slashPoint(raidLocal, 8); return { cx: s.x, cy: s.y }; })();
      raidG.boss.x = sideBox.cx; raidG.boss.y = sideBox.cy;
      stepPogo();
      const sideNoBounce = raidLocal.vy === 4;

      // A genuinely untargetable boss (fading) blocks the bounce...
      raidLocal.vy = 4;
      primeDownSwing();
      raidG.boss.x = box.cx; raidG.boss.y = box.cy;
      raidG.boss.type = 'warden';
      raidG.boss.anim = { state: 'fade', timer: 1 };
      stepPogo();
      const untargetableNoBounce = raidLocal.vy === 4;

      // ...but a merely-invulnerable boss (the phase-transition beat) still bounces the player -
      // deliberate: raidCheckSwordSwings still consumes a blocked swing the same way.
      raidG.boss.type = 'grinmaw';
      raidG.boss.anim = { state: 'idle', timer: 0 };
      raidG.boss.invulnerable = true;
      raidLocal.vy = 4;
      primeDownSwing();
      raidG.boss.x = box.cx; raidG.boss.y = box.cy;
      stepPogo();
      const invulnerableStillBounces = raidLocal.vy === RAID_POGO_VY;
      raidG.boss.invulnerable = false;

      // Damage isn't duplicated: the pogo check and the real (host) damage check run over the
      // same connecting swing and the boss loses exactly RAID_SWORD_DAMAGE, once.
      raidLocal.vy = 4;
      primeDownSwing();
      raidG.boss.x = box.cx; raidG.boss.y = box.cy;
      const hpBefore = raidG.boss.hp;
      for (let i = 0; i < RAID_SWORD_SWING_FRAMES; i++) {
        if (raidLocal.swingTimer > 0) raidLocal.swingTimer--;
        raidCheckLocalPogo();
        raidSendLocalState();
        raidCheckSwordSwings(raidG.boss);
      }
      const damageNotDoubled = raidG.boss.hp === hpBefore - RAID_SWORD_DAMAGE;
      const alsoBouncedWithDamage = raidLocal.vy === RAID_POGO_VY;

      // Host/non-host parity: raidCheckLocalPogo doesn't consult raidIsHost at all.
      raidLocal.vy = 4;
      primeDownSwing();
      raidG.boss.x = box.cx; raidG.boss.y = box.cy;
      const wasHost = raidIsHost;
      raidIsHost = false;
      stepPogo();
      const nonHostBounces = raidLocal.vy === RAID_POGO_VY;
      raidIsHost = wasHost;

      return {
        bounced, stillAirborne, jumpBoostCleared, noDoubleBounce, groundedNoBounce, sideNoBounce,
        untargetableNoBounce, invulnerableStillBounces, damageNotDoubled, alsoBouncedWithDamage, nonHostBounces
      };
    });
    expect(r.bounced, 'a connecting airborne down-swing sets vy to RAID_POGO_VY').toBe(true);
    expect(r.stillAirborne).toBe(true);
    expect(r.jumpBoostCleared, 'a clean fixed-height bounce, not a held-jump boost').toBe(true);
    expect(r.noDoubleBounce, 'the same swing cannot bounce twice').toBe(true);
    expect(r.groundedNoBounce, 'a grounded down-swing never bounces').toBe(true);
    expect(r.sideNoBounce, 'a non-downward swing never bounces').toBe(true);
    expect(r.untargetableNoBounce, 'a fading/untargetable boss cannot be pogoed off').toBe(true);
    expect(r.invulnerableStillBounces, 'a merely-invulnerable (blocked) boss still bounces the player').toBe(true);
    expect(r.damageNotDoubled, 'the pogo check never deals damage itself').toBe(true);
    expect(r.alsoBouncedWithDamage).toBe(true);
    expect(r.nonHostBounces, 'the bounce works the same whether this client is host or not').toBe(true);
  });

  test('WPN-08 a downward air-swing also bounces off a large boss projectile (not a small one, not a hazard)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.gun = 'sword_training';
      T.prepBoss('grinmaw', 1);
      raidG.boss.x = 800; raidG.boss.y = 300; // out of the way, so only the shot can bounce us
      const mk = (kind, r, x, y) => ({ x, y, vx: 0, vy: 0, r, life: 100, isWarning: false, isBossProjectile: true, owner: kind, kind });
      const tryPogo = (proj, hazards) => {
        T.place(500, 200);
        raidLocal.onGround = false; raidLocal.vy = 4;
        raidLocal.swordCooldown = 0;
        raidLocal.input = { left: false, right: false, up: false, down: true, space: false };
        raidSwordSwing();
        raidLocal.input.down = false;
        const box = (() => { const s = T.slashPoint(raidLocal, 8); return { cx: s.x, cy: s.y }; })();
        proj.x = box.cx; proj.y = box.cy;
        raidG.projectiles = proj.kind ? [proj] : [];
        raidG.hazards = hazards || [];
        raidPogoState = { lastSwingTimer: 0, bounced: false };
        for (let i = 0; i < RAID_SWORD_SWING_FRAMES; i++) {
          if (raidLocal.swingTimer > 0) raidLocal.swingTimer--;
          raidCheckLocalPogo();
        }
        return raidLocal.vy === RAID_POGO_VY;
      };
      return {
        candy: tryPogo(mk('candy', 12, 0, 0)),
        bubble: tryPogo(mk('bubble', 14, 0, 0)),
        fang: tryPogo(mk('fang', 10, 0, 0)),
        bolt: tryPogo(mk('bolt', 9, 0, 0)),
        shockwave: tryPogo({ x: 0, y: 0 }, [{ kind: 'shockwave', x: 500, dir: 1, speed: 2, life: 100 }]),
        nothing: tryPogo({ x: 0, y: 0 })
      };
    });
    expect(r.candy, 'a large shot is a pogo target').toBe(true);
    expect(r.bubble).toBe(true);
    expect(r.fang, 'a small shot is not').toBe(false);
    expect(r.bolt).toBe(false);
    expect(r.shockwave, 'a shockwave is not').toBe(false);
    expect(r.nothing).toBe(false);
  });

  test('WPN-11 a swing parries only the large boss projectiles (candy, embers, bubbles); small shots and shockwaves cannot be parried; a parried lob never erupts', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.gun = 'sword_training';
      T.prepBoss('grinmaw', 1);
      raidG.boss.x = 800; raidG.boss.y = 300; // well away from the swing
      raidLocal.facing = 1;
      raidLocal.input = { left: false, right: true, up: false, down: false, space: false };
      const hpBoss = raidG.boss.hp;
      const kinds = ['candy', 'fang', 'ember', 'bubble', 'pod', 'bolt', 'plume', 'feather', 'void'];
      const RADIUS = { candy: 12, fang: 10, ember: 11, bubble: 14, pod: 10, bolt: 9, plume: 9, feather: 9, void: 10 }; // the real sizes
      const mk = (kind, x, y) => ({ x, y, vx: 0, vy: 0, r: RADIUS[kind], life: 100, isWarning: false, isBossProjectile: true, owner: kind, kind,
        onLand: kind === 'ember' ? 'pillar' : kind === 'pod' ? 'thornSpike' : '' });
      const stepSwing = () => {
        for (let i = 0; i < RAID_SWORD_SWING_FRAMES; i++) {
          if (raidLocal.swingTimer > 0) raidLocal.swingTimer--;
          raidSendLocalState();
          raidParryProjectiles();
        }
      };
      const out = {};
      // every kind, one at a time, on the drawn right-swing slash
      T.place(300, 300);
      const px = raidPx(raidLocal);
      const spot = T.slashPoint(Object.assign({}, raidLocal, { swingDir: 'right', facing: 1 }));
      out.parried = {};
      let sparks = 0;
      for (const kind of kinds) {
        raidG.projectiles = [mk(kind, spot.x, spot.y)];
        raidG.slamAnimations = [];
        raidLocal.swordCooldown = 0;
        raidSwordSwing();
        stepSwing();
        out.parried[kind] = raidG.projectiles.length === 0 || raidG.projectiles[0].life <= 0;
        sparks += raidG.slamAnimations.filter((a) => a.phase === 'parry').length;
      }
      out.sparks = sparks;
      out.parryable = kinds.filter((k) => raidIsParryable(mk(k, 0, 0)));
      // a shockwave rolling along the floor through the blade is a hazard, not a shot: untouched
      T.place(300);
      raidG.projectiles = [];
      raidG.hazards = [{ kind: 'shockwave', x: spot.x, dir: 1, speed: 2, life: 100 }];
      raidLocal.swordCooldown = 0;
      raidSwordSwing();
      stepSwing();
      out.shockwaveStays = raidG.hazards.length === 1 && raidG.hazards[0].life === 100;
      T.place(300, 300);
      // a shot outside the slash and one behind the player survive; the large one touched in one swing goes
      raidG.projectiles = [mk('candy', spot.x, spot.y), mk('fang', spot.x + 6, spot.y - 4), mk('candy', px + 400, raidLocal.y + 24), mk('candy', px - 60, raidLocal.y + 24)];
      raidLocal.swordCooldown = 0;
      raidSwordSwing();
      stepSwing();
      out.survivors = raidG.projectiles.filter((p) => p.life > 0).map((p) => Math.round(p.x - px)).sort((a, b) => a - b);
      out.expectedSurvivors = [-60, Math.round(spot.x + 6 - px), 400].sort((a, b) => a - b);
      // before/after the blade is out nothing is parried
      raidG.projectiles = [mk('candy', spot.x, spot.y)];
      raidLocal.swingTimer = RAID_SWORD_SWING_FRAMES; raidLocal.swingDir = 'right';
      raidParryState = {};
      raidSendLocalState(); Object.assign(raidG.players[raidMyId], { swingTimer: RAID_SWORD_SWING_FRAMES, swingDir: 'right' });
      raidParryProjectiles(); // first frame of the swing: blade not out yet
      out.earlySafe = raidG.projectiles.length === 1 && raidG.projectiles[0].life > 0;
      raidLocal.swingTimer = 0; raidSendLocalState(); raidG.players[raidMyId].swingTimer = 0; raidParryState = {};
      raidParryProjectiles();
      out.idleSafe = raidG.projectiles.length === 1 && raidG.projectiles[0].life > 0;
      // a parried lob does not leave its pillar behind, even when it was already about to land: the
      // ember sits on the slash, a pixel above where it would touch down, as the blade reaches it
      T.place(300);
      const trial = T.slashPoint(Object.assign({}, raidLocal, { swingDir: 'right', facing: 1 }));
      T.place(300, raidLocal.y + (raidGROUND_Y - 12 - trial.y)); // slide the player so that spot is at floor level
      const landing = T.slashPoint(Object.assign({}, raidLocal, { swingDir: 'right', facing: 1 }));
      raidG.hazards = [];
      raidG.projectiles = [Object.assign(mk('ember', landing.x, landing.y), { gravity: 0.3, vy: 5 })];
      raidLocal.swingTimer = 0; raidLocal.swordCooldown = 0;
      raidSwordSwing();
      raidLocal.swingTimer = 9; // the next frame brings it to 8, the spot's own frame
      raidParryState = {};
      for (let i = 0; i < RAID_SWORD_SWING_FRAMES; i++) {
        if (raidLocal.swingTimer > 0) raidLocal.swingTimer--;
        raidSendLocalState();
        raidBossUpdate();
      }
      out.pillars = raidG.hazards.filter((h) => h.kind === 'pillar').length;
      // parrying is not a boss hit
      out.hpSame = raidG.boss.hp === hpBoss;
      // the parry spark draws without error
      raidG.slamAnimations = [{ x: 500, y: 300, life: 8, phase: 'parry', timer: 2 }];
      try { raidDraw(); out.drew = true; } catch (e) { out.drew = false; }
      return out;
    });
    expect(r.parryable.sort(), 'the large shots are the parryable ones').toEqual(['bubble', 'candy', 'ember']);
    for (const k of ['candy', 'fang', 'ember', 'bubble', 'pod', 'bolt', 'plume', 'feather', 'void']) {
      expect(r.parried[k], k + (['candy', 'ember', 'bubble'].includes(k) ? ' is parried' : ' is too small to parry')).toBe(['candy', 'ember', 'bubble'].includes(k));
    }
    expect(r.shockwaveStays, 'a shockwave cannot be parried').toBe(true);
    expect(r.sparks, 'a parry leaves a spark').toBeGreaterThan(0);
    expect(r.survivors, 'only the large shots the blade actually touched are destroyed').toEqual(r.expectedSurvivors);
    expect(r.earlySafe, 'the blade is not out on the first frame').toBe(true);
    expect(r.idleSafe, 'no swing, no parry').toBe(true);
    expect(r.pillars, 'a parried ember never erupts').toBe(0);
    expect(r.hpSame, 'a parry is not a boss hit').toBe(true);
    expect(r.drew, 'the parry spark draws without error').toBe(true);
  });

  test('WPN-12 every charm has its own animation on the player and in its shop icon', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const ids = MQ_UTILITY.map((u) => u.id);
      const grab = (draw) => {
        const c = document.createElement('canvas'); c.width = 200; c.height = 200;
        const x = c.getContext('2d'); draw(x);
        return x.getImageData(0, 0, 200, 200).data;
      };
      // which pixels differ between two renders, as a string so it can be compared and hashed
      const mask = (a, b) => {
        let m = '', n = 0;
        for (let i = 0; i < a.length; i += 4) {
          const d = a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3];
          m += d ? '1' : '0'; if (d) n++;
        }
        return { m, n };
      };
      const body = (t, util, extra) => grab((x) => drawPlayerCuphead(x, 82, 90, 36, 48, 1, 5, 5, false, 0, true,
        Object.assign({ skin: 'skin_classic', gun: 'sword_training', t, vx: 4, vy: 0, onGround: true, noBar: true, noShadow: true, utility: util }, extra || {})));
      const icon = (item, t) => grab((x) => { x.translate(100, 100); x.scale(2, 2); mqDrawUtilityIcon(x, item, t); });
      // a colour signature of everything a charm changes: two charms with the same badge shape but different art differ
      const sig = (a, b) => { let h = 7; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) h = (h * 31 + i + a[i] * 3 + a[i + 1] * 5 + a[i + 2] * 7 + a[i + 3]) % 1000000007; return h; };
      const out = { ids, onPlayer: {}, onPlayerAnimates: {}, icon: {}, iconAnimates: {}, unique: 0 };
      const seen = new Set();
      for (const id of ids) {
        const a = mask(body(40, id), body(40, ''));
        const b = mask(body(53, id), body(53, ''));
        out.onPlayer[id] = a.n;
        out.onPlayerAnimates[id] = a.m !== b.m;
        seen.add(sig(body(40, id), body(40, '')));
        const item = MQ_UTILITY_MAP[id];
        const generic = Object.assign({}, item, { id: 'util_unknown' });
        const i1 = mask(icon(item, 10), icon(generic, 10)), i2 = mask(icon(item, 37), icon(generic, 37));
        out.icon[id] = i1.n;
        out.iconAnimates[id] = i1.m !== i2.m;
      }
      out.unique = seen.size;
      // three charms at once: a comma-separated list draws every charm, each in its own spot, so they
      // never pile on top of each other (the three together cover about as much as the three alone)
      const trio = ['util_boots', 'util_ward', 'util_heart'];
      const combo = body(40, trio.join(','));
      const combos = trio.map((id) => mask(combo, body(40, id)).n);
      out.comboDiffers = combos.every((n) => n > 25);
      out.comboCovers = mask(combo, body(40, '')).n;
      out.singlesCover = trio.reduce((sum, id) => sum + mask(body(40, id), body(40, '')).n, 0);
      // no charm: nothing changes (an unknown id too)
      out.noneSame = mask(body(40, ''), body(40, undefined)).n === 0 && mask(body(40, ''), body(40, 'util_unknown')).n === 0;
      // a charm never paints over a ghost afterimage or a shop skin preview (noCharm)
      out.noCharmSame = mask(body(40, 'util_ward', { noCharm: true }), body(40, '')).n === 0;
      // real raid draw: local player and a teammate each with a charm, every charm, no errors
      await T.setupRaid('grinmaw');
      let drewAll = true;
      for (const id of ids) {
        raidLocal.utility = id;
        raidG.players.mate = { x: 300, y: raidGROUND_Y - 48, facing: -1, health: 5, maxHealth: 5, skin: 'skin_classic', gun: 'sword_training', utility: id, vx: 3, onGround: true };
        try { raidDraw(); } catch (e) { drewAll = false; }
      }
      out.drewAll = drewAll;
      // the loadout preview shows the equipped charm
      mqProfile.owned.util_ward = 1; mqProfile.equipped.utility = 'util_ward';
      const lc = document.createElement('canvas'); lc.width = 400; lc.height = 400;
      mqDrawLoadout(lc, 30);
      const withCharm = lc.getContext('2d').getImageData(0, 0, 400, 400).data;
      mqProfile.equipped.utility = '';
      mqDrawLoadout(lc, 30);
      out.loadoutShowsCharm = mask(withCharm, lc.getContext('2d').getImageData(0, 0, 400, 400).data).n > 50;
      return out;
    });
    expect(r.ids.length, 'all 23 charms').toBe(23);
    for (const id of r.ids) {
      expect(r.onPlayer[id], id + ' draws a small mark on the player').toBeGreaterThan(25);
      expect(r.onPlayer[id], id + ' stays minimal - a tiny badge, not an aura').toBeLessThan(450);
      expect(r.onPlayerAnimates[id], id + ' animates on the player').toBe(true);
      expect(r.icon[id], id + ' has its own icon glyph').toBeGreaterThan(30);
      expect(r.iconAnimates[id], id + ' animates in the shop icon').toBe(true);
    }
    expect(r.unique, 'every charm looks different on the player').toBe(23);
    expect(r.comboDiffers, 'three worn charms are drawn together, differently from any single one').toBe(true);
    expect(r.comboCovers, 'three charms sit apart rather than overlapping').toBeGreaterThan(r.singlesCover * 0.85);
    expect(r.comboCovers, 'and the three together are still a small cluster').toBeLessThan(900);
    expect(r.noneSame, 'no charm (or an unknown one) changes nothing').toBe(true);
    expect(r.noCharmSame, 'noCharm switches the effect off').toBe(true);
    expect(r.drewAll, 'the raid draws every charm on both players without error').toBe(true);
    expect(r.loadoutShowsCharm, 'the loadout preview shows the equipped charm').toBe(true);
  });

  test('RAI-24 remote players, their swings and boss shots glide between network updates instead of stepping', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      // position smoothing: first sight snaps, then each draw closes part of the gap, never overshooting
      raidDisplayPos = {};
      const first = raidSmoothPos('mate', 100, 200);
      out.firstSnap = first.x === 100 && first.y === 200;
      const seq = [];
      for (let i = 0; i < 6; i++) seq.push(raidSmoothPos('mate', 120, 200).x);
      out.monotonic = seq.every((v, i) => v > (i ? seq[i - 1] : 100) && v < 120);
      for (let i = 0; i < 40; i++) raidSmoothPos('mate', 120, 200);
      out.converges = Math.abs(raidSmoothPos('mate', 120, 200).x - 120) < 0.05;
      out.snapsFar = raidSmoothPos('mate', 900, 200).x === 900; // a teleport / respawn is not slid across the arena
      // a teammate moving 14px every 2nd frame is drawn moving about 7px every frame
      raidDisplayPos = {};
      let target = 300, prev = null, maxStep = 0, maxLag = 0;
      for (let f = 0; f < 60; f++) {
        if (f % 2 === 0) target += 14;
        const d = raidSmoothPos('mate2', target, 100);
        if (prev !== null) maxStep = Math.max(maxStep, d.x - prev);
        prev = d.x;
        maxLag = Math.max(maxLag, target - d.x);
      }
      out.maxStep = maxStep; out.maxLag = maxLag;

      // swing progress: a teammate's swing is synced every other frame but plays out one frame at a time
      raidDisplaySwing = {};
      const progress = [];
      for (let f = 0; f < RAID_SWORD_SWING_FRAMES + 2; f++) {
        const synced = f % 2 === 0 ? Math.max(0, RAID_SWORD_SWING_FRAMES - f) : Math.max(0, RAID_SWORD_SWING_FRAMES - f + 1);
        progress.push(raidDisplaySwingProgress('mate', synced));
      }
      out.progress = progress;

      // host-side: untouched. Non-host: shots keep flying between the 5-frame snapshots
      raidG.projectiles = [{ x: 100, y: 100, vx: 3, vy: 1, gravity: 0.5, r: 8, life: 90, isWarning: false, isBossProjectile: true }, { x: 50, y: 50, vx: 5, vy: 0, r: 8, life: 90, isWarning: true, isBossProjectile: true }];
      raidIsHost = true; raidExtrapolateProjectiles();
      out.hostUntouched = raidG.projectiles[0].x === 100;
      raidIsHost = false; raidExtrapolateProjectiles();
      out.moved = [raidG.projectiles[0].x, raidG.projectiles[0].y, raidG.projectiles[0].vy];
      out.warningStill = raidG.projectiles[1].x === 50;
      // drawing with a teammate and a shot never throws
      raidG.players.mate = { x: 300, y: raidGROUND_Y - 48, facing: -1, health: 5, maxHealth: 5, skin: 'skin_classic', gun: 'sword_training', swingTimer: 6, swing: 0.5, swingDir: 'side', vx: 3, onGround: true };
      try { raidDraw(); raidDraw(); out.drew = true; } catch (e) { out.drew = false; }
      // a non-host draws the boss at its smoothed position but never changes the real one
      raidDisplayPos = {};
      raidIsHost = false;
      raidG.boss.x = 500; raidG.boss.y = 300; raidDraw();
      raidG.boss.x = 520; raidDraw();
      out.bossReal = raidG.boss.x;
      out.bossShown = raidDisplayPos.boss.x;
      raidIsHost = true;
      return out;
    });
    expect(r.bossReal, 'the synced boss position is left alone').toBe(520);
    expect(r.bossShown, 'a non-host draws the boss part-way to its new position').toBeGreaterThan(500);
    expect(r.bossShown).toBeLessThan(520);
    expect(r.firstSnap, 'a player seen for the first time is drawn where they are').toBe(true);
    expect(r.monotonic, 'each draw closes part of the gap without overshooting').toBe(true);
    expect(r.converges).toBe(true);
    expect(r.snapsFar, 'a big jump (respawn) snaps instead of sliding').toBe(true);
    expect(r.maxStep, 'drawn motion is smoother than the 14 px network steps').toBeLessThan(10);
    expect(r.maxLag, "smoothing never lags more than two network steps behind").toBeLessThan(28);
    expect(r.progress.every((v, i) => i === 0 || v >= r.progress[i - 1] || v === 0), 'swing progress only ever moves forward until it resets').toBe(true);
    expect(new Set(r.progress.filter((v) => v > 0)).size, 'a teammate swing shows a new pose nearly every frame').toBeGreaterThanOrEqual(11);
    expect(r.hostUntouched, 'the host already simulates shots exactly').toBe(true);
    expect(r.moved[0], 'a non-host moves a shot by its velocity').toBe(103);
    expect(r.moved[2], 'a lobbed shot also falls under its gravity').toBeCloseTo(1.5);
    expect(r.warningStill, 'warning markers do not move').toBe(true);
    expect(r.drew).toBe(true);
  });

  test('WPN-09 a sword hit shows a directional slash-impact burst on the boss; a Familiar bolt hit does not', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.gun = 'sword_training';
      T.prepBoss('grinmaw', 1);
      raidG.boss.x = 500; raidG.boss.y = 300;
      raidG.slamAnimations = [];

      // a real connecting right-swing leaves a slashHit tagged with its own direction
      T.place(500 - 60, 300 - 24); // the right slash reaches out to the boss's side
      raidLocal.swordCooldown = 0;
      raidLocal.input = { left: false, right: true, up: false, down: false, space: false };
      raidSwordSwing();
      raidLocal.input.right = false;
      for (let i = 0; i < RAID_SWORD_SWING_FRAMES; i++) {
        if (raidLocal.swingTimer > 0) raidLocal.swingTimer--;
        raidSendLocalState();
        raidCheckSwordSwings(raidG.boss);
      }
      const hits = raidG.slamAnimations.filter((a) => a.phase === 'slashHit');

      // a Familiar bolt hit carries no direction, so it keeps only the generic impact spark
      raidG.slamAnimations = [];
      raidHitBoss(raidG.boss, { x: 500, y: 300, damage: 3 });
      const boltSlash = raidG.slamAnimations.filter((a) => a.phase === 'slashHit').length;
      const boltImpact = raidG.slamAnimations.filter((a) => a.phase === 'impact').length;

      // the Familiar's bolt has its own little glowing orb (it is the only projectile the player side has)
      const bc = document.createElement('canvas'); bc.width = 40; bc.height = 40;
      drawMinionBolt(bc.getContext('2d'), { x: 20, y: 20, vx: 3, vy: -2, r: 4 });
      const boltPixels = bc.getContext('2d').getImageData(0, 0, 40, 40).data.filter((v, i) => i % 4 === 3 && v > 40).length;

      // drawing every direction (and an unknown one) paints pixels and does not throw
      let drewAll = true;
      for (const dir of ['up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright', 'side']) {
        raidG.slamAnimations = [{ x: 500, y: 300, life: 8, phase: 'slashHit', timer: 2, dir }];
        try { raidDraw(); } catch (e) { drewAll = false; }
      }
      return { count: hits.length, dir: hits[0] && hits[0].dir, life: hits[0] && hits[0].life, boltSlash, boltImpact, boltPixels, drewAll };
    });
    expect(r.count, 'one slash-impact per connecting swing').toBe(1);
    expect(r.dir).toBe('right');
    expect(r.life).toBeGreaterThan(0);
    expect(r.boltSlash, 'a Familiar bolt hit has no slash-impact').toBe(0);
    expect(r.boltImpact, 'a Familiar bolt hit keeps the generic impact spark').toBe(1);
    expect(r.boltPixels, 'the Familiar bolt is drawn').toBeGreaterThan(20);
    expect(r.drewAll, 'every swing direction draws its slash-impact without error').toBe(true);
  });

  test('WPN-20 the player is drawn smaller, feet-anchored, with a Hollow Knight-style face and horns', async ({ page }) => {
    const r = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 80; c.height = 120;
      const ctx = c.getContext('2d');
      drawPlayerCuphead(ctx, 20, 30, 36, 48, 1, 5, 5, false, 0, true, { noBar: true, noShadow: true, t: 0 });
      // feet (baseY + h = 78) must stay put regardless of the scale-down, so the character
      // doesn't sink into or float off the ground.
      const feetOpaque = ctx.getImageData(38, 77, 1, 1).data[3] > 200;
      // the body silhouette must be narrower than the full 36px hitbox width it's drawn into
      // (MQ_PLAYER_SCALE shrinks it), sampled at mid-torso. A high alpha threshold picks out the
      // solid fill itself, clear of the wide, low-alpha shadowBlur glow around the shape.
      const edgeOpaque = ctx.getImageData(20, 60, 1, 1).data[3] > 200;
      // no smiling mouth arc is drawn any more - big flat eyes only
      const eyeWhite = ctx.getImageData(28, 24, 1, 1).data;
      return { feetOpaque, edgeOpaque, eyeIsWhite: eyeWhite[0] > 200 && eyeWhite[1] > 200 && eyeWhite[2] > 200 };
    });
    expect(r.feetOpaque, 'feet stay anchored to the same ground position').toBe(true);
    expect(r.edgeOpaque, 'the old, unscaled body edge is now outside the smaller silhouette').toBe(false);
    expect(r.eyeIsWhite, 'big eye is drawn where the old smiling mouth used to be').toBe(true);
  });
});

test.describe('Difficulty (spec 8.3)', () => {
  test('DIF-01 the host chooses a difficulty which is stored on the lobby and shown to players', async ({ page }) => {
    await page.evaluate(async () => { document.getElementById('lobbyNameInput').value = 'D'; await createLobby(); });
    await page.locator('.difficulty-btn[data-difficulty="easy"]').click();
    await page.locator('.boss-pick-card[data-boss="warden"]').click();
    await expect(page.locator('#waitingDifficultyLabel')).toContainText('Easy');
    expect(await page.evaluate(() => __fb.db.get('lobbies/' + currentLobbyId + '/difficulty'))).toBe('easy');
    await page.evaluate(() => refreshLobbies());
    await expect(page.locator('.lobby-card').first()).toContainText('Easy');
    // legacy lobbies without a difficulty read as Normal
    await page.evaluate(async () => { await lobbyRef.child(currentLobbyId).child('difficulty').remove(); await refreshLobbies(); });
    await expect(page.locator('.lobby-card').first()).toContainText('Normal');
  });

  test('DIF-02 Easy/Normal/Hard scale boss HP (0.7/1/1.35) and the attack gap (1.4/1/0.7)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = { defs: JSON.parse(JSON.stringify(DIFFICULTY_DEFS)), hp: {}, gap: {} };
      for (const diff of ['easy', 'normal', 'hard']) {
        currentDifficulty = diff;
        out.hp[diff] = {};
        for (const boss of ['grinmaw', 'warden', 'wyrm', 'glutton']) {
          raidG.boss.type = boss; resetRaidState(); raidIsHost = true; // reset clears the host flag
          out.hp[diff][boss] = [raidG.boss.maxHp, raidG.boss.hp];
        }
        out.gap[diff] = [];
        for (const phase of [1, 2, 3]) {
          T.prepBoss('grinmaw', phase); raidG.boss.attackTimer = 1;
          raidBossUpdate();
          out.gap[diff].push(raidG.boss.attackTimer);
        }
      }
      return out;
    });
    expect(r.defs.easy).toMatchObject({ hpMult: 0.7, cooldownMult: 1.4 });
    expect(r.defs.normal).toMatchObject({ hpMult: 1, cooldownMult: 1 });
    expect(r.defs.hard).toMatchObject({ hpMult: 1.35, cooldownMult: 0.7 });
    const base = { grinmaw: 150, warden: 165, wyrm: 180, glutton: 160 };
    const mult = { easy: 0.7, normal: 1, hard: 1.35 };
    for (const d of Object.keys(mult)) for (const b of Object.keys(base)) {
      const hp = Math.round(base[b] * mult[d]);
      expect(r.hp[d][b], d + ' ' + b).toEqual([hp, hp]);
    }
    const gapMult = { easy: 1.4, normal: 1, hard: 0.7 };
    for (const d of Object.keys(gapMult)) {
      expect(r.gap[d], 'attack gap ' + d).toEqual([1, 2, 3].map((p) => Math.round((190 - 20 * p) * gapMult[d])));
    }
  });

  test('DIF-03 the lobby difficulty decides how many coins a win pays', async ({ page }) => {
    const paid = {};
    for (const diff of ['easy', 'normal', 'hard']) {
      await page.evaluate(async (diff) => {
        document.getElementById('lobbyNameInput').value = 'Pay ' + diff;
        await createLobby();
      }, diff);
      await page.locator(`.difficulty-btn[data-difficulty="${diff}"]`).click();
      await page.locator('.boss-pick-card[data-boss="grinmaw"]').click();
      await expect(page.locator('#waitingDifficultyLabel')).toBeVisible();
      paid[diff] = await page.evaluate(() => { raidLocal.health = 0; const before = mqProfile.coins; mqAwardRaidVictory(); return { difficulty: currentDifficulty, coins: mqProfile.coins - before }; });
      await page.evaluate(() => leaveLobby());
      await expect.poll(() => page.evaluate(() => currentLobbyId)).toBeNull();
    }
    expect(paid).toEqual({ easy: { difficulty: 'easy', coins: 60 }, normal: { difficulty: 'normal', coins: 120 }, hard: { difficulty: 'hard', coins: 250 } });
  });
});

test.describe('Math is off (spec 8.4)', () => {
  test('RAI-40 no math prompts appear in a long fight; the flag can bring them back', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = { flag: RAID_MATH_ENABLED };
      T.prepBoss('grinmaw', 3);
      raidG.boss.attackTimer = 99999; raidG.boss.lastWeakPoint = 0;
      let events = 0;
      for (let i = 0; i < 3000; i++) { T.step(1); if (raidG.mathEvent) events++; }
      out.mathEvents = events; out.shieldUi = raidShowMathUI; out.ultimate = raidG.boss.ultimateTriggered;
      // pressing shield with no charges does not open a prompt
      raidMathShieldCharges = 0; raidTryShield(); out.prompt = raidShowMathUI;
      return out;
    });
    expect(r).toEqual({ flag: false, mathEvents: 0, shieldUi: false, ultimate: false, prompt: false });
  });
});

test.describe('Coin rewards (spec 10.1)', () => {
  test('RWD-01 a win pays 60/120/250 by difficulty plus 10 per heart left', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = [];
      for (const [diff, hearts] of [['easy', 5], ['easy', 0], ['normal', 4], ['normal', 5], ['hard', 3], ['hard', 5]]) {
        currentDifficulty = diff; raidLocal.health = hearts;
        const before = mqProfile.coins;
        const reward = mqAwardRaidVictory();
        out.push([diff, hearts, mqProfile.coins - before, reward.base, reward.bonus]);
      }
      return { out, table: MQ_COIN_REWARD };
    });
    expect(r.table).toEqual({ easy: 60, normal: 120, hard: 250 });
    expect(r.out).toEqual([
      ['easy', 5, 110, 60, 50], ['easy', 0, 60, 60, 0], ['normal', 4, 160, 120, 40],
      ['normal', 5, 170, 120, 50], ['hard', 3, 280, 250, 30], ['hard', 5, 300, 250, 50]
    ]);
  });

  test('RWD-02 coins are paid exactly once per victory and never for a defeat', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      currentDifficulty = 'normal'; raidLocal.health = 5;
      const out = {};
      raidG.victory = true;
      T.step(5); const c1 = mqProfile.coins; T.step(5);
      out.oncePerVictory = [c1, mqProfile.coins];
      raidG.victory = false; T.step(1);
      raidG.victory = true; T.step(1);
      out.secondFight = mqProfile.coins;
      raidG.victory = false; raidG.gameOver = true; T.step(10);
      out.afterDefeat = mqProfile.coins;
      out.raids = mqProfile.stats.raids;
      out.saved = JSON.parse(localStorage.getItem(MQ_PROFILE_KEY)).coins;
      return out;
    });
    expect(r.oncePerVictory).toEqual([170, 170]);
    expect(r.secondFight).toBe(340);
    expect(r.afterDefeat).toBe(340);
    expect(r.raids).toBe(2);
    expect(r.saved).toBe(340);
  });

  test('RWD-03 the victory screen shows the coins earned, how they add up and the balance', async ({ page }) => {
    const texts = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      currentDifficulty = 'hard'; raidLocal.health = 4; mqProfile.coins = 0;
      raidG.victory = true; T.step(2);
      const seen = [];
      const real = raidCtx.fillText.bind(raidCtx);
      raidCtx.fillText = (t, ...a) => { seen.push(String(t)); return real(t, ...a); };
      raidDraw();
      raidCtx.fillText = real;
      return seen;
    });
    const joined = texts.join(' | ');
    expect(joined).toMatch(/VICTORY/);
    expect(joined).toMatch(/\+290 .*coins/);
    expect(joined).toMatch(/HARD fight: 250 {2}\+ {2}40 for 4 hearts left/);
    expect(joined).toMatch(/Balance: 290/);
  });
});
