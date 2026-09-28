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
      grinmaw: { hw: 58, hh: 58 }, warden: { hw: 50, hh: 65 }, wyrm: { hw: 105, hh: 55 }, glutton: { hw: 58, hh: 58 }
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

  test('WPN-02 a sword swing damages the boss in reach, misses out of reach, respects its cooldown and never draws as a bullet', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      raidLocal.gun = 'sword_training';
      raidLocal.facing = 1;

      // out of reach: grounded, boss is well overhead
      T.place(500);
      raidLocal.swordCooldown = 0;
      let hpBefore = raidG.boss.hp;
      raidSwordSwing();
      const missPlayed = raidLocal.swingTimer === RAID_SWORD_SWING_FRAMES;
      const missedHit = raidG.boss.hp === hpBefore;

      // in reach: jump up to the boss's height
      T.place(raidG.boss.x, raidG.boss.y - 24);
      raidLocal.swordCooldown = 0;
      hpBefore = raidG.boss.hp;
      raidSwordSwing();
      raidBossUpdate(); // resolves the pushed melee "hit" the same way a bullet is resolved
      const connected = raidG.boss.hp === hpBefore - RAID_SWORD_DAMAGE;
      const cooldownSet = raidLocal.swordCooldown === RAID_SWORD_COOLDOWN_FRAMES;

      // cooldown blocks an immediate second swing
      hpBefore = raidG.boss.hp;
      raidSwordSwing();
      raidBossUpdate();
      const secondBlocked = raidG.boss.hp === hpBefore;

      // the melee "hit" reuses the bullet array but must never render as a floating bullet
      const c = document.createElement('canvas'); c.width = 40; c.height = 40;
      const ctx = c.getContext('2d');
      drawPlayerBullet(ctx, { x: 20, y: 20, r: 6, kind: 'melee', gun: 'sword_training' });
      const drewNothing = ctx.getImageData(0, 0, 40, 40).data.every((v, i) => i % 4 !== 3 || v === 0);

      return { missPlayed, missedHit, connected, cooldownSet, secondBlocked, drewNothing };
    });
    expect(r.missPlayed, 'the swing animation plays even on a miss').toBe(true);
    expect(r.missedHit, 'out of reach deals no damage').toBe(true);
    expect(r.connected, 'in reach deals RAID_SWORD_DAMAGE').toBe(true);
    expect(r.cooldownSet).toBe(true);
    expect(r.secondBlocked, 'cooldown blocks an immediate second swing').toBe(true);
    expect(r.drewNothing, 'a melee hit never renders as a bullet').toBe(true);
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
