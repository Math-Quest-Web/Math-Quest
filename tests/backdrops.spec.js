// Arena backdrops (BKG-*): each boss fights in a place of its own, drawn procedurally. They are pure
// functions of (boss, frame, phase) so a frame always looks the same, and they are animated.
const { test, expect } = require('./support/fixtures');

const BOSSES = ['grinmaw', 'warden', 'wyrm', 'glutton', 'bramblehide', 'colossus', 'griffon'];

test.describe('Arena backdrops (BKG-01)', () => {
  test('BKG-01 every boss has its own backdrop (sky, scenery and floor) and no two look alike', async ({ page }) => {
    const r = await page.evaluate(async (bosses) => {
      await T.setupRaid('grinmaw');
      const hash = (x0, y0, x1, y1) => {
        const d = raidCtx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let h = 2166136261; const colours = new Set();
        for (let i = 0; i < d.length; i += 12) { h = Math.imul(h ^ ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]), 16777619); if (colours.size < 400) colours.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)); }
        return { h: h >>> 0, colours: colours.size };
      };
      const out = {};
      for (const type of bosses) {
        raidCtx.clearRect(0, 0, 1000, 600);
        raidDrawBackdrop(raidCtx, type, 100, 1);
        out[type] = { sky: hash(0, 0, 1000, raidGROUND_Y), floor: hash(0, raidGROUND_Y, 1000, 600) };
      }
      return out;
    }, BOSSES);
    for (const b of BOSSES) {
      expect(r[b].sky.colours, b + ' sky/scenery is rich, not a flat fill').toBeGreaterThan(40);
      expect(r[b].floor.colours, b + ' floor has a texture').toBeGreaterThan(12);
    }
    expect(new Set(BOSSES.map((b) => r[b].sky.h)).size, 'seven different skies').toBe(7);
    expect(new Set(BOSSES.map((b) => r[b].floor.h)).size, 'seven different floors').toBe(7);
  });

  test('BKG-01 a backdrop is animated, and always the same for the same frame', async ({ page }) => {
    const r = await page.evaluate(async (bosses) => {
      await T.setupRaid('grinmaw');
      const snap = (type, frame, phase) => {
        raidCtx.clearRect(0, 0, 1000, 600);
        raidDrawBackdrop(raidCtx, type, frame, phase);
        const d = raidCtx.getImageData(0, 0, 1000, 600).data; let h = 2166136261;
        for (let i = 0; i < d.length; i += 16) h = Math.imul(h ^ ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]), 16777619);
        return h >>> 0;
      };
      const out = {};
      for (const type of bosses) out[type] = { a: snap(type, 100, 1), again: snap(type, 100, 1), later: snap(type, 190, 1), phase3: snap(type, 100, 3) };
      return out;
    }, BOSSES);
    for (const b of BOSSES) {
      expect(r[b].again, b + ' draws the same frame the same way twice (no randomness)').toBe(r[b].a);
      expect(r[b].later, b + ' moves from frame to frame').not.toBe(r[b].a);
    }
    // later phases stir the scenery up (more embers, steam, leaves, wind) for the bosses that have such scenery
    const stirred = BOSSES.filter((b) => r[b].phase3 !== r[b].a);
    expect(stirred.length).toBeGreaterThanOrEqual(5);
  });

  test('BKG-01 the raid draws the boss\'s own backdrop, with no console errors, for every boss', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const r = await page.evaluate(async (bosses) => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (const type of bosses) {
        T.prepBoss(type, 1);
        const calls = [];
        const orig = window.raidDrawBackdrop;
        window.raidDrawBackdrop = (ctx, t, F, p) => { calls.push(t); return orig(ctx, t, F, p); };
        raidDraw();
        window.raidDrawBackdrop = orig;
        out[type] = calls;
      }
      return out;
    }, BOSSES);
    for (const b of BOSSES) expect(r[b], b).toEqual([b]);
    expect(errors).toEqual([]);
  });

  test('BKG-01 a whole phase-3 fight of every boss draws every frame (terrain, markers, backdrop) without an error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const r = await page.evaluate(async (bosses) => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (const type of bosses) {
        T.seed(31); T.prepBoss(type, 3); raidResetTerrain(type); raidG.boss.attackTimer = 30;
        let drawn = 0, maxTerrain = 0;
        for (let f = 0; f < 2400; f++) {
          T.place(500 + Math.sin(f * 0.02) * 300, undefined, { invincible: 30 });
          T.step(1);
          if (f % 6 === 0) { raidDraw(); drawn++; }
          maxTerrain = Math.max(maxTerrain, raidG.terrain.length);
          if (T.me().health <= 2) { raidPlayerRef.child(raidMyId).update({ health: 5 }); raidG.gameOver = false; }
        }
        out[type] = { drawn, maxTerrain };
      }
      return out;
    }, BOSSES);
    for (const b of BOSSES) expect(r[b].drawn, b).toBe(400);
    expect(errors).toEqual([]);
  });
});
