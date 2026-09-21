// Spec sections 10.2-10.3 and GEN-06: shop, crates and odds, duplicates, inventory, equip, items.
const { test, expect } = require('./support/fixtures');

// Page-side helpers used by several tests.
const HELPERS = `
  window.forceRoll = (crateId, itemId) => {
    const pool = mqCratePool(MQ_CRATE_MAP[crateId]);
    let acc = 0;
    for (const e of pool) {
      if (e.item.id === itemId) { const roll = acc + e.prob / 2; Math.random = () => roll; return; }
      acc += e.prob;
    }
    throw new Error(itemId + ' is not in ' + crateId);
  };
  window.ownAll = () => { MQ_ITEMS.forEach((i) => { mqProfile.owned[i.id] = mqProfile.owned[i.id] || 1; }); };
  window.hashCanvas = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 7; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + d[i + 3]) % 1000000007; return h; };
  window.opaque = (c, x, y, w, h) => { const d = c.getContext('2d').getImageData(x, y, w, h).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++; return n; };
`;

test.beforeEach(async ({ page }) => { await page.evaluate(HELPERS); });

const SPEC_SKINS = {
  common: ['Classic Cup', 'Sprout', 'Bubblegum', 'Bumblebee'],
  uncommon: ['Buccaneer', 'Frost Sprite', 'Shadow Ninja'],
  rare: ['Astronaut', 'Star Wizard', 'Robo-Bot'],
  epic: ['Inferno', 'Galaxy Walker'],
  legendary: ['Golden Champion', 'Prism Phantom']
};
const SPEC_GUNS = {
  common: ['Standard Blaster', 'Candy Blaster', 'Bubble Popper', 'Lime Zapper'],
  uncommon: ['Rocket Ray', 'Pixel Pistol', 'Petal Wand'],
  rare: ['Frost Cannon', 'Ember Rifle', 'Stardust Wand'],
  epic: ['Void Pulse', 'Solar Flare'],
  legendary: ['Sunbreaker', 'Prism Railgun']
};

