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

  test('RAI-02 each player publishes position, health, shield, facing, reload, skin and gun', async ({ page }) => {
    const p = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      mqProfile.equipped.skin = 'skin_wizard'; mqProfile.owned.skin_wizard = 1;
      raidLocal.skin = 'skin_wizard'; raidLocal.gun = 'gun_standard';
      raidLocal.x = 321; raidLocal.y = 400; raidLocal.facing = -1; raidLocal.shield = true;
      raidReloadTimer = 50;
      raidSendLocalState();
      return __fb.db.get('bossRaid/9001/players/' + raidMyId);
    });
    expect(Object.keys(p)).toEqual(expect.arrayContaining(['x', 'y', 'health', 'shield', 'invincible', 'facing', 'reload', 'skin', 'gun', 'lastUpdate']));
    expect(p).toMatchObject({ x: 321, y: 400, health: 5, shield: true, facing: -1, skin: 'skin_wizard', gun: 'gun_standard' });
    expect(p.reload).toBeCloseTo(0.5, 2);
  });

  test('RAI-03 non-host shots are relayed to the host, which spawns and clears them', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      const out = {};
      // a non-host player shoots: nothing spawns locally, the shot goes to the shots node
      raidIsHost = false; raidLocal.gun = 'gun_ember';
      raidShootProjectile();
      out.localBullets = raidG.playerProjectiles.length;
      const queued = Object.values(__fb.db.get('bossRaid/9001/shots') || {});
      out.queued = queued.length; out.queuedGun = queued[0] && queued[0].gun; out.queuedHasTime = !!(queued[0] && queued[0].t);
      // still queued while we are not host (only the host consumes them)
      out.stillQueued = Object.keys(__fb.db.get('bossRaid/9001/shots') || {}).length;
      // the host receives a shot from another client
      raidIsHost = true;
      await raidShotsRef.push({ x: 400, y: 300, vx: 0, vy: -6, r: 6, life: 120, damage: 3, owner: 'other_client', gun: 'gun_frost', t: Date.now() });
      out.hostBullets = raidG.playerProjectiles.filter((p) => p.owner === 'other_client').length;
      out.hostGun = (raidG.playerProjectiles.find((p) => p.owner === 'other_client') || {}).gun;
      out.hostHasTime = 't' in (raidG.playerProjectiles.find((p) => p.owner === 'other_client') || {});
      // stale shots (> 4 s old) are dropped
      await raidShotsRef.push({ x: 400, y: 300, vx: 0, vy: -6, r: 6, life: 120, damage: 3, owner: 'stale_client', gun: 'gun_frost', t: Date.now() - 10000 });
      out.staleBullets = raidG.playerProjectiles.filter((p) => p.owner === 'stale_client').length;
      out.leftover = Object.keys(__fb.db.get('bossRaid/9001/shots') || {}).filter((k) => true).length;
      return out;
    });
    expect(r.localBullets).toBe(0);
    expect(r.queued).toBe(1);
    expect(r.queuedGun).toBe('gun_ember');
    expect(r.queuedHasTime).toBe(true);
    expect(r.stillQueued).toBe(1);
    expect(r.hostBullets).toBe(1);
    expect(r.hostGun).toBe('gun_frost');
    expect(r.hostHasTime).toBe(false);
    expect(r.staleBullets).toBe(0);
    expect(r.leftover).toBe(1); // only the non-host's own queued shot from above remains
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
  test('RAI-10 keyboard: arrows move, Z/Up jump, Space/X attack, Shift/E shields, C dashes, R reloads', async ({ page }) => {
    await page.evaluate(() => T.setupRaid('grinmaw'));
    await keyDown(page, 'ArrowLeft'); expect(await page.evaluate(() => raidLocal.input.left)).toBe(true);
    await keyUp(page, 'ArrowLeft'); expect(await page.evaluate(() => raidLocal.input.left)).toBe(false);
    await keyDown(page, 'ArrowRight'); expect(await page.evaluate(() => raidLocal.input.right)).toBe(true);
    await keyUp(page, 'ArrowRight');
    await keyDown(page, 'ArrowUp'); expect(await page.evaluate(() => raidLocal.input.up)).toBe(true);
    await keyUp(page, 'ArrowUp'); expect(await page.evaluate(() => raidLocal.input.up)).toBe(false);
    await keyDown(page, 'z'); expect(await page.evaluate(() => raidLocal.input.up)).toBe(true);
    await keyUp(page, 'z'); expect(await page.evaluate(() => raidLocal.input.up)).toBe(false);

    await keyDown(page, ' ');
    expect(await page.evaluate(() => raidAmmo)).toBe(19);
    await page.evaluate(() => { for (let i = 0; i < RAID_FIRE_DELAY; i++) raidUpdateLocal(); }); // clear the fire-rate limit (RAI-12)
    await keyDown(page, 'x'); // Hollow Knight-style "attack" - fires the gun, same as Space
    expect(await page.evaluate(() => raidAmmo)).toBe(18);
    await keyDown(page, 'e');
    expect(await page.evaluate(() => raidLocal.shield)).toBe(true);
    await page.evaluate(() => { raidLocal.shield = false; });
    await keyDown(page, 'Shift');
    expect(await page.evaluate(() => raidLocal.shield)).toBe(true);
    await keyDown(page, 'c'); // Hollow Knight-style dash key (X is "attack" now, not dash)
    expect(await page.evaluate(() => raidLocal.dashCooldown)).toBe(180);
    await keyDown(page, 'x'); // attack, not dash, while X means attack
    expect(await page.evaluate(() => raidLocal.dashCooldown)).toBe(180); // unchanged - X never dashes
    await keyDown(page, 'r');
    expect(await page.evaluate(() => raidReloadTimer)).toBe(100);
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

  test('RAI-12 shooting: 20 rounds, 7-frame delay, straight-up 3-damage bullets from the muzzle', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.place(500); raidLocal.facing = 1;
      const out = { max: raidMaxAmmo, start: raidAmmo, hud: document.getElementById('raidAmmo').textContent, fireDelay: RAID_FIRE_DELAY };
      const muzzle = raidGunMuzzle();
      raidShootProjectile(); raidShootProjectile(); // second call is inside the fire delay
      out.afterTwoCalls = raidAmmo;
      const b = raidG.playerProjectiles[raidG.playerProjectiles.length - 1];
      out.bullet = { vx: Math.abs(b.vx) < 0.3, vy: b.vy, damage: b.damage, life: b.life, gun: b.gun, atMuzzle: b.x === muzzle.x && b.y === muzzle.y };
      for (let i = 0; i < 7; i++) raidUpdateLocal();
      raidShootProjectile();
      out.afterDelay = raidAmmo;
      return out;
    });
    expect(r.max).toBe(20);
    expect(r.start).toBe(20);
    expect(r.hud).toBe('20/20');
    expect(r.fireDelay).toBe(7);
    expect(r.afterTwoCalls).toBe(19);
    expect(r.bullet).toEqual({ vx: true, vy: -6, damage: 3, life: 120, gun: 'gun_standard', atMuzzle: true });
    expect(r.afterDelay).toBe(18);
  });

  test('RAI-13 empty magazine auto-reloads for 100 frames, no shooting meanwhile, no passive ammo regen', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (let i = 0; i < 20; i++) { raidShootProjectile(); if (i < 19) for (let k = 0; k < RAID_FIRE_DELAY; k++) raidUpdateLocal(); }
      out.ammoEmpty = raidAmmo; out.timer = raidReloadTimer; out.reloadFrames = RAID_RELOAD_FRAMES;
      raidShootProjectile(); out.shotDuringReload = raidAmmo;
      for (let i = 0; i < 99; i++) raidUpdateLocal();
      out.almostDone = [raidAmmo, raidReloadTimer];
      raidUpdateLocal();
      out.done = [raidAmmo, raidReloadTimer];
      // no regen when not reloading
      raidAmmo = 12; for (let i = 0; i < 400; i++) raidUpdateLocal();
      out.noRegen = raidAmmo;
      // R reloads early; ignored when already full
      raidStartReload(); out.manual = raidReloadTimer;
      for (let i = 0; i < 100; i++) raidUpdateLocal();
      raidStartReload(); out.fullIgnored = raidReloadTimer;
      return out;
    });
    expect(r).toEqual({ ammoEmpty: 0, timer: 100, reloadFrames: 100, shotDuringReload: 0, almostDone: [0, 1], done: [20, 0], noRegen: 12, manual: 100, fullIgnored: 0 });
  });

  test('RAI-14 reload animation is visible, changes over time, syncs to teammates and shows on the HUD', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      const ringPixels = (reload) => {
        const c = document.createElement('canvas'); c.width = 120; c.height = 170;
        const ctx = c.getContext('2d');
        drawPlayerCuphead(ctx, 40, 100, 36, 48, 1, 5, 5, false, 0, true, { reload, noBar: true, noShadow: true, t: 0 });
        const d = ctx.getImageData(45, 20, 26, 26).data; // where the ring sits above the head
        let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return { ring: n, hash: Array.from(ctx.getImageData(0, 0, 120, 170).data).reduce((a, v, i) => (a + v * ((i % 97) + 1)) % 1000003, 0) };
      };
      out.noReload = ringPixels(0).ring;
      out.reloading = ringPixels(0.5).ring;
      const frames = [0, 0.1, 0.25, 0.45, 0.7, 0.9].map((p) => ringPixels(p).hash);
      out.distinctFrames = new Set(frames).size;
      raidReloadTimer = 50; raidSendLocalState();
      out.synced = __fb.db.get('bossRaid/9001/players/' + raidMyId).reload;
      raidUpdateUI(); out.hudReloading = document.getElementById('raidAmmo').textContent;
      raidReloadTimer = 0; raidUpdateUI(); out.hudNormal = document.getElementById('raidAmmo').textContent;
      return out;
    });
    expect(r.noReload).toBe(0);
    expect(r.reloading).toBeGreaterThan(50);
    expect(r.distinctFrames).toBe(6);
    expect(r.synced).toBeCloseTo(0.5, 2);
    expect(r.hudReloading).toBe('RELOADING');
    expect(r.hudNormal).toBe('20/20');
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
      const out = { cooldown: raidLocal.dashCooldown, invincible: raidLocal.invincible, vx: raidLocal.vx };
      raidLocal.vx = 0; raidTryDash(); out.secondBlocked = raidLocal.vx === 0;
      for (let i = 0; i < 179; i++) raidUpdateLocal();
      out.almost = raidLocal.dashCooldown;
      raidUpdateLocal();
      out.ready = raidLocal.dashCooldown; out.hud = (raidUpdateUI(), document.getElementById('raidDashState').textContent);
      return out;
    });
    expect(r).toEqual({ cooldown: 180, invincible: 14, vx: 12, secondBlocked: true, almost: 1, ready: 0, hud: 'READY' });
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

  test('RAI-17 movement tops out at 7 px/frame and a jump rises about 210 px', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.place(100);
      let maxV = 0;
      raidLocal.input.right = true;
      for (let i = 0; i < 100; i++) { raidUpdateLocal(); maxV = Math.max(maxV, Math.abs(raidLocal.vx)); }
      raidLocal.input.right = false;
      T.place(500); raidLocal.onGround = true;
      const groundY = raidLocal.y;
      raidLocal.input.up = true; raidUpdateLocal(); raidLocal.input.up = false;
      let minY = raidLocal.y;
      for (let i = 0; i < 120; i++) { raidUpdateLocal(); minY = Math.min(minY, raidLocal.y); }
      return { maxV, rise: groundY - minY, backOnGround: raidLocal.y === groundY };
    });
    expect(r.maxV).toBeLessThanOrEqual(7);
    expect(r.maxV).toBeGreaterThan(3);
    expect(r.rise).toBeGreaterThan(190);
    expect(r.rise).toBeLessThan(230);
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
        raidLocal.input.up = true;
        let minY = groundY;
        for (let i = 0; i < holdFrames; i++) { raidUpdateLocal(); minY = Math.min(minY, raidLocal.y); }
        raidLocal.input.up = false;
        for (let i = 0; i < 150; i++) { raidUpdateLocal(); minY = Math.min(minY, raidLocal.y); }
        return groundY - minY;
      };
      return {
        tap: jump(1),
        fullHold: jump(30),
        constants: { grav: RAID_GRAVITY, vy: RAID_JUMP_VY, holdGrav: RAID_JUMP_HOLD_GRAVITY, holdFrames: RAID_JUMP_HOLD_FRAMES }
      };
    });
    expect(r.constants).toEqual({ grav: 0.4, vy: -13, holdGrav: 0.16, holdFrames: 18 });
    // a tap behaves like the old fixed jump (unaffected by the new hold mechanic)
    expect(r.tap).toBeGreaterThan(190);
    expect(r.tap).toBeLessThan(230);
    expect(r.fullHold, 'holding the whole way up rises well beyond a tap').toBeGreaterThan(r.tap + 60);
    expect(r.fullHold).toBeLessThan(380);
  });

  test('RAI-18 the boss hit area is sized per boss - the Wyrm is wider than the old fixed 50px box', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('wyrm');
      const out = { table: JSON.parse(JSON.stringify(BOSS_HITBOX)) };
      const hitAt = (type, dx, dy) => {
        T.prepBoss(type, 1);
        const b = raidG.boss;
        const hp0 = b.hp;
        raidG.playerProjectiles = [{ x: b.x + dx, y: b.y + dy, vx: 0, vy: 0, life: 50, damage: 3, r: 6 }];
        raidBossUpdate();
        return hp0 - b.hp;
      };
      out.wyrmWideEdge = hitAt('wyrm', 80, 0); // outside the old fixed box, inside the Wyrm's wider one
      out.wyrmBeyond = hitAt('wyrm', 140, 0); // outside even the wider box
      out.grinmawNear = hitAt('grinmaw', 40, 0);
      out.grinmawBeyond = hitAt('grinmaw', 80, 0); // same spot that hits the wider Wyrm misses the narrower Grinmaw
      return out;
    });
    expect(r.table).toEqual({
      grinmaw: { hw: 58, hh: 58 }, warden: { hw: 50, hh: 65 }, wyrm: { hw: 105, hh: 55 }, glutton: { hw: 58, hh: 58 },
      bramblehide: { hw: 70, hh: 50 }, colossus: { hw: 55, hh: 85 }, griffon: { hw: 95, hh: 60 }
    });
    expect(r.wyrmWideEdge).toBe(3);
    expect(r.wyrmBeyond).toBe(0);
    expect(r.grinmawNear).toBe(3);
    expect(r.grinmawBeyond).toBe(0);
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
      raidLocal.input.up = true;
      raidUpdateLocal();
      raidLocal.input.up = false;
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
  test('WPN-01 the weapon slot shoots with a gun and swings with a sword', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.gun = 'gun_standard';
      raidAmmo = raidMaxAmmo; raidFireCooldown = 0; raidReloadTimer = 0;
      raidG.playerProjectiles = [];
      raidAttack();
      const shot = raidG.playerProjectiles.length === 1 && raidG.playerProjectiles[0].kind !== 'melee';

      raidLocal.gun = 'sword_training';
      raidLocal.swordCooldown = 0; raidLocal.swingTimer = 0;
      const ammoBefore = raidAmmo;
      raidAttack();
      return { shot, swung: raidLocal.swingTimer > 0, ammoUnchanged: raidAmmo === ammoBefore };
    });
    expect(r.shot).toBe(true);
    expect(r.swung).toBe(true);
    expect(r.ammoUnchanged, 'a sword swing does not touch the gun magazine').toBe(true);
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

      // a melee hit is resolved directly against the boss, never through the bullet array
      const c = document.createElement('canvas'); c.width = 40; c.height = 40;
      const ctx = c.getContext('2d');
      drawPlayerBullet(ctx, { x: 20, y: 20, r: 6, kind: 'melee', gun: 'sword_training' });
      const drewNothing = ctx.getImageData(0, 0, 40, 40).data.every((v, i) => i % 4 !== 3 || v === 0);

      return { startedFull, missedHit, connected, cooldownSet, secondBlocked, drewNothing };
    });
    expect(r.startedFull, 'the swing animation plays even on a miss').toBe(true);
    expect(r.missedHit, 'out of reach deals no damage').toBe(true);
    expect(r.connected, 'in reach deals RAID_SWORD_DAMAGE exactly once').toBe(true);
    expect(r.cooldownSet).toBe(true);
    expect(r.secondBlocked, 'cooldown blocks an immediate second swing').toBe(true);
    expect(r.drewNothing, 'a melee hit never renders as a bullet').toBe(true);
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

      // Grounded, boss directly overhead (close enough for the shorter up-swing box to reach,
      // far enough that the wider-but-shallower side box does not): an up-swing should connect,
      // a plain side swing should not.
      raidG.boss.x = 500; raidG.boss.y = 310;
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

      // Absolute, not facing-relative: facing right but holding Left must still aim left.
      raidLocal.gun = 'sword_training';
      raidLocal.facing = 1;
      raidLocal.input = { left: true, right: false, up: false, down: false, space: false };
      raidLocal.swordCooldown = 0;
      raidSwordSwing();
      out.dirWasLeft = raidLocal.swingDir === 'left';
      const boxLeft = raidSwordHitbox(raidLocal);
      out.hitboxLeftOfCenter = boxLeft.cx < raidPx(raidLocal);

      // Same again facing left (mirrored) - the hitbox offset must be identical (still absolute).
      raidLocal.facing = -1;
      const boxLeftMirrored = raidSwordHitbox(raidLocal);
      out.hitboxUnaffectedByFacing = boxLeftMirrored.cx === boxLeft.cx;

      // Direct raidSwordHitbox checks for 'right' and one diagonal.
      const pRight = { x: 300, y: 452, facing: 1, swingDir: 'right', utility: '' };
      const boxRight = raidSwordHitbox(pRight);
      out.rightOffsetPositive = boxRight.cx > raidPx(pRight);
      out.rightNarrowVertically = boxRight.hh === RAID_SWORD_RANGE_Y; // same height as the side swing

      const pDiag = { x: 300, y: 452, facing: 1, swingDir: 'downright', utility: '' };
      const boxDiag = raidSwordHitbox(pDiag);
      out.diagOffsetRightAndDown = boxDiag.cx > raidPx(pDiag) && boxDiag.cy > pDiag.y + 24;

      // Connect/miss: place the boss diagonally down-right of the player, downright swing connects,
      // a plain up swing does not.
      const stepSwing = () => {
        for (let i = 0; i < RAID_SWORD_SWING_FRAMES; i++) {
          if (raidLocal.swingTimer > 0) raidLocal.swingTimer--;
          raidSendLocalState();
          raidCheckSwordSwings(raidG.boss);
        }
      };
      raidG.boss.x = 500 + RAID_SWORD_DIAG_REACH; raidG.boss.y = 452 + RAID_SWORD_DIAG_REACH;
      T.place(500);
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
      hpBefore = raidG.boss.hp;
      raidSwordSwing();
      raidLocal.input.up = false;
      stepSwing();
      out.upMissesDiagonalTarget = raidG.boss.hp === hpBefore;

      return out;
    });
    expect(r.resolved).toEqual(r.expected);
    expect(r.dirWasLeft).toBe(true);
    expect(r.hitboxLeftOfCenter, 'holding Left aims left regardless of facing').toBe(true);
    expect(r.hitboxUnaffectedByFacing, 'the hitbox is absolute, not mirrored by facing').toBe(true);
    expect(r.rightOffsetPositive).toBe(true);
    expect(r.rightNarrowVertically).toBe(true);
    expect(r.diagOffsetRightAndDown).toBe(true);
    expect(r.dirWasDownright).toBe(true);
    expect(r.downrightConnects, 'a downright swing reaches a target diagonally down-right').toBe(true);
    expect(r.upMissesDiagonalTarget, 'a plain up swing does not reach a diagonal target').toBe(true);
  });

  test('WPN-04 the sword swing\'s slash trail is white regardless of the blade\'s own color', async ({ page }) => {
    const r = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 100; c.height = 100;
      const ctx = c.getContext('2d');
      ctx.translate(50, 70);
      // sword_frost has a blue blade/glow - if the trail picked up the sword's own color instead
      // of white, this pixel would read blue-ish, not white.
      mqDrawSword(ctx, 'sword_frost', 0, 0, 1, 0.5, 5, 'side');
      const d = ctx.getImageData(0, 0, 100, 100).data;
      let whitePixel = false;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 230 && d[i + 1] > 230 && d[i + 2] > 230 && d[i + 3] > 80) { whitePixel = true; break; }
      }
      return { whitePixel };
    });
    expect(r.whitePixel, 'the slash trail renders a bright white stroke').toBe(true);
  });

  test('WPN-10 the swing reaches far: a wide hitbox and a big white crescent that covers it', async ({ page }) => {
    const r = await page.evaluate(() => {
      const base = { x: 300, y: 452, facing: 1, utility: '' };
      const side = raidSwordHitbox(Object.assign({ swingDir: 'side' }, base));
      const right = raidSwordHitbox(Object.assign({ swingDir: 'right' }, base));
      const up = raidSwordHitbox(Object.assign({ swingDir: 'up' }, base));
      const cx = raidPx(base);
      const reachSide = (side.cx + side.hw) - cx;
      const reachRight = (right.cx + right.hw) - cx;
      const reachUp = (base.y - (up.cy - up.hh)); // how far above the player's top edge the up box extends
      const down = raidSwordHitbox(Object.assign({ swingDir: 'down' }, base));

      // Draws the swing at its peak and returns the pixel alpha at (dx, dy) from the hand.
      const alphaAt = (facing, swing, slashScale, dx, dy, id, dir) => {
        const c = document.createElement('canvas'); c.width = 500; c.height = 500;
        const ctx = c.getContext('2d');
        mqDrawWeapon(ctx, id || 'sword_frost', 250, 250, facing, 0, 0, swing, 5, dir || 'side', slashScale);
        const px = ctx.getImageData(250 + dx, 250 + dy, 1, 1).data;
        return { a: px[3], rgb: [px[0], px[1], px[2]] };
      };
      const R = RAID_SWORD_SLASH_R;
      const far = alphaAt(1, 0.45, 1, Math.round(R * 0.9), 0);       // inside the big crescent, forward
      const farMirror = alphaAt(-1, 0.45, 1, -Math.round(R * 0.9), 0); // mirrored for a left-facing player
      const off = alphaAt(1, 0.45, 0, Math.round(R * 0.9), 0);         // crescent off (shop preview, ghosts)
      const idle = alphaAt(1, 0, 1, Math.round(R * 0.9), 0);           // no swing, nothing drawn
      const behind = alphaAt(1, 0.45, 1, -Math.round(R * 0.9), 0);     // the crescent is in front, not behind
      // The old small swing is gone from the live swing: where the swinging blade and its little
      // trail arcs used to be (forward of the hand, ~42px out) is empty now, and the blade just
      // rests at its held angle (up and back from the hand) instead of sweeping.
      const oldTrailSpot = alphaAt(1, 0.45, 1, 40, -11, 'sword_training');
      const restingBlade = alphaAt(1, 0.45, 1, -19, -23, 'sword_training');
      const previewTrailSpot = alphaAt(1, 0.45, undefined, 40, -11, 'sword_training'); // the shop preview (no slashScale) keeps its small swing
      // The slash is a forward arc (about 160 degrees) that sweeps from the TOP to the BOTTOM as
      // the swing plays, and does not surround the player. ptAt samples a point at fraction u along
      // the arc (0 = top end, 1 = bottom end) at a fraction of the radius.
      const ptAt = (swing, u, rad) => {
        const ang = -1.4 + u * 2.8;
        return alphaAt(1, swing, 1, Math.round(R * rad * Math.cos(ang)), Math.round(R * rad * Math.sin(ang) * RAID_SWORD_SLASH_SQUASH));
      };
      const topEarly = ptAt(0.2, 0.1, 0.9);
      const bottomEarly = ptAt(0.2, 0.65, 0.95);
      const topLate = ptAt(0.6, 0.1, 0.9);
      const bottomLate = ptAt(0.6, 0.65, 0.95);
      const backAng = (150 * Math.PI) / 180; // well behind the swing, round toward the player
      const surrounds = alphaAt(1, 0.45, 1, Math.round(R * 0.9 * Math.cos(backAng)), Math.round(R * 0.9 * Math.sin(backAng)));
      // thickness along the ray through the arc at fraction u (swing 0.45: both u are drawn)
      const widthAt = (u) => {
        const c = document.createElement('canvas'); c.width = 500; c.height = 500;
        const ctx = c.getContext('2d');
        mqDrawWeapon(ctx, 'sword_frost', 250, 250, 1, 0, 0, 0.45, 5, 'side', 1);
        const ang = -1.4 + u * 2.8; let n = 0;
        for (let rr = R * 0.4; rr < R * 1.1; rr += 1) {
          const px = ctx.getImageData(250 + Math.round(rr * Math.cos(ang)), 250 + Math.round(rr * Math.sin(ang) * RAID_SWORD_SLASH_SQUASH), 1, 1).data;
          if (px[3] > 25) n++;
        }
        return n;
      };
      const widthNearTop = widthAt(0.35), widthAtApex = widthAt(0.5);
      // up / down are the side slash rotated a quarter turn: same shape, same reach
      const upPt = (dir, swing, u, rad) => {
        const ang = -1.4 + u * 2.8;
        const lx = R * rad * Math.cos(ang), ly = R * rad * Math.sin(ang) * RAID_SWORD_SLASH_SQUASH; // the side arc, before rotating
        const [wx, wy] = dir === 'up' ? [ly, -lx] : [-ly, lx]; // rotated a quarter turn up / down
        return alphaAt(1, swing, 1, Math.round(wx), Math.round(wy), 'sword_training', dir);
      };
      const upApex = upPt('up', 0.45, 0.5, 0.9), upWide = upPt('up', 0.45, 0.7, 0.96), upWideEarly = upPt('up', 0.2, 0.7, 0.96);
      const downApex = upPt('down', 0.45, 0.5, 0.9);
      // compressed vertically: the top and bottom ends sit close together (well inside the radius)
      const slashHeight = 2 * R * Math.sin(1.4) * RAID_SWORD_SLASH_SQUASH;
      return { reachSide, reachRight, reachUp, R, far, farMirror, off, idle, behind, oldTrailSpot, restingBlade, previewTrailSpot, topEarly, bottomEarly, topLate, bottomLate, surrounds, widthNearTop, widthAtApex, slashHeight, sideHh: side.hh, upHw: up.hw, upHh: up.hh, downHw: down.hw, downHh: down.hh, upApex, upWide, upWideEarly, downApex, squash: RAID_SWORD_SLASH_SQUASH };
    });
    expect(r.reachSide, 'side swing reaches well past the old 80px').toBeGreaterThanOrEqual(120);
    expect(r.reachRight).toBeGreaterThanOrEqual(120);
    expect(r.upHh * 2, 'up reaches exactly as far as the side swing - the player always has the same reach').toBe(r.reachSide);
    expect(r.downHh * 2, 'and so does down').toBe(r.reachSide);
    expect(r.upHw, 'up/down are the side swing turned a quarter - same height becomes their width').toBe(r.sideHh);
    expect(r.downHw).toBe(r.sideHh);
    expect(r.upApex.a, 'the up slash is the side slash rotated up: its far point is straight above').toBeGreaterThan(40);
    expect(r.downApex.a, 'the down slash points straight down').toBeGreaterThan(40);
    expect(r.upWide.a, 'it has the same arc shape, swept round the head').toBeGreaterThan(40);
    expect(r.upWideEarly.a, 'and it sweeps across rather than appearing all at once').toBe(0);
    expect(r.R, 'the crescent is sized to the reach').toBeGreaterThanOrEqual(120);
    expect(r.far.a, 'a big crescent is drawn out at the swing\'s reach').toBeGreaterThan(60);
    expect(Math.min(...r.far.rgb), 'and it is white, not the blade\'s own colour').toBeGreaterThan(200);
    expect(r.farMirror.a, 'mirrored for a left-facing player').toBeGreaterThan(60);
    expect(r.off.a, 'no crescent when slashScale is 0 (dash afterimages)').toBe(0);
    expect(r.idle.a, 'nothing when not swinging').toBe(0);
    expect(r.behind.a, 'the crescent sweeps in front of the player').toBe(0);
    expect(r.oldTrailSpot.a, 'the old small trail arcs are gone from the live swing').toBe(0);
    expect(r.restingBlade.a, 'the blade rests at its held angle instead of swinging').toBeGreaterThan(100);
    expect(r.previewTrailSpot.a, 'the shop preview still draws its own small swing').toBeGreaterThan(0);
    expect(r.topEarly.a, 'the swing starts at the top of the arc').toBeGreaterThan(40);
    expect(r.bottomEarly.a, 'and has not reached the bottom yet').toBe(0);
    expect(r.bottomLate.a, 'it sweeps down to the bottom').toBeGreaterThan(40);
    expect(r.topLate.a, 'and the top has faded away by then').toBe(0);
    expect(r.surrounds.a, 'the slash does not wrap round behind the player').toBe(0);
    expect(r.widthAtApex, 'the slash is narrower at its farthest point than near its top').toBeLessThan(r.widthNearTop);
    expect(r.widthAtApex).toBeGreaterThan(5);
    expect(r.squash, 'the arc is compressed vertically so its top and bottom sit closer together').toBeLessThan(0.7);
    expect(r.slashHeight, 'the whole slash is much shorter than it is far-reaching').toBeLessThan(r.R * 1.2);
    expect(r.sideHh, 'the side hitbox is no taller than the slash it covers').toBeLessThanOrEqual(r.slashHeight / 2 + 10);
  });

  test('WPN-03 the utility slot: Swift Boots, Vital Core, Feather Cloak, Quick Hands, Lucky Charm and Warding Sigil each apply their effect', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};

      raidLocal.utility = 'util_boots';
      out.dashCooldown = raidDashCooldownFrames(); // 180 * 0.75

      raidLocal.utility = 'util_heart';
      out.maxHealth = raidMaxHealthForLoadout(); // 5 + 1

      raidLocal.utility = 'util_feather';
      out.jumpHold = raidJumpHoldFrames(); // round(18 * 1.3)

      raidLocal.utility = 'util_hands';
      out.reloadFrames = raidReloadFrames(); // round(100 * 0.8)

      raidLocal.utility = null;
      out.reloadDefault = raidReloadFrames();

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
    expect(r.jumpHold).toBe(23);
    expect(r.reloadFrames).toBe(80);
    expect(r.reloadDefault).toBe(100);
    expect(r.wardAbsorbed, 'the first hit is absorbed and marks wardUsed').toBe(true);
    expect(r.secondHitLandsAfterWard, 'only the first hit per raid is warded').toBe(true);
    expect(r.coinBonus).toBe(187);
  });

  test('WPN-03 the 10 new charms: Nimble Treads, Iron Skin, Reinforced Plating, Mending Charm, Long Reach, Phantom Step, Extended Mag and Overclock Coil each apply their effect', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};

      raidLocal.utility = 'util_boots2';
      out.maxSpeed = raidMaxSpeed(); // 7 * 1.15

      raidLocal.utility = 'util_iron';
      out.knockbackMult = raidKnockbackMult(); // 0.5

      raidLocal.utility = 'util_shield';
      out.shieldDuration = raidShieldDurationFrames(); // round(90 * 1.3)

      raidLocal.utility = 'util_regen';
      out.shieldRegen = raidShieldRegenFrames(); // round(420 / 1.5)

      raidLocal.utility = 'util_range';
      out.attackRangeMult = raidAttackRangeMult(); // 1.25
      out.swordHitbox = raidSwordHitbox({ x: 300, y: 452, facing: 1, swingDir: 'side', utility: 'util_range' });
      out.expectedSwordHitbox = { cx: 318, cy: 476, hw: RAID_SWORD_RANGE_X * 1.25, hh: RAID_SWORD_RANGE_Y * 1.25 }; // Long Reach: +25% on the base box

      raidLocal.utility = 'util_dashi';
      out.dashIframes = raidDashInvincibleFrames(); // round(14 * 1.5)

      raidLocal.utility = 'util_ammo';
      out.magSize = raidMagSizeForLoadout(); // round(20 * 1.5)

      raidLocal.utility = 'util_swift_reload';
      out.overclockReload = raidReloadFrames(); // round(100 * 0.65)

      raidLocal.utility = null;
      out.defaultSpeed = raidMaxSpeed();
      out.defaultKnockback = raidKnockbackMult();
      out.defaultShieldDuration = raidShieldDurationFrames();
      out.defaultShieldRegen = raidShieldRegenFrames();
      out.defaultRangeMult = raidAttackRangeMult();
      out.defaultDashIframes = raidDashInvincibleFrames();
      out.defaultMagSize = raidMagSizeForLoadout();
      return out;
    });
    expect(r.maxSpeed).toBeCloseTo(8.05, 5);
    expect(r.knockbackMult).toBe(0.5);
    expect(r.shieldDuration).toBe(117);
    expect(r.shieldRegen).toBe(280);
    expect(r.attackRangeMult).toBe(1.25);
    expect(r.swordHitbox).toEqual(r.expectedSwordHitbox);
    expect(r.dashIframes).toBe(21);
    expect(r.magSize).toBe(30);
    expect(r.overclockReload).toBe(65);
    // defaults (no utility equipped) are unaffected
    expect(r.defaultSpeed).toBe(7);
    expect(r.defaultKnockback).toBe(1);
    expect(r.defaultShieldDuration).toBe(90);
    expect(r.defaultShieldRegen).toBe(420);
    expect(r.defaultRangeMult).toBe(1);
    expect(r.defaultDashIframes).toBe(14);
    expect(r.defaultMagSize).toBe(20);
  });

  test('WPN-06 Second Wind grants exactly one extra jump in the air, refilled on landing, and only while equipped', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      // Edge-detected: press (up true on a frame where it was false before), then release,
      // so a held key can't be mistaken for a fresh press on the next attempt.
      const pressJump = () => {
        raidLocal.input.up = true; raidUpdateLocal();
        raidLocal.input.up = false; raidUpdateLocal();
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
      const afterAirJump = { vy: raidLocal.vy, used: raidLocal.airJumpsUsed };
      // a second air jump is blocked (only one charge) - still falling, no second boost
      raidLocal.vy = 2;
      pressJump();
      const secondBlocked = raidLocal.vy > 0;
      // landing refills it
      T.place(500, raidGROUND_Y - 48); raidLocal.onGround = false;
      raidUpdateLocal(); // lands, onGround becomes true, airJumpsUsed resets
      const refilled = raidLocal.airJumpsUsed === 0;
      return { noCharmBlocked, afterAirJump, secondBlocked, refilled };
    });
    expect(r.noCharmBlocked, 'no extra jump without the charm').toBe(true);
    expect(r.afterAirJump.vy).toBeLessThan(0);
    expect(r.afterAirJump.used).toBe(1);
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
      const box = raidSwordHitbox(raidLocal);
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
      const sideBox = raidSwordHitbox(raidLocal);
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

  test('WPN-09 a sword hit shows a directional slash-impact burst on the boss; a bullet hit does not', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.gun = 'sword_training';
      T.prepBoss('grinmaw', 1);
      raidG.boss.x = 500; raidG.boss.y = 300;
      raidG.slamAnimations = [];

      // a real connecting right-swing leaves a slashHit tagged with its own direction
      T.place(500 - RAID_SWORD_RANGE_X / 2, 300 - 24);
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

      // a bullet hit carries no direction, so it keeps only the generic impact spark
      raidG.slamAnimations = [];
      raidHitBoss(raidG.boss, { x: 500, y: 300, damage: 3 });
      const bulletSlash = raidG.slamAnimations.filter((a) => a.phase === 'slashHit').length;
      const bulletImpact = raidG.slamAnimations.filter((a) => a.phase === 'impact').length;

      // drawing every direction (and an unknown one) paints pixels and does not throw
      let drewAll = true;
      for (const dir of ['up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright', 'side']) {
        raidG.slamAnimations = [{ x: 500, y: 300, life: 8, phase: 'slashHit', timer: 2, dir }];
        try { raidDraw(); } catch (e) { drewAll = false; }
      }
      return { count: hits.length, dir: hits[0] && hits[0].dir, life: hits[0] && hits[0].life, bulletSlash, bulletImpact, drewAll };
    });
    expect(r.count, 'one slash-impact per connecting swing').toBe(1);
    expect(r.dir).toBe('right');
    expect(r.life).toBeGreaterThan(0);
    expect(r.bulletSlash, 'a bullet hit has no slash-impact').toBe(0);
    expect(r.bulletImpact, 'a bullet hit keeps the generic impact spark').toBe(1);
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
