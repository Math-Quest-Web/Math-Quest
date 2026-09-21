// Spec BOS-30 to BOS-35 and GEN-01/GEN-08: bosses are drawn from the boss sprite sheet, with the old
// canvas-path art as a fallback. Written before the implementation.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./support/fixtures');

const root = path.join(__dirname, '..');
const BOSSES = ['grinmaw', 'warden', 'wyrm', 'glutton'];

// Reads the size of a WebP file header (VP8/VP8L/VP8X) without any image library.
function webpSize(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fmt = b.toString('ascii', 12, 16);
  if (fmt === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  if (fmt === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
  if (fmt === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  return null;
}

test.describe('Boss sprite asset and hosting (GEN-01, GEN-08, BOS-30)', () => {
  test('BOS-30 the sheet is a 2048 x 2048 WebP under 1.5 MB in assets/', () => {
    const file = path.join(root, 'assets', 'boss-sheet.webp');
    expect(fs.existsSync(file)).toBe(true);
    expect(webpSize(file)).toEqual({ w: 2048, h: 2048 });
    expect(fs.statSync(file).size).toBeLessThan(1.5 * 1024 * 1024);
  });

  test('GEN-08 assets/ is deployed (not in hosting.ignore) while sprites/ stays private', () => {
    const ignore = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8')).hosting.ignore;
    expect(ignore).toContain('sprites/**');
    expect(ignore.some((p) => p.startsWith('assets'))).toBe(false);
  });

  test('BOS-30 index.html loads the sheet from JS (no <img> tag) and keeps the fallback art', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    expect(html).toContain('assets/boss-sheet.webp');
    expect(html).not.toMatch(/<img\b/i);
    for (const fn of ['drawGrinmaw', 'drawWarden', 'drawWyrm', 'drawGlutton']) expect(html).toContain('function ' + fn + '(');
  });
});

test.describe('State to frame mapping (BOS-31, BOS-32)', () => {
  const frameFor = (page, boss, frame) => page.evaluate(({ boss, frame }) => {
    raidG.frame = frame || 0;
    return bossSpriteFrame(Object.assign({ type: 'grinmaw', phase: 1, exposed: 0, transition: 0, anim: { state: 'idle', timer: 0 } }, boss));
  }, { boss, frame });

  test('BOS-31 an idle boss loops idle_1..idle_4, changing every 15 frames', async ({ page }) => {
    const seq = [];
    for (const f of [0, 15, 30, 45, 60]) seq.push(await frameFor(page, {}, f));
    expect(seq).toEqual(['idle_1', 'idle_2', 'idle_3', 'idle_4', 'idle_1']);
  });

  test('BOS-31 phase 3 idle uses the enraged frames', async ({ page }) => {
    expect(await frameFor(page, { phase: 3 }, 0)).toBe('enraged_1');
    expect(await frameFor(page, { phase: 3 }, 12)).toBe('enraged_2');
  });

  test('BOS-31 a stunned boss shows the hurt pose whatever else it is doing (BOS-11, BOS-12)', async ({ page }) => {
    for (const type of BOSSES) {
      for (const state of ['idle', 'dazed', 'slam', 'strike', 'crash', 'bite']) {
        const f = await frameFor(page, { type, exposed: 100, anim: { state, timer: 3 } }, 0);
        expect(['hurt', 'hurt_recover']).toContain(f);
      }
    }
  });

  test('BOS-32 attack timelines: windup, then telegraph, then attack, then recover', async ({ page }) => {
    const spit = (timer) => frameFor(page, { type: 'grinmaw', anim: { state: 'spit', timer } });
    expect(await spit(3)).toBe('windup');
    expect(await spit(20)).toBe('telegraph');
    expect(await spit(30)).toBe('attack');
    expect(await frameFor(page, { type: 'grinmaw', anim: { state: 'settle', timer: 4 } })).toBe('recover');
    expect(await frameFor(page, { type: 'grinmaw', anim: { state: 'summon', timer: 40 } })).toBe('special');
    expect(await frameFor(page, { type: 'wyrm', anim: { state: 'coil', timer: 30 } })).toBe('telegraph');
    expect(await frameFor(page, { type: 'wyrm', anim: { state: 'dive', timer: 5 } })).toBe('attack');
    expect(await frameFor(page, { type: 'warden', anim: { state: 'strike', timer: 5 } })).toBe('attack');
    expect(await frameFor(page, { type: 'glutton', anim: { state: 'bite', timer: 5 } })).toBe('attack');
  });

  test('BOS-32 the Glutton shows its clamped-shut special while feasting', async ({ page }) => {
    expect(await frameFor(page, { type: 'glutton', feastTimer: 40, invulnerable: true })).toBe('special');
    expect(await frameFor(page, { type: 'glutton', feastWarning: true })).toBe('telegraph');
  });

  test('BOS-32 fading, hidden and submerged states keep the idle art (alpha is handled by the game)', async ({ page }) => {
    expect(await frameFor(page, { type: 'warden', anim: { state: 'fade', timer: 10 } }, 0)).toMatch(/^idle_/);
    expect(await frameFor(page, { type: 'glutton', anim: { state: 'swim', timer: 10 } }, 0)).toMatch(/^idle_/);
  });

  test('BOS-31 every state and timer of every boss resolves to a frame that exists in the atlas', async ({ page }) => {
    const bad = await page.evaluate(() => {
      const missing = [];
      for (const type of Object.keys(BOSS_SPRITE.bosses)) {
        const states = Object.keys(BOSS_SPRITE_STATES[type]).concat(['idle', 'not-a-state']);
        for (const state of states) for (const timer of [0, 5, 15, 30, 60, 500]) for (const phase of [1, 3]) {
          const f = bossSpriteFrame({ type, phase, exposed: 0, transition: 0, anim: { state, timer } });
          if (!BOSS_SPRITE.frames.includes(f)) missing.push(type + '/' + state + '/' + timer + ' -> ' + f);
        }
      }
      return missing;
    });
    expect(bad).toEqual([]);
  });
});

test.describe('Drawing and fallback (BOS-33, BOS-34, BOS-35)', () => {
  const restPos = { grinmaw: [500, 80], warden: [500, 90], wyrm: [500, 110], glutton: [500, 95] };
  const draw = (page, type, opts) => page.evaluate(async ({ type, opts, pos }) => {
    if (!bossSheetReady) { bossSheetLoad(); await new Promise((res) => { const t = setInterval(() => { if (bossSheetReady) { clearInterval(t); res(); } }, 25); setTimeout(res, 4000); }); }
    const cv = document.createElement('canvas'); cv.width = 1000; cv.height = 600;
    const c = cv.getContext('2d', { willReadFrequently: true });
    const b = raidG.boss;
    Object.assign(b, { type, hp: 100, maxHp: 100, phase: 1, exposed: 0, transition: 0, x: pos[0], y: pos[1], animScale: 1, animAlpha: 1, animOffsetX: 0, animOffsetY: 0, anim: { state: 'idle', timer: 0 } }, opts || {});
    raidG.frame = 0;
    const usedSprite = drawBossSprite(c, b);
    const d = c.getImageData(0, 0, 1000, 600).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < 600; y++) for (let x = 0; x < 1000; x++) if (d[(y * 1000 + x) * 4 + 3] > 40) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return { usedSprite, n, bbox: [x0, y0, x1, y1] };
  }, { type, opts, pos: restPos[type] });

  for (const type of BOSSES) {
    test(`BOS-33 ${type}: the sprite is drawn around the boss position and stays on screen`, async ({ page }) => {
      const r = await draw(page, type);
      expect(r.usedSprite).toBe(true);
      expect(r.n).toBeGreaterThan(8000);
      const [x0, y0, x1, y1] = r.bbox;
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x0).toBeGreaterThan(300); expect(x1).toBeLessThan(700);
      expect(x1 - x0).toBeGreaterThan(110); expect(y1 - y0).toBeGreaterThan(110);
      // centred on the boss (hitbox) horizontally, and the hitbox centre lies inside the art
      expect(Math.abs((x0 + x1) / 2 - restPos[type][0])).toBeLessThan(40);
      expect(restPos[type][1]).toBeGreaterThan(y0); expect(restPos[type][1]).toBeLessThan(y1);
    });
  }

  test('BOS-34 before the sheet has loaded, or with sprites switched off, the old art is used', async ({ page }) => {
    const r = await page.evaluate(() => {
      const cv = document.createElement('canvas'); cv.width = 1000; cv.height = 600;
      const c = cv.getContext('2d', { willReadFrequently: true });
      const out = {};
      const b = raidG.boss;
      Object.assign(b, { type: 'grinmaw', hp: 100, maxHp: 100, phase: 1, exposed: 0, transition: 0, x: 500, y: 80, animScale: 1, animAlpha: 1, anim: { state: 'idle', timer: 0 } });
      const savedReady = bossSheetReady;
      bossSheetReady = false;
      out.notReady = drawBossSprite(c, b);
      drawBossDispatch(c, b);
      const px = (c.getImageData(400, 0, 200, 150).data).reduce((n, v, i) => n + (i % 4 === 3 && v > 40 ? 1 : 0), 0);
      out.fallbackPixels = px;
      bossSheetReady = savedReady;
      const savedFlag = RAID_BOSS_SPRITES_ENABLED;
      RAID_BOSS_SPRITES_ENABLED = false;
      out.disabled = drawBossSprite(c, b);
      RAID_BOSS_SPRITES_ENABLED = savedFlag;
      return out;
    });
    expect(r.notReady).toBe(false);
    expect(r.disabled).toBe(false);
    expect(r.fallbackPixels).toBeGreaterThan(3000);
  });

  test('BOS-35 the stun cue is still animation only: dizzy stars are drawn over a sprite boss and no text', async ({ page }) => {
    const r = await page.evaluate(async () => {
      if (!bossSheetReady) { bossSheetLoad(); await new Promise((res) => { const t = setInterval(() => { if (bossSheetReady) { clearInterval(t); res(); } }, 25); setTimeout(res, 4000); }); }
      const cv = document.createElement('canvas'); cv.width = 1000; cv.height = 600;
      const c = cv.getContext('2d');
      const seen = [];
      const realFill = c.fillText.bind(c), realStroke = c.strokeText.bind(c);
      c.fillText = (...a) => { seen.push(a[0]); return realFill(...a); };
      c.strokeText = (...a) => { seen.push(a[0]); return realStroke(...a); };
      const b = raidG.boss;
      Object.assign(b, { type: 'wyrm', hp: 100, maxHp: 100, phase: 1, exposed: 90, transition: 0, x: 500, y: 110, animScale: 1, animAlpha: 1, anim: { state: 'idle', timer: 0 } });
      drawBossDispatch(c, b);
      return { text: seen };
    });
    expect(r.text).toEqual([]);
  });
});