test.describe('Shop and crates (spec 10.2)', () => {
  test('SHP-01 the shop has Crates and My Items tabs and always shows the balance', async ({ page }) => {
    await page.evaluate(() => { mqProfile.coins = 4321; showSection('shop'); mqOnShopOpen(); });
    await expect(page.locator('.shop-coins .mq-coin-value')).toHaveText('4,321');
    await expect(page.locator('#shopCrates')).toBeVisible();
    await expect(page.locator('#shopInventory')).toBeHidden();
    await page.getByRole('button', { name: /My Items/ }).click();
    await expect(page.locator('#shopInventory')).toBeVisible();
    await expect(page.locator('#shopCrates')).toBeHidden();
    await expect(page.locator('.shop-coins .mq-coin-value')).toHaveText('4,321');
    await page.getByRole('button', { name: /Crates/ }).click();
    await expect(page.locator('#shopCrates')).toBeVisible();
    await expect(page.locator('.crate-card')).toHaveCount(5);
  });

  test('SHP-02 the five crates have the specified prices, loot pools and rarity weights', async ({ page }) => {
    const r = await page.evaluate(() => Object.fromEntries(MQ_CRATES.map((c) => [c.id, {
      name: c.name, price: c.price, weights: c.weights,
      pool: mqCratePool(c).map((e) => e.item.name).sort(),
      types: [...new Set(mqCratePool(c).map((e) => e.item.type))].sort(),
      rarities: [...new Set(mqCratePool(c).map((e) => e.item.rarity))].sort()
    }])));
    expect(Object.keys(r)).toEqual(['crate_starter', 'crate_hero', 'crate_arsenal', 'crate_cosmic', 'crate_legend']);
    expect(r.crate_starter).toMatchObject({ name: 'Starter Crate', price: 100, weights: { common: 64, uncommon: 27, rare: 8, epic: 1 } });
    expect(r.crate_hero).toMatchObject({ name: 'Hero Crate', price: 250, weights: { uncommon: 38, rare: 40, epic: 17, legendary: 5 } });
    expect(r.crate_arsenal).toMatchObject({ name: 'Arsenal Crate', price: 250, weights: { uncommon: 38, rare: 40, epic: 17, legendary: 5 } });
    expect(r.crate_cosmic).toMatchObject({ name: 'Cosmic Crate', price: 400, weights: { rare: 60, epic: 32, legendary: 8 } });
    expect(r.crate_legend).toMatchObject({ name: 'Legend Crate', price: 700, weights: { rare: 46, epic: 39, legendary: 15 } });

    expect(r.crate_starter.pool).toHaveLength(22);
    expect(r.crate_starter.types).toEqual(['gun', 'skin']);
    expect(r.crate_starter.rarities).toEqual(['common', 'epic', 'rare', 'uncommon']);
    expect(r.crate_hero.pool).toHaveLength(10);
    expect(r.crate_hero.types).toEqual(['skin']);
    expect(r.crate_hero.rarities).toEqual(['epic', 'legendary', 'rare', 'uncommon']);
    expect(r.crate_arsenal.pool).toHaveLength(10);
    expect(r.crate_arsenal.types).toEqual(['gun']);
    expect(r.crate_cosmic.pool).toEqual(['Astronaut', 'Galaxy Walker', 'Solar Flare', 'Stardust Wand', 'Sunbreaker', 'Void Pulse']);
    expect(r.crate_legend.pool).toHaveLength(14);
    expect(r.crate_legend.rarities).toEqual(['epic', 'legendary', 'rare']);
    // default items are never in a crate
    Object.values(r).forEach((c) => { expect(c.pool).not.toContain('Classic Cup'); expect(c.pool).not.toContain('Standard Blaster'); });
  });

  test('SHP-03 each crate has an Odds popup listing every item with exact chances that sum to 100%', async ({ page }) => {
    const ids = ['crate_starter', 'crate_hero', 'crate_arsenal', 'crate_cosmic', 'crate_legend'];
    for (const id of ids) {
      await page.evaluate((id) => { showSection('shop'); mqOnShopOpen(); mqShowOdds(id); }, id);
      await expect(page.locator('#mqModal.open')).toBeVisible();
      const r = await page.evaluate((id) => {
        const pool = mqCratePool(MQ_CRATE_MAP[id]);
        const rows = Array.from(document.querySelectorAll('.mq-odds-row')).map((row) => ({ name: row.querySelector('.mq-odds-name').textContent.replace(/^\S+\s/, ''), pct: parseFloat(row.querySelector('.mq-odds-pct').textContent) }));
        const groups = Array.from(document.querySelectorAll('.mq-odds-group')).map((g) => ({ rarity: g.querySelector('.mq-odds-rar').textContent, total: parseFloat(g.querySelector('.mq-odds-total').textContent) }));
        return { poolSize: pool.length, exactSum: pool.reduce((a, e) => a + e.prob, 0), rows, groups, names: pool.map((e) => e.item.name).sort(), text: document.getElementById('mqModalCard').innerText };
      }, id);
      expect(r.rows, id).toHaveLength(r.poolSize);
      expect(r.rows.map((x) => x.name).sort(), id).toEqual(r.names);
      expect(r.exactSum).toBeCloseTo(1, 9);
      expect(r.rows.reduce((a, x) => a + x.pct, 0), id + ' item percentages').toBeGreaterThan(99.6);
      expect(r.rows.reduce((a, x) => a + x.pct, 0), id + ' item percentages').toBeLessThan(100.4);
      expect(r.groups.reduce((a, g) => a + g.total, 0), id + ' rarity totals').toBeCloseTo(100, 0);
      expect(r.text).toMatch(/Duplicates .* convert to coins/);
      await page.evaluate(() => mqCloseModal());
      await expect(page.locator('#mqModal.open')).toHaveCount(0);
    }
    // spot check: Cosmic crate has a single legendary at 8%
    await page.evaluate(() => mqShowOdds('crate_cosmic'));
    await expect(page.locator('.mq-odds-group', { hasText: 'Legendary' })).toContainText('Sunbreaker');
    await expect(page.locator('.mq-odds-group', { hasText: 'Legendary' }).locator('.mq-odds-pct')).toHaveText('8%');
  });

  test('SHP-04 opening a crate costs coins, plays the animation, reveals the item; too few coins does nothing', async ({ page }) => {
    // not enough coins
    await page.evaluate(() => { mqProfile.coins = 50; showSection('shop'); mqOnShopOpen(); mqOpenCrate('crate_starter'); });
    await expect(page.locator('#mqToast')).toContainText('50 more');
    expect(await page.evaluate(() => ({ coins: mqProfile.coins, open: !!(document.getElementById('mqModal') && document.getElementById('mqModal').classList.contains('open')) }))).toEqual({ coins: 50, open: false });

    // enough coins: deducted at once; crate shakes, then the lid opens, then the item is revealed
    await page.evaluate(() => { mqProfile.coins = 1000; forceRoll('crate_hero', 'skin_wizard'); mqOpenCrate('crate_hero'); });
    expect(await page.evaluate(() => mqProfile.coins)).toBe(750);
    await expect(page.locator('.mq-crate-wrap.shaking')).toBeVisible();
    // the lid state only lasts ~0.5 s, so poll every animation frame instead of at expect() intervals
    await page.waitForFunction(() => document.querySelector('.mq-crate-wrap.opening'), null, { polling: 'raf', timeout: 4000 });
    await expect(page.locator('#mqReveal')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.mq-rarity-banner')).toHaveText('RARE');
    await expect(page.locator('.mq-item-name')).toHaveText('Star Wizard');
    await expect(page.locator('.mq-item-status')).toContainText('NEW');
    expect(await page.evaluate(() => mqProfile.owned.skin_wizard)).toBe(1);
    // the item preview is actually drawn
    expect(await page.evaluate(() => opaque(document.getElementById('mqRevealCanvas'), 0, 0, 240, 270))).toBeGreaterThan(2000);
    await page.evaluate(() => mqCloseModal());

    // confetti grows with rarity
    const confetti = async (itemId, crate) => {
      await page.evaluate(([i, c]) => { mqProfile.coins = 5000; forceRoll(c, i); mqOpenCrate(c); document.getElementById('mqStage').click(); }, [itemId, crate]);
      const n = await page.locator('.mq-conf').count();
      await page.evaluate(() => mqCloseModal());
      return n;
    };
    const uncommon = await confetti('skin_ninja', 'crate_hero');
    const legendary = await confetti('skin_golden', 'crate_hero');
    expect(uncommon).toBe(8);
    expect(legendary).toBe(44);
  });

  test('SHP-05 duplicates convert to coins: Common 10, Uncommon 25, Rare 60, Epic 150, Legendary 350', async ({ page }) => {
    const r = await page.evaluate(() => {
      ownAll();
      const picks = [['crate_starter', 'skin_sprout', 'common'], ['crate_starter', 'gun_pixel', 'uncommon'], ['crate_starter', 'skin_robot', 'rare'],
        ['crate_starter', 'gun_void', 'epic'], ['crate_hero', 'skin_rainbow', 'legendary']];
      const out = [];
      for (const [crate, item, rarity] of picks) {
        mqProfile.coins = 1000; forceRoll(crate, item);
        const before = mqProfile.coins; mqOpenCrate(crate);
        out.push({ rarity, net: mqProfile.coins - before + MQ_CRATE_MAP[crate].price, status: document.querySelector('#mqModal') ? null : null });
        mqCloseModal();
      }
      return { out, table: Object.fromEntries(MQ_RARITY_ORDER.map((k) => [k, MQ_RARITY[k].refund])) };
    });
    expect(r.table).toEqual({ common: 10, uncommon: 25, rare: 60, epic: 150, legendary: 350 });
    expect(r.out.map((o) => [o.rarity, o.net])).toEqual([['common', 10], ['uncommon', 25], ['rare', 60], ['epic', 150], ['legendary', 350]]);
    // the reveal says so
    await page.evaluate(() => { mqProfile.coins = 1000; forceRoll('crate_starter', 'skin_sprout'); mqOpenCrate('crate_starter'); document.getElementById('mqStage').click(); });
    await expect(page.locator('.mq-item-status')).toContainText('Duplicate - converted to +10');
  });
});

test.describe('My Items and equipping (spec 10.2)', () => {
  test('SHP-06 My Items shows the loadout, filters, locked items, counts and Equip buttons', async ({ page }) => {
    await page.evaluate(() => {
      mqProfile.owned.skin_wizard = 2; mqProfile.owned.gun_frost = 1;
      showSection('shop'); mqOnShopOpen(); mqSetTab('inv');
    });
    await expect(page.locator('.inv-card')).toHaveCount(28);
    await expect(page.locator('#invCount')).toHaveText('4 / 28 collected');
    await expect(page.locator('.inv-card.locked')).toHaveCount(24);
    await expect(page.locator('.inv-card:not(.locked) .inv-equip')).toHaveCount(4);
    await expect(page.locator('.inv-card.locked .inv-equip')).toHaveCount(0);
    await expect(page.locator('.inv-card', { hasText: 'Star Wizard' })).toContainText('x2');

    await page.locator('#invF_skin').click();
    await expect(page.locator('.inv-card')).toHaveCount(14);
    await page.locator('#invF_gun').click();
    await expect(page.locator('.inv-card')).toHaveCount(14);
    await page.locator('#invF_all').click();
    await page.locator('#invHideLocked').check();
    await expect(page.locator('.inv-card')).toHaveCount(4);

    // the loadout preview is a live canvas that fires and then reloads
    const r = await page.evaluate(() => {
      const c = document.getElementById('loadoutCanvas');
      const labels = [];
      const real = c.getContext('2d').fillText.bind(c.getContext('2d'));
      c.getContext('2d').fillText = (t, ...a) => { labels.push(t); return real(t, ...a); };
      mqDrawLoadout(c, 60); mqDrawLoadout(c, 200);
      c.getContext('2d').fillText = real;
      mqDrawLoadout(c, 60);
      return { labels, drawn: opaque(c, 0, 0, c.width, c.height) };
    });
    expect(r.labels).toEqual(['FIRING', 'RELOADING...']);
    expect(r.drawn).toBeGreaterThan(5000);
    await expect(page.locator('#loadoutSkin')).toContainText('Classic Cup');
    await expect(page.locator('#loadoutGun')).toContainText('Standard Blaster');
  });

  test('SHP-07 one skin and one gun can be equipped; only owned items; defaults are always owned', async ({ page }) => {
    const r = await page.evaluate(() => {
      const out = { start: JSON.parse(JSON.stringify(mqProfile.equipped)), owned: Object.keys(mqProfile.owned).sort() };
      mqEquipItem('skin_golden'); out.unowned = mqProfile.equipped.skin;
      mqProfile.owned.skin_golden = 1; mqProfile.owned.skin_wizard = 1; mqProfile.owned.gun_frost = 1;
      mqEquipItem('skin_golden'); mqEquipItem('gun_frost');
      out.golden = JSON.parse(JSON.stringify(mqProfile.equipped));
      mqEquipItem('skin_wizard');
      out.swapped = JSON.parse(JSON.stringify(mqProfile.equipped));
      out.saved = JSON.parse(localStorage.getItem(MQ_PROFILE_KEY)).equipped;
      return out;
    });
    expect(r.start).toEqual({ skin: 'skin_classic', gun: 'gun_standard' });
    expect(r.owned).toEqual(['gun_standard', 'skin_classic']);
    expect(r.unowned).toBe('skin_classic');
    expect(r.golden).toEqual({ skin: 'skin_golden', gun: 'gun_frost' });
    expect(r.swapped).toEqual({ skin: 'skin_wizard', gun: 'gun_frost' });
    expect(r.saved).toEqual(r.swapped);
    // the Equip button in the UI does the same and marks the card
    await page.evaluate(() => { mqProfile.owned.skin_golden = 1; showSection('shop'); mqOnShopOpen(); mqSetTab('inv'); });
    await page.locator('.inv-card', { hasText: 'Golden Champion' }).getByRole('button', { name: 'Equip' }).click();
    await expect(page.locator('.inv-card.equipped')).toHaveCount(2);
    await expect(page.locator('.inv-card', { hasText: 'Golden Champion' }).locator('.inv-equip')).toHaveText('Equipped ✓');
  });

  test('SHP-08 equipped items are used in the raid and shown to everyone (skin, gun, bullets, reload)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      mqProfile.owned.skin_wizard = 1; mqProfile.owned.gun_ember = 1;
      mqEquipItem('skin_wizard'); mqEquipItem('gun_ember');
      await T.setupRaid('grinmaw');
      const out = { local: [raidLocal.skin, raidLocal.gun], synced: [T.me().skin, T.me().gun] };
      raidShootProjectile();
      out.bulletGun = raidG.playerProjectiles[raidG.playerProjectiles.length - 1].gun;
      // a teammate's cosmetics come from their player node
      const calls = [];
      const real = window.drawPlayerCuphead;
      window.drawPlayerCuphead = function (ctx, x, y, w, h, f, hp, mhp, sh, inv, isLocal, look) { calls.push({ isLocal, look: JSON.parse(JSON.stringify(look || {})) }); return real.apply(this, arguments); };
      raidG.players = Object.assign({}, raidG.players, { mate: { x: 700, y: 452, health: 5, facing: -1, skin: 'skin_galaxy', gun: 'gun_void', reload: 0.4 } });
      raidReloadTimer = 50; raidDraw();
      window.drawPlayerCuphead = real;
      out.mate = calls.find((c) => !c.isLocal).look;
      out.me = calls.find((c) => c.isLocal).look;
      return out;
    });
    expect(r.local).toEqual(['skin_wizard', 'gun_ember']);
    expect(r.synced).toEqual(['skin_wizard', 'gun_ember']);
    expect(r.bulletGun).toBe('gun_ember');
    expect(r.mate).toMatchObject({ skin: 'skin_galaxy', gun: 'gun_void', reload: 0.4 });
    expect(r.me).toMatchObject({ skin: 'skin_wizard', gun: 'gun_ember' });
    expect(r.me.reload).toBeCloseTo(0.5, 2);
  });

  test('SHP-09 skins are cosmetic only: no gameplay number depends on the equipped skin or gun', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = [];
      for (const gun of MQ_GUNS.map((g) => g.id)) {
        raidLocal.gun = gun; raidAmmo = 20; raidFireCooldown = 0; raidReloadTimer = 0; raidG.playerProjectiles = [];
        raidShootProjectile();
        const b = raidG.playerProjectiles[raidG.playerProjectiles.length - 1];
        out.push([b.damage, b.vy, b.life, b.r, raidAmmo, RAID_RELOAD_FRAMES].join(','));
      }
      const dims = MQ_SKINS.map((s) => { raidLocal.skin = s.id; return [raidLocal.w, raidLocal.h, raidLocal.maxHealth].join(','); });
      return { guns: [...new Set(out)], dims: [...new Set(dims)] };
    });
    expect(r.guns).toEqual(['3,-6,120,6,19,100']);
    expect(r.dims).toEqual(['36,48,5']);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
    // gun/skin ids never feed damage or health logic
    expect(src).not.toMatch(/damage[^;\n]*(gun_|skin_)/);
  });
});

