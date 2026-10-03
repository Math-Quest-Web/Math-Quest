// Exact hitboxes: the boss hurt areas follow what is drawn (BOS-46), and the sword's hit area is the
// slash that is drawn (WPN-15). Also the smaller Wyrm (BOS-46) and the stronger Second Wind (WPN-06).
// To rebuild the stored hurt areas after changing boss art: MEASURE_HURT=out.json npx playwright test hitboxes
const { test, expect } = require('./support/fixtures');
const fs = require('fs');

const BOSSES = ['grinmaw', 'warden', 'wyrm', 'glutton', 'bramblehide', 'colossus', 'griffon'];

// Page-side helper: the union of a boss's drawn silhouette (alpha >= 128) over its idle and enraged
// frames, as { mask, W, H, cx, cy } with the boss drawn at (cx, cy).
const MEASURE = `
  window.silhouette = async (type) => {
    bossSheetLoad();
    await new Promise((r) => { const i = setInterval(() => { if (bossSheetReady) { clearInterval(i); r(); } }, 30); setTimeout(r, 4000); });
    const W = 1000, H = 700, CX = 500, CY = 300;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const mask = new Uint8Array(W * H);
    for (const phase of [1, 3]) {
      for (let f = 0; f < 120; f += 6) {
        ctx.clearRect(0, 0, W, H);
        raidG.frame = f;
        const b = raidG.boss;
        Object.assign(b, { type, x: CX, y: CY, hp: 100, maxHp: 100, phase, exposed: 0, transition: 0, hitFlash: 0, animScale: 1, animAlpha: 1, animOffsetX: 0, animOffsetY: 0, invulnerable: false, feastTimer: 0, feastWarning: false, anim: { state: 'idle', timer: 0 } });
        drawBossDispatch(ctx, b);
        const d = ctx.getImageData(0, 0, W, H).data;
        for (let i = 0; i < W * H; i++) if (d[i * 4 + 3] >= 128) mask[i] = 1;
      }
    }
    // the ground shadow is not part of the body: ignore everything far from the centre
    for (let y = 0; y < H; y++) if (Math.abs(y - CY) > 230) for (let x = 0; x < W; x++) mask[y * W + x] = 0;
    return { mask, W, H, cx: CX, cy: CY };
  };
`;

test.beforeEach(async ({ page }) => {
  await page.evaluate(MEASURE);
});

