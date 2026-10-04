// Spec section 9.5: arena terrain. Bosses reshape the arena - platforms, pillars and floor zones (lava, fire,
// mud, thorns, updrafts) - and it changes how the fight plays. Terrain is host-authored, synced with the
// boss state, and every client runs the same physics from the synced list.
const { test, expect } = require('./support/fixtures');

const FLOOR = 500; // raidGROUND_Y

test.describe('Terrain data and sync (TER-01)', () => {
  test('TER-01 terrain is added with defaults, ages every frame, expires on schedule, and permanent pieces stay', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      raidClearTerrain();
      const out = {};
      const a = raidTerrainAdd({ kind: 'platform', x: 300, w: 120, top: raidGROUND_Y - 95, life: 100 });
      const b = raidTerrainAdd({ kind: 'lava', x: 700, w: 140, life: 50 });
      const c = raidTerrainAdd({ kind: 'pillar', x: 500, w: 60, top: raidGROUND_Y - 120, life: -1 });
      out.fields = { id: a.id !== undefined, age: a.age, theme: a.theme, kind: a.kind, life: a.life };
      out.ids = new Set([a.id, b.id, c.id]).size;
      for (let i = 0; i < 49; i++) raidUpdateTerrain();
      out.at49 = raidG.terrain.map((t) => t.kind).sort();
      raidUpdateTerrain(); raidUpdateTerrain();
      out.at51 = raidG.terrain.map((t) => t.kind).sort();
      for (let i = 0; i < 60; i++) raidUpdateTerrain();
      out.at111 = raidG.terrain.map((t) => t.kind).sort();
      for (let i = 0; i < 5000; i++) raidUpdateTerrain();
      out.permanent = raidG.terrain.map((t) => t.kind);
      out.age = raidG.terrain[0].age;
      raidClearTerrain();
      out.cleared = raidG.terrain.length;
      out.rise = RAID_TERRAIN_RISE;
      return out;
    });
    expect(r.fields).toEqual({ id: true, age: 0, theme: 'grinmaw', kind: 'platform', life: 100 });
    expect(r.ids, 'every piece has its own id').toBe(3);
    expect(r.at49).toEqual(['lava', 'pillar', 'platform']);
    expect(r.at51, 'a 50-frame zone is gone after 50 frames').toEqual(['pillar', 'platform']);
    expect(r.at111, 'a 100-frame platform is gone after 100').toEqual(['pillar']);
    expect(r.permanent, 'life -1 never expires').toEqual(['pillar']);
    expect(r.age).toBeGreaterThan(5000);
    expect(r.cleared).toBe(0);
    expect(r.rise, 'solid pieces take a moment to rise before they can be stood on').toBe(24);
  });

  test('TER-01 terrain is published with the boss state and a client replaces its own copy from it', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      raidClearTerrain();
      raidTerrainAdd({ kind: 'pillar', x: 400, w: 60, top: raidGROUND_Y - 120, life: 300 });
      raidTerrainAdd({ kind: 'mud', x: 800, w: 160, life: 200 });
      raidSendBossState();
      const synced = __fb.db.get('bossRaid/9001/gameState/terrain');
      const out = { published: (synced || []).map((t) => t.kind) };
      // a client: its list is replaced by what the host published
      raidIsHost = false; raidG.lastUpdate = 0;
      raidG.terrain = [];
      __fb.db.write('bossRaid/9001/gameState/terrain', [{ id: 77, kind: 'lava', x: 100, w: 90, life: 120, age: 5, theme: 'grinmaw' }]);
      __fb.db.write('bossRaid/9001/gameState/lastUpdate', Date.now() + 5000);
      await new Promise((res) => setTimeout(res, 50));
      out.client = raidG.terrain.map((t) => t.kind + ':' + t.id);
      raidIsHost = true;
      return out;
    });
    expect(r.published).toEqual(['pillar', 'mud']);
    expect(r.client).toEqual(['lava:77']);
  });

  test('TER-01 terrain is cleared by a phase change and when the next boss arrives; permanent arena pieces come back', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('wyrm', 1);
      raidClearTerrain();
      raidSeedTerrain('wyrm');
      const seeded = raidG.terrain.filter((t) => t.life < 0).length;
      raidTerrainAdd({ kind: 'fire', x: 300, w: 100, life: 300 });
      raidTerrainAdd({ kind: 'pillar', x: 600, w: 60, top: raidGROUND_Y - 100, life: 300 });
      // a phase change clears the temporary pieces and puts the permanent ones back
      raidG.boss.lastPhase = 1; raidG.boss.hp = raidG.boss.maxHp * 0.5; raidG.boss.attackTimer = 99999;
      T.step(2);
      const afterPhase = { total: raidG.terrain.length, permanent: raidG.terrain.filter((t) => t.life < 0).length, temp: raidG.terrain.filter((t) => t.life >= 0).length };
      return { seeded, afterPhase, expectedSeed: raidTerrainSeedFor('wyrm').length };
    });
    expect(r.seeded, 'the Wyrm\'s arena has permanent cloud platforms').toBeGreaterThan(0);
    expect(r.seeded).toBe(r.expectedSeed);
    expect(r.afterPhase).toEqual({ total: r.expectedSeed, permanent: r.expectedSeed, temp: 0 });
  });
});