test.describe('Items (spec 10.3)', () => {
  test('ITM-01 14 skins and 14 gun skins in five rarities, each drawn with animation on the higher tiers', async ({ page }) => {
    const r = await page.evaluate(() => {
      const byRarity = (list) => Object.fromEntries(MQ_RARITY_ORDER.map((k) => [k, list.filter((i) => i.rarity === k).map((i) => i.name)]));
      const draw = (skin, gun, t) => {
        const c = document.createElement('canvas'); c.width = 160; c.height = 190;
        const ctx = c.getContext('2d');
        ctx.translate(80, 130); ctx.scale(1.2, 1.2);
        drawPlayerCuphead(ctx, -18, -24, 36, 48, 1, 5, 5, false, 0, true, { skin, gun, t, noBar: true, noShadow: true });
        return c;
      };
      const skinHashes = {}, animated = {};
      for (const s of MQ_SKINS) { skinHashes[s.id] = hashCanvas(draw(s.id, 'gun_standard', 10)); animated[s.id] = hashCanvas(draw(s.id, 'gun_standard', 10)) !== hashCanvas(draw(s.id, 'gun_standard', 45)); }
      const ids = MQ_SKINS.map((s) => s.id);
      const errors = [];
      for (const s of MQ_SKINS) for (const g of MQ_GUNS) { try { draw(s.id, g.id, 5); } catch (e) { errors.push(s.id + '/' + g.id + ': ' + e.message); } }
      const preview = MQ_ITEMS.map((it) => { const c = document.createElement('canvas'); c.width = 150; c.height = 170; mqDrawItemPreview(c, it.id, 20, {}); return [it.id, opaque(c, 0, 0, 150, 170)]; });
      return {
        skins: byRarity(MQ_SKINS), guns: byRarity(MQ_GUNS), distinctSkins: new Set(Object.values(skinHashes)).size, total: ids.length, errors,
        animatedRare: MQ_SKINS.filter((s) => ['epic', 'legendary'].includes(s.rarity)).map((s) => animated[s.id]),
        emptyPreviews: preview.filter((p) => p[1] < 1500).map((p) => p[0]),
        uniqueIds: new Set(MQ_ITEMS.map((i) => i.id)).size, items: MQ_ITEMS.length
      };
    });
    expect(r.skins).toEqual(SPEC_SKINS);
    expect(r.guns).toEqual(SPEC_GUNS);
    expect(r.items).toBe(28);
    expect(r.uniqueIds).toBe(28);
    expect(r.distinctSkins, 'every skin looks different').toBe(14);
    expect(r.errors).toEqual([]);
    expect(r.animatedRare, 'epic and legendary skins are animated').toEqual([true, true, true, true]);
    expect(r.emptyPreviews).toEqual([]);
  });

  test('ITM-02 gun skins change the gun model, the bullet and the trail', async ({ page }) => {
    const r = await page.evaluate(() => {
      const shapes = new Set(MQ_GUNS.map((g) => g.shape));
      const bulletKinds = new Set(MQ_GUNS.map((g) => g.bullet.kind));
      const trails = new Set(MQ_GUNS.map((g) => g.bullet.trail));
      const bullet = (gun) => { const c = document.createElement('canvas'); c.width = 60; c.height = 90; const ctx = c.getContext('2d'); drawPlayerBullet(ctx, { x: 30, y: 30, vx: 0, vy: -6, r: 6, gun, t: 12 }); return hashCanvas(c); };
      const body = (gun) => { const c = document.createElement('canvas'); c.width = 80; c.height = 100; const ctx = c.getContext('2d'); ctx.translate(40, 70); mqDrawGun(ctx, gun, 0, 0, 1, 0, 0, 5); return hashCanvas(c); };
      const trailPixels = (gun) => { const c = document.createElement('canvas'); c.width = 60; c.height = 120; const ctx = c.getContext('2d'); drawPlayerBullet(ctx, { x: 30, y: 30, vx: 0, vy: -6, r: 6, gun, t: 12 }); return opaque(c, 0, 45, 60, 75); };
      return {
        shapes: [...shapes].sort(), bulletKinds: bulletKinds.size, trails: trails.size,
        distinctBullets: new Set(MQ_GUNS.map((g) => bullet(g.id))).size,
        distinctGuns: new Set(MQ_GUNS.map((g) => body(g.id))).size,
        trailsDrawn: MQ_GUNS.filter((g) => trailPixels(g.id) < 10).map((g) => g.id), // a bullet with no trail leaves ~0 pixels here; browsers differ slightly at the edges
        unknownGunFallsBack: (() => { const c = document.createElement('canvas'); c.width = 60; c.height = 90; drawPlayerBullet(c.getContext('2d'), { x: 30, y: 30, vx: 0, vy: -6, r: 6, gun: 'nope', t: 1 }); return true; })()
      };
    });
    expect(r.shapes).toEqual(['blaster', 'cannon', 'ray', 'rail', 'wand'].sort());
    expect(r.bulletKinds).toBeGreaterThanOrEqual(9);
    expect(r.trails).toBeGreaterThanOrEqual(9);
    expect(r.distinctBullets, 'every gun has its own bullet look').toBe(14);
    expect(r.distinctGuns, 'every gun has its own look').toBe(14);
    expect(r.trailsDrawn).toEqual([]);
    expect(r.unknownGunFallsBack).toBe(true);
  });

  test('ITM-03 tall hats and hair do not overlap the floating health bar', async ({ page }) => {
    const r = await page.evaluate(() => {
      const out = {};
      for (const s of MQ_SKINS) {
        const c = document.createElement('canvas'); c.width = 160; c.height = 220;
        const ctx = c.getContext('2d');
        // player top-left at (62,120); the bar sits at y-42-lift (6px tall), 44px wide
        drawPlayerCuphead(ctx, 62, 120, 36, 48, 1, 5, 5, false, 0, true, { skin: s.id, noBar: true, noShadow: true, noGun: true, t: 10 });
        const barY = 120 - 42 - (s.barLift || 0);
        out[s.id] = opaque(c, 58, barY, 44, 6);
      }
      return out;
    });
    Object.keys(r).forEach((id) => expect(r[id], id + ' art under the health bar').toBeLessThanOrEqual(30));
  });
});