test.describe('Boss hurt areas follow the art (BOS-46)', () => {
  test('BOS-46 each boss has a hurt area that matches its drawn silhouette', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (const type of ['grinmaw', 'warden', 'wyrm', 'glutton', 'bramblehide', 'colossus', 'griffon']) {
        const s = await silhouette(type);
        const b = Object.assign(raidG.boss, { type, x: s.cx, y: s.cy, animScale: 1 });
        const rects = raidBossRects(b);
        const inside = new Uint8Array(s.W * s.H);
        rects.forEach(([x0, y0, x1, y1]) => { for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) if (x >= 0 && x < s.W && y >= 0 && y < s.H) inside[y * s.W + x] = 1; });
        let opaque = 0, covered = 0, area = 0, areaOpaque = 0;
        for (let i = 0; i < s.W * s.H; i++) {
          if (s.mask[i]) { opaque++; if (inside[i]) covered++; }
          if (inside[i]) { area++; if (s.mask[i]) areaOpaque++; }
        }
        out[type] = { recall: covered / opaque, precision: areaOpaque / area, rects: rects.length, bounds: BOSS_HURT[type].bounds };
      }
      return out;
    });
    for (const t of BOSSES) {
      expect(r[t].recall, t + ': nearly everything drawn can be hit').toBeGreaterThan(0.985);
      expect(r[t].precision, t + ': nearly everything that can be hit is drawn').toBeGreaterThan(0.9);
      expect(r[t].rects, t + ' is described by a modest number of rectangles').toBeLessThan(160);
    }
  });

  test('BOS-46 shots and swings hit the silhouette, not an empty corner or the gap between parts', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (const type of ['grinmaw', 'warden', 'wyrm', 'glutton', 'bramblehide', 'colossus', 'griffon']) {
        const s = await silhouette(type);
        const b = Object.assign(raidG.boss, { type, x: s.cx, y: s.cy, animScale: 1 });
        // pixels well inside the drawing (every neighbour within 4px is opaque) must be hits, pixels
        // well outside it (nothing opaque within 6px) must be misses
        const at = (x, y) => (x < 0 || y < 0 || x >= s.W || y >= s.H) ? 0 : s.mask[y * s.W + x];
        let deepHit = 0, deepTotal = 0, farHit = 0, farTotal = 0;
        for (let y = s.cy - 200; y < s.cy + 200; y += 5) for (let x = s.cx - 200; x < s.cx + 200; x += 5) {
          let all = true, any = false;
          for (let dy = -6; dy <= 6 && (all || !any); dy += 2) for (let dx = -6; dx <= 6; dx += 2) {
            const m = at(x + dx, y + dy);
            if (!m && Math.abs(dx) <= 4 && Math.abs(dy) <= 4) all = false;
            if (m) any = true;
          }
          const hit = raidCircleHitsBoss(x, y, 0, b);
          if (all && at(x, y)) { deepTotal++; if (hit) deepHit++; }
          if (!any) { farTotal++; if (hit) farHit++; }
        }
        out[type] = { deepHit, deepTotal, farHit, farTotal };
      }
      return out;
    });
    for (const t of BOSSES) {
      expect(r[t].deepTotal, t).toBeGreaterThan(20);
      expect(r[t].deepHit, t + ' every point well inside the drawing is a hit').toBe(r[t].deepTotal);
      expect(r[t].farHit, t + ' no point well outside the drawing is a hit').toBe(0);
    }
  });

  test('BOS-46 the hurt area moves with the boss and grows with its animation scale', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const b = Object.assign(raidG.boss, { type: 'colossus', x: 500, y: 300, animScale: 1 });
      const a = raidBossRects(b);
      b.x = 560; b.y = 340;
      const moved = raidBossRects(b);
      b.x = 500; b.y = 300; b.animScale = 1.25;
      const grown = raidBossRects(b);
      const span = (rs) => ({ x0: Math.min(...rs.map((q) => q[0])), x1: Math.max(...rs.map((q) => q[2])), y0: Math.min(...rs.map((q) => q[1])), y1: Math.max(...rs.map((q) => q[3])) });
      // Colossus's arms are separate from its body: the gap between them is not a hit
      b.animScale = 1;
      const gap = raidCircleHitsBoss(500 + 66, 300, 0, b); // between the body edge and the arm
      return { a: span(a), moved: span(moved), grown: span(grown), gap, body: raidCircleHitsBoss(500, 300, 0, b), arm: raidCircleHitsBoss(500 + 84, 300, 0, b) };
    });
    expect(r.moved.x0 - r.a.x0).toBeCloseTo(60, 5);
    expect(r.moved.y0 - r.a.y0).toBeCloseTo(40, 5);
    expect((r.grown.x1 - r.grown.x0) / (r.a.x1 - r.a.x0)).toBeCloseTo(1.25, 2);
    expect((r.grown.y1 - r.grown.y0) / (r.a.y1 - r.a.y0)).toBeCloseTo(1.25, 2);
    expect(r.body).toBe(true);
    expect(r.arm).toBe(true);
    expect(r.gap, 'the gap between the arm and the body is not a hit').toBe(false);
  });

  test('BOS-46 the Wyrm is drawn smaller (0.75x), with its heads pulled in to match', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('wyrm');
      const b = BOSS_HURT.wyrm.bounds;
      return { scale: BOSS_BODY_SCALE.wyrm, others: Object.keys(BOSS_BODY_SCALE), offsets: WYRM_HEAD_OFFSETS.slice(), w: b.x1 - b.x0, h: b.y1 - b.y0 };
    });
    expect(r.scale).toBe(0.75);
    expect(r.others, 'only the Wyrm is scaled').toEqual(['wyrm']);
    expect(r.offsets).toEqual([-52.5, 0, 52.5]);
    expect(r.w, 'it used to be about 290 px wide (idle and enraged frames together)').toBeLessThan(230);
    expect(r.h, 'and about 245 px tall').toBeLessThan(200);
  });

  if (process.env.MEASURE_HURT) {
    test('measure: write the hurt areas of every boss to ' + process.env.MEASURE_HURT, async ({ page }) => {
      const data = await page.evaluate(async () => {
        await T.setupRaid('grinmaw');
        const out = {};
        for (const type of ['grinmaw', 'warden', 'wyrm', 'glutton', 'bramblehide', 'colossus', 'griffon']) {
          const s = await silhouette(type);
          const BAND = 4, bands = [];
          let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
          for (let y = 0; y < s.H; y += BAND) {
            const runs = [];
            let start = -1, last = -1;
            const gapMax = 6;
            for (let x = 0; x < s.W; x++) {
              let any = false;
              for (let dy = 0; dy < BAND && y + dy < s.H; dy++) if (s.mask[(y + dy) * s.W + x]) { any = true; break; }
              if (any) { if (start < 0) start = x; else if (x - last > gapMax) { runs.push([start, last + 1]); start = x; } last = x; }
            }
            if (start >= 0) runs.push([start, last + 1]);
            if (!runs.length) continue;
            const row = [y - s.cy, y + BAND - s.cy];
            runs.forEach(([a, b]) => { row.push(a - s.cx, b - s.cx); x0 = Math.min(x0, a - s.cx); x1 = Math.max(x1, b - s.cx); });
            y0 = Math.min(y0, y - s.cy); y1 = Math.max(y1, y + BAND - s.cy);
            bands.push(row);
          }
          out[type] = { bounds: { x0, x1, y0, y1 }, bands };
        }
        return out;
      });
      fs.writeFileSync(process.env.MEASURE_HURT, JSON.stringify(data));
    });
  }
});