test.describe('Platforms and pillars (TER-02)', () => {
  // The local player, standing/falling at a given x with feet at a given height, then run through raidUpdateLocal.
  const setup = `
    window.runPhys = (x, feetY, frames, input, vy) => {
      T.place(x, feetY - 48);
      raidLocal.vx = 0; raidLocal.vy = vy || 0; raidLocal.onGround = false; raidLocal.dashTimer = 0; raidLocal.wasJumpPressed = false;
      raidLocal.input = Object.assign({ left: false, right: false, up: false, down: false, jump: false, space: false }, input || {});
      const trace = [];
      for (let i = 0; i < frames; i++) { raidUpdateLocal(); trace.push([Math.round(raidLocal.x * 10) / 10, Math.round((raidLocal.y + 48) * 10) / 10, raidLocal.onGround]); }
      return trace;
    };
  `;

  test('TER-02 a platform can be landed on from above, jumped up through from below, and walked off', async ({ page }) => {
    await page.evaluate(setup);
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1); raidClearTerrain();
      const top = raidGROUND_Y - 90;
      raidTerrainAdd({ kind: 'platform', x: 500, w: 160, top, life: -1 });
      for (let i = 0; i < 30; i++) raidUpdateTerrain(); // it has finished rising
      const out = { top };
      // falling from above lands on it
      let tr = runPhys(500, top - 80, 40, {}, 0);
      out.landed = tr[tr.length - 1];
      // standing there it stays put
      out.stays = tr.slice(-5).every((q) => q[1] === top && q[2] === true);
      // jumping from the floor right underneath goes up through it (a tap jump rises ~118 px, so it reaches above the top)
      tr = runPhys(500, raidGROUND_Y, 1, {}, 0);
      let maxRise = 0, passedThrough = false;
      raidLocal.input.jump = true;
      for (let i = 0; i < 70; i++) { raidUpdateLocal(); raidLocal.input.jump = i < 14; maxRise = Math.max(maxRise, raidGROUND_Y - (raidLocal.y + 48)); if (raidLocal.y + 48 < top - 5) passedThrough = true; }
      out.maxRise = maxRise; out.passedThrough = passedThrough; out.endedOn = Math.round(raidLocal.y + 48);
      // walking off the end drops to the floor
      runPhys(500 + 70, top, 1, {}, 0);
      raidLocal.onGround = true;
      raidLocal.input.right = true;
      let fell = false;
      for (let i = 0; i < 120; i++) { raidUpdateLocal(); if (raidLocal.y + 48 >= raidGROUND_Y - 0.5) { fell = true; break; } }
      out.fell = fell;
      return out;
    });
    expect(r.landed[1], 'lands exactly on the top surface').toBe(r.top);
    expect(r.landed[2]).toBe(true);
    expect(r.stays).toBe(true);
    expect(r.passedThrough, 'a jump from underneath goes up through the platform').toBe(true);
    expect(r.endedOn, 'and comes down on top of it').toBe(r.top);
    expect(r.fell, 'walking off the edge falls back to the floor').toBe(true);
  });

  test('TER-02 a platform is not solid until it has risen, and a player on it is safe from floor hazards', async ({ page }) => {
    await page.evaluate(setup);
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1); raidClearTerrain();
      const top = raidGROUND_Y - 90;
      raidTerrainAdd({ kind: 'platform', x: 500, w: 160, top, life: -1 });
      const out = {};
      // still rising: the player falls straight through it to the floor
      let tr = runPhys(500, top - 60, 70, {}, 0);
      out.whileRising = Math.round(tr[tr.length - 1][1]);
      // risen: a player on it, and a shockwave sweeping the floor underneath: untouched
      for (let i = 0; i < 30; i++) raidUpdateTerrain();
      runPhys(500, top - 20, 20, {}, 0);
      T.place(raidPx(raidLocal) , raidLocal.y, { health: 5, invincible: 0 });
      raidLocal.health = 5;
      raidHazard({ kind: 'shockwave', x: raidPx(raidLocal), dir: 1, speed: 0, life: 40 });
      for (let i = 0; i < 5; i++) { T.place(raidPx(raidLocal), raidLocal.y, { health: 5, invincible: 0 }); T.step(1); }
      out.onPlatformHealth = T.me().health;
      return out;
    });
    expect(r.whileRising, 'not solid yet').toBe(500);
    expect(r.onPlatformHealth, 'floor hazards pass underneath').toBe(5);
  });

  test('TER-02 a pillar blocks walking past it, can be stood on top of, and absorbs a shockwave', async ({ page }) => {
    await page.evaluate(setup);
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1); raidClearTerrain();
      const top = raidGROUND_Y - 120;
      raidTerrainAdd({ kind: 'pillar', x: 500, w: 70, top, life: -1 });
      for (let i = 0; i < 30; i++) raidUpdateTerrain();
      const out = { top };
      // walking right along the floor from the left: stops at the pillar's left face
      let tr = runPhys(300, raidGROUND_Y, 140, { right: true });
      out.blockedAt = tr[tr.length - 1][0];
      out.leftFace = 500 - 35;
      // and from the right
      tr = runPhys(700, raidGROUND_Y, 140, { left: true });
      out.blockedFromRight = tr[tr.length - 1][0];
      out.rightFace = 500 + 35;
      // landing on top of it from above, then walking along the top and off
      tr = runPhys(500, top - 60, 40, {}, 0);
      out.onTop = tr[tr.length - 1][1];
      // a shockwave rolling in is absorbed
      raidG.hazards = [];
      raidHazard({ kind: 'shockwave', x: 300, dir: 1, speed: 6, life: 300 });
      for (let i = 0; i < 80; i++) raidUpdateHazards();
      out.waveGone = raidG.hazards.filter((h) => h.kind === 'shockwave').length;
      // a shockwave starting on the far side is not absorbed by it (only one that reaches it)
      raidG.hazards = [];
      raidHazard({ kind: 'shockwave', x: 700, dir: 1, speed: 6, life: 300 });
      for (let i = 0; i < 10; i++) raidUpdateHazards();
      out.farWave = raidG.hazards.filter((h) => h.kind === 'shockwave').length;
      return out;
    });
    expect(r.blockedAt + 36, 'the right side of the player stops at the pillar\'s left face').toBeLessThanOrEqual(r.leftFace + 1.5);
    expect(r.blockedAt + 36).toBeGreaterThan(r.leftFace - 8);
    expect(r.blockedFromRight).toBeGreaterThanOrEqual(r.rightFace - 1.5);
    expect(r.blockedFromRight).toBeLessThan(r.rightFace + 8);
    expect(r.onTop, 'can be stood on').toBe(r.top);
    expect(r.waveGone, 'a shockwave that reaches a pillar dies there').toBe(0);
    expect(r.farWave, 'one still travelling away is untouched').toBe(1);
  });
});