test.describe('Saved progress (GEN-06)', () => {
  test('GEN-06 coins, owned and equipped items live in localStorage and survive a reload', async ({ page }) => {
    await page.evaluate(() => {
      mqProfile.coins = 777; mqProfile.owned.skin_ninja = 3; mqProfile.owned.gun_lime = 1;
      mqEquipItem('skin_ninja'); mqEquipItem('gun_lime'); mqSaveProfile();
    });
    await page.reload();
    await page.waitForFunction(() => typeof mqProfile !== 'undefined');
    const r = await page.evaluate(() => ({ coins: mqProfile.coins, ninja: mqProfile.owned.skin_ninja, equipped: mqProfile.equipped, side: document.querySelector('.sidebar-coins .mq-coin-value').textContent, fbCoinWrites: __fb.db.log.filter((l) => /coin|profile/i.test(l.path)).length }));
    expect(r).toEqual({ coins: 777, ninja: 3, equipped: { skin: 'skin_ninja', gun: 'gun_lime' }, side: '777', fbCoinWrites: 0 });
  });

  test('GEN-06 a corrupt or tampered save falls back safely', async ({ page }) => {
    const r = await page.evaluate(() => {
      const load = (raw) => { localStorage.setItem(MQ_PROFILE_KEY, raw); return mqLoadProfile(); };
      const bad = load('{not json');
      const junk = load(JSON.stringify({ coins: -50, owned: { skin_golden: 1, made_up_item: 9 }, equipped: { skin: 'skin_wizard', gun: 'gun_frost' }, stats: { crates: 'x' } }));
      return { bad, junk };
    });
    expect(r.bad.coins).toBe(0);
    expect(r.bad.equipped).toEqual({ skin: 'skin_classic', gun: 'gun_standard' });
    expect(r.junk.coins).toBe(0);
    expect(Object.keys(r.junk.owned).sort()).toEqual(['gun_standard', 'skin_classic', 'skin_golden']);
    expect(r.junk.equipped).toEqual({ skin: 'skin_classic', gun: 'gun_standard' }); // equipped items must be owned
    expect(r.junk.stats.crates).toBe(0);
  });
});