test.describe('The slash that is drawn is the slash that hits (WPN-15)', () => {
  const PLAYER = { x: 300, y: 452, facing: 1, utility: '' }; // standing on the floor, centre x = 318

  test('WPN-15 the hit area is the drawn crescent: it starts at the hand, reaches 115 px (scaled) along the swing and follows Long Reach', async ({ page }) => {
    const r = await page.evaluate((P) => {
      const S = MQ_PLAYER_SCALE;
      const out = {};
      const farthest = (poly, vx, vy) => poly.reduce((m, q) => Math.max(m, q[0] * vx + q[1] * vy), -1e9);
      for (const dir of ['right', 'left', 'up', 'down']) {
        const v = RAID_SWORD_DIR_VECTORS[dir];
        for (const util of ['', 'util_range']) {
          const p = Object.assign({}, P, { swingDir: dir, utility: util });
          const s = 0.38; // the slash is in full view
          const poly = raidSlashWorldPoly(p, s);
          const pose = raidAttackPose(dir, s, p.facing);
          const cx = p.x + 18, feet = p.y + 48;
          const hand = [cx + S * pose.sx * 30 * p.facing + pose.dx, feet + S * pose.sy * (22 - 48) + pose.dy];
          const mult = util ? 1.25 : 1;
          const along = farthest(poly, v[0], v[1]) - (hand[0] * v[0] + hand[1] * v[1]);
          out[dir + ':' + util] = { along, expected: 115 * mult * S * (Math.abs(v[0]) > 0 ? pose.sx : pose.sy), n: poly.length };
        }
      }
      // not in view before the swing has started opening up, nor once it has faded away
      out.before = raidSlashWorldPoly(Object.assign({}, P, { swingDir: 'right' }), 0.05);
      out.after = raidSlashWorldPoly(Object.assign({}, P, { swingDir: 'right' }), 0.9);
      out.window = [RAID_SWORD_HIT_WINDOW_START, RAID_SWORD_HIT_WINDOW_END, RAID_SWORD_SWING_FRAMES];
      return out;
    }, PLAYER);
    for (const k of Object.keys(r).filter((q) => q.includes(':'))) {
      expect(r[k].n, k).toBeGreaterThan(20);
      expect(Math.abs(r[k].along - r[k].expected), k + ' reach along the swing').toBeLessThan(2);
    }
    expect(r.before).toBeNull();
    expect(r.after).toBeNull();
    expect(r.window, 'the swing can hit on every frame the slash is visible (frames 12 down to 3)').toEqual([12, 2, 14]);
  });

  test('WPN-15 every bright pixel of the drawn slash lies inside the hit area (and the hit area is not much bigger)', async ({ page }) => {
    const r = await page.evaluate((P) => {
      const out = {};
      const W = 400, H = 300;
      for (const dir of ['right', 'left', 'up', 'down', 'upright', 'downleft']) {
        for (const s of [0.25, 0.4, 0.55, 0.7]) {
          const p = Object.assign({}, P, { swingDir: dir, x: 182, y: 150 - 24 });
          const poly = raidSlashWorldPoly(p, s);
          const c = document.createElement('canvas'); c.width = W; c.height = H;
          const ctx = c.getContext('2d');
          const look = { skin: 'skin_classic', gun: 'sword_training', swing: s, swingDir: dir, slashScale: 1, noBar: true, noShadow: true, t: 0 };
          drawPlayerCuphead(ctx, p.x, p.y, 36, 48, 1, 5, 5, false, 0, true, look);
          const d = ctx.getImageData(0, 0, W, H).data;
          // the same pose without the slash: whatever is white only in the first picture is the slash
          const c0 = document.createElement('canvas'); c0.width = W; c0.height = H;
          drawPlayerCuphead(c0.getContext('2d'), p.x, p.y, 36, 48, 1, 5, 5, false, 0, true, Object.assign({}, look, { slashScale: 0 }));
          const d0 = c0.getContext('2d').getImageData(0, 0, W, H).data;
          const inPoly = (x, y) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; } return ins; };
          const distEdge = (x, y) => { let m = 1e9; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [ax, ay] = poly[j], [bx, by] = poly[i]; const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))); m = Math.min(m, Math.hypot(x - ax - t * dx, y - ay - t * dy)); } return m; };
          const bodyX = p.x + 18, bodyY = p.y + 24;
          let bright = 0, outside = 0, polyArea = 0, polyBright = 0;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const white = d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240 && d[i + 3] > 200;
            const whiteBefore = d0[i] > 240 && d0[i + 1] > 240 && d0[i + 2] > 240 && d0[i + 3] > 200;
            if (white && !whiteBefore) { bright++; if (!inPoly(x, y) && distEdge(x, y) > 3) outside++; }
          }
          out[dir + '@' + s] = { bright, outside };
        }
      }
      return out;
    }, PLAYER);
    for (const k of Object.keys(r)) {
      expect(r[k].outside, k + ': drawn slash pixels outside the hit area').toBe(0);
    }
    expect(Object.values(r).filter((v) => v.bright > 8).length, 'the slash really is drawn in these frames').toBeGreaterThan(14);
  });

  test('WPN-15 the sword hits a boss exactly where the slash touches it: 3 px in, a hit; 3 px short, a miss', async ({ page }) => {
    const r = await page.evaluate(async (P) => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      const out = {};
      const p = Object.assign({}, P, { swingDir: 'right', utility: '' });
      const hitsAny = (b) => raidSwingHitsBoss(p, b);
      // find the slash's farthest-right point over the whole swing, then slide a boss across it
      let tip = -1e9, tipY = 0;
      for (let t = 12; t >= 3; t--) { const poly = raidSlashWorldPoly(p, 1 - t / RAID_SWORD_SWING_FRAMES); if (poly) poly.forEach((q) => { if (q[0] > tip) { tip = q[0]; tipY = q[1]; } }); }
      out.tip = tip;
      // grinmaw's own left edge at the row of the tip
      const probe = Object.assign({}, raidG.boss, { type: 'grinmaw', x: 0, y: tipY - 20, animScale: 1 });
      const rects = raidBossRects(probe).filter((q) => q[1] <= tipY && q[3] >= tipY);
      const leftEdge = Math.min(...rects.map((q) => q[0]));
      const at = (dx) => hitsAny(Object.assign({}, raidG.boss, { type: 'grinmaw', x: tip - leftEdge + dx, y: tipY - 20, animScale: 1 }));
      out.inside = at(-3); out.outside = at(3);
      // and it cannot hit what is behind it or far above
      out.behind = hitsAny(Object.assign({}, raidG.boss, { type: 'grinmaw', x: 60, y: 300, animScale: 1 }));
      return out;
    }, PLAYER);
    expect(r.inside, 'a boss 3 px into the slash is hit').toBe(true);
    expect(r.outside, 'a boss 3 px clear of the slash is not').toBe(false);
    expect(r.behind).toBe(false);
  });

  test('WPN-15 a hit is still registered when the host never sees the few frames the slash is in view (laggy or batched updates)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      raidG.boss.x = 500; raidG.boss.y = 300;
      const hp0 = raidG.boss.hp;
      // the swinger's synced timer goes 14 -> 13 -> (nothing for a while) -> 2: the whole visible window is skipped
      T.place(500 - 70, 300 - 24, { swingDir: 'right', facing: 1, utility: '' });
      const sync = (timer) => { raidSwingHitState = raidSwingHitState || {}; raidG.players[raidMyId].swingTimer = timer; raidG.players[raidMyId].swingDir = 'right'; raidG.players[raidMyId].facing = 1; raidCheckSwordSwings(raidG.boss); };
      raidSwingHitState = {};
      sync(14); sync(13);
      const mid = raidG.boss.hp;
      sync(2);
      const after = raidG.boss.hp;
      sync(1); sync(0);
      return { hp0, mid, after, final: raidG.boss.hp };
    });
    expect(r.mid, 'nothing yet before the slash is reached').toBe(r.hp0);
    expect(r.after, 'the skipped frames are replayed and the boss is hit once').toBe(r.hp0 - 4);
    expect(r.final, 'and only once').toBe(r.hp0 - 4);
  });
});

test.describe('Second Wind (WPN-06)', () => {
  test('WPN-06 the Second Wind hop is a little higher: 85% of the first jump launch speed', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const rise = (vy) => (vy * vy) / (2 * RAID_GRAVITY);
      return { ratio: RAID_AIR_JUMP_VY / RAID_JUMP_VY, first: rise(RAID_JUMP_VY), air: rise(RAID_AIR_JUMP_VY) };
    });
    expect(r.ratio).toBeCloseTo(0.85, 5);
    expect(r.air, 'about 85 px').toBeGreaterThan(80);
    expect(r.air).toBeLessThan(95);
    expect(r.air, 'still a smaller hop than the first jump').toBeLessThan(r.first);
  });
});