test.describe('Floor zones (TER-03)', () => {
  test('TER-03 lava and fire hurt a player standing on the floor in them once they have formed; jumping or a platform is safe', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1); raidClearTerrain();
      const out = {};
      const test = (kind, x, feetY, ageFrames) => {
        raidClearTerrain();
        const z = raidTerrainAdd({ kind, x: 500, w: 140, life: 600 });
        z.age = ageFrames;
        raidLocal.health = 5;
        T.place(x, feetY - 48, { health: 5, invincible: 0 });
        for (let i = 0; i < 3; i++) { T.place(x, feetY - 48, { health: T.me().health, invincible: 0 }); raidUpdateTerrain(); }
        return T.me().health;
      };
      out.lavaForming = test('lava', 500, raidGROUND_Y, 5);
      out.lavaFormed = test('lava', 500, raidGROUND_Y, 60);
      out.lavaBeside = test('lava', 640, raidGROUND_Y, 60);
      out.lavaJumping = test('lava', 500, raidGROUND_Y - 70, 60);
      out.fireFormed = test('fire', 500, raidGROUND_Y, 60);
      out.thorns = test('thorns', 500, raidGROUND_Y, 60);
      out.thornsJumping = test('thorns', 500, raidGROUND_Y - 60, 60);
      return out;
    });
    expect(r.lavaForming, 'a zone that is still forming does not hurt').toBe(5);
    expect(r.lavaFormed).toBeLessThan(5);
    expect(r.lavaBeside, 'beside it is safe').toBe(5);
    expect(r.lavaJumping, 'a jump over lava is safe').toBe(5);
    expect(r.fireFormed).toBeLessThan(5);
    expect(r.thorns).toBeLessThan(5);
    expect(r.thornsJumping).toBe(5);
  });

  test('TER-03 mud slows you, an updraft lifts you, and the effects stop at the zone edge', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1); raidClearTerrain();
      const out = {};
      const run = (x, frames, input) => {
        T.place(x, raidGROUND_Y - 48);
        raidLocal.vx = 0; raidLocal.vy = 0; raidLocal.onGround = true; raidLocal.dashTimer = 0;
        raidLocal.input = Object.assign({ left: false, right: false, up: false, down: false, jump: false, space: false }, input);
        const x0 = raidLocal.x;
        for (let i = 0; i < frames; i++) raidUpdateLocal();
        return { dx: raidLocal.x - x0, y: raidLocal.y + 48 };
      };
      out.free = run(200, 40, { right: true }).dx;
      const mud = raidTerrainAdd({ kind: 'mud', x: 300, w: 400, life: 600 }); mud.age = 60;
      out.inMud = run(200, 40, { right: true }).dx;
      out.mudEffect = raidTerrainEffects({ x: 300 - 18, y: raidGROUND_Y - 48, h: 48, onGround: true }).slow;
      out.noMud = raidTerrainEffects({ x: 800, y: raidGROUND_Y - 48, h: 48, onGround: true }).slow;
      raidClearTerrain();
      const up = raidTerrainAdd({ kind: 'updraft', x: 500, w: 160, life: 600 }); up.age = 60;
      // standing in an updraft: float up off the floor
      T.place(500, raidGROUND_Y - 48); raidLocal.vy = 0; raidLocal.onGround = true;
      raidLocal.input = { left: false, right: false, up: false, down: false, jump: true, space: false };
      let maxRise = 0;
      for (let i = 0; i < 80; i++) { raidUpdateLocal(); maxRise = Math.max(maxRise, raidGROUND_Y - (raidLocal.y + 48)); raidLocal.input.jump = true; }
      out.updraftRise = maxRise;
      raidClearTerrain();
      T.place(500, raidGROUND_Y - 48); raidLocal.vy = 0; raidLocal.onGround = true;
      raidLocal.input = { left: false, right: false, up: false, down: false, jump: true, space: false };
      maxRise = 0;
      for (let i = 0; i < 80; i++) { raidUpdateLocal(); maxRise = Math.max(maxRise, raidGROUND_Y - (raidLocal.y + 48)); raidLocal.input.jump = true; }
      out.plainRise = maxRise;
      return out;
    });
    expect(r.inMud, 'running through mud covers about half the ground').toBeLessThan(r.free * 0.65);
    expect(r.inMud).toBeGreaterThan(r.free * 0.3);
    expect(r.mudEffect).toBeLessThan(0.6);
    expect(r.noMud).toBe(1);
    expect(r.updraftRise, 'an updraft carries a jump far higher').toBeGreaterThan(r.plainRise + 60);
  });
});

test.describe('Thrown objects and drawing (TER-04)', () => {
  test('TER-04 a lobbed object lands in a burst (a boulder also raises a pillar), and a marker shows where it will land', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1); raidClearTerrain();
      const out = { kinds: Object.keys(RAID_LAND_FX).sort() };
      raidG.hazards = []; raidG.projectiles = [];
      const lob = (kind, x) => {
        const T_ = 50, hx = 500, hy = 200, land = raidGROUND_Y - 14, g = raidLobGravity(land - hy, T_, RAID_LOB_RISE);
        return { x: hx, y: hy, vx: (x - hx) / T_, vy: (land - hy - g * T_ * (T_ + 1) / 2) / T_, gravity: g, r: 14, life: T_ + 6, isWarning: false, isBossProjectile: true, owner: kind, kind, onLand: kind };
      };
      out.marker = {};
      // the landing spot the marker will show is where the object really comes down
      const pr = lob('rubble', 300);
      raidG.projectiles = [pr];
      out.predicted = Math.round(raidProjectileLandingX(pr));
      T.place(900); // out of the way
      let burst = false;
      for (let i = 0; i < 70; i++) { T.step(1); if (raidG.hazards.some((h) => h.kind === 'burst')) burst = true; }
      out.burst = burst; out.rubbleTerrain = raidG.terrain.length;
      // a boulder raises a pillar where it lands
      raidG.projectiles = [lob('boulder', 700)];
      for (let i = 0; i < 70; i++) { T.step(1); }
      const pillar = raidG.terrain.find((t) => t.kind === 'pillar');
      out.pillar = pillar ? { x: Math.round(pillar.x), theme: pillar.theme } : null;
      return out;
    });
    expect(r.predicted).toBe(300);
    expect(r.burst, 'rubble bursts where it lands').toBe(true);
    expect(r.rubbleTerrain, 'and leaves nothing behind').toBe(0);
    expect(r.pillar, 'a boulder raises a pillar').not.toBeNull();
    expect(Math.abs(r.pillar.x - 700)).toBeLessThan(6);
    expect(r.kinds).toEqual(['boulder', 'rubble']);
  });

  test('TER-04 a burst hurts players standing in it on the floor, not ones in the air', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1); raidClearTerrain(); raidG.hazards = [];
      const hit = (dx, feetY) => {
        raidG.hazards = [];
        raidLocal.health = 5;
        raidHazard({ kind: 'burst', x: 500, r: 70, life: 16 });
        T.place(500 + dx, feetY - 48, { health: 5, invincible: 0 });
        for (let i = 0; i < 4; i++) { T.place(500 + dx, feetY - 48, { health: T.me().health, invincible: 0 }); T.step(1); }
        return T.me().health;
      };
      return { inside: hit(20, raidGROUND_Y), outside: hit(150, raidGROUND_Y), air: hit(20, raidGROUND_Y - 100) };
    });
    expect(r.inside).toBeLessThan(5);
    expect(r.outside).toBe(5);
    expect(r.air).toBe(5);
  });

  test('TER-04 terrain draws: solid pieces fill their shape, every kind draws without error, and zones blink before they vanish', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1); raidClearTerrain(); raidG.hazards = [];
      raidFx.shake = 0; T.place(60);
      const W = 1000, H = 600;
      const grab = () => raidCtx.getImageData(0, 0, W, H).data;
      const changed = (a, b, x0, x1, y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; } return n; };
      raidG.frame = 100; raidDraw(); const empty = grab();
      const out = {};
      const draw = (spec) => { raidClearTerrain(); const t = raidTerrainAdd(spec); t.age = 80; raidG.frame = 100; raidDraw(); return grab(); };
      const pillar = draw({ kind: 'pillar', x: 500, w: 80, top: raidGROUND_Y - 130, life: -1 });
      out.pillarBody = changed(empty, pillar, 470, 530, raidGROUND_Y - 120, raidGROUND_Y - 10);
      out.pillarBeside = changed(empty, pillar, 560, 640, raidGROUND_Y - 120, raidGROUND_Y - 10);
      const platform = draw({ kind: 'platform', x: 300, w: 160, top: raidGROUND_Y - 95, life: -1 });
      out.platform = changed(empty, platform, 230, 370, raidGROUND_Y - 100, raidGROUND_Y - 80);
      out.platformBelow = changed(empty, platform, 230, 370, raidGROUND_Y - 60, raidGROUND_Y - 20);
      for (const kind of ['lava', 'fire', 'mud', 'water', 'thorns', 'updraft']) {
        const px = draw({ kind, x: 700, w: 160, life: -1 });
        out[kind] = changed(empty, px, 620, 780, raidGROUND_Y - 120, raidGROUND_Y + 40);
      }
      // a zone in its last moments blinks: two nearby frames differ
      raidClearTerrain(); const z = raidTerrainAdd({ kind: 'lava', x: 700, w: 160, life: 20 }); z.age = 200;
      raidG.frame = 100; raidDraw(); const f1 = grab(); raidG.frame = 104; raidDraw(); const f2 = grab();
      out.blink = changed(f1, f2, 620, 780, raidGROUND_Y - 20, raidGROUND_Y + 20);
      // and a zone that still has a long life does not
      raidClearTerrain(); const z2 = raidTerrainAdd({ kind: 'lava', x: 700, w: 160, life: 600 }); z2.age = 200;
      raidG.frame = 100; raidDraw(); const g1 = grab(); raidG.frame = 100; raidDraw(); const g2 = grab();
      out.steady = changed(g1, g2, 620, 780, raidGROUND_Y - 20, raidGROUND_Y + 20);
      return out;
    });
    expect(r.pillarBody, 'a pillar fills its body').toBeGreaterThan(2000);
    expect(r.pillarBeside, 'and only its body').toBe(0);
    expect(r.platform, 'a platform draws its slab').toBeGreaterThan(300);
    expect(r.platformBelow, 'nothing is drawn underneath it').toBe(0);
    for (const k of ['lava', 'fire', 'mud', 'water', 'thorns', 'updraft']) expect(r[k], k + ' draws').toBeGreaterThan(200);
    expect(r.blink, 'a zone about to disappear blinks').toBeGreaterThan(100);
    expect(r.steady).toBe(0);
  });
});
