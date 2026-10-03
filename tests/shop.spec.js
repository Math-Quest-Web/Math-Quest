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
const SPEC_SWORDS = {
  common: ['Training Nail'],
  uncommon: ['Moss Blade'],
  rare: ['Frostbite Edge'],
  epic: ['Voidbone Fang'],
  legendary: ['Dawnbreaker']
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

    expect(r.crate_starter.pool).toHaveLength(33);
    expect(r.crate_starter.types).toEqual(['skin', 'sword', 'utility']);
    expect(r.crate_starter.rarities).toEqual(['common', 'epic', 'rare', 'uncommon']);
    expect(r.crate_hero.pool).toHaveLength(10);
    expect(r.crate_hero.types).toEqual(['skin']);
    expect(r.crate_hero.rarities).toEqual(['epic', 'legendary', 'rare', 'uncommon']);
    // Arsenal is swords and charms (charms are weapon-locker gear, WPN-03); there are no guns any more.
    expect(r.crate_arsenal.pool).toHaveLength(21);
    expect(r.crate_arsenal.types).toEqual(['sword', 'utility']);
    // The cosmic-tagged items: two skins and two swords (Dawnbreaker took over as the cosmic legendary).
    expect(r.crate_cosmic.pool).toEqual(['Astronaut', 'Dawnbreaker', 'Galaxy Walker', 'Voidbone Fang']);
    expect(r.crate_legend.pool).toHaveLength(22);
    expect(r.crate_legend.types).toEqual(['skin', 'sword', 'utility']);
    expect(r.crate_legend.rarities).toEqual(['epic', 'legendary', 'rare']);
    // default items are never in a crate
    Object.values(r).forEach((c) => { expect(c.pool).not.toContain('Classic Cup'); expect(c.pool).not.toContain('Training Nail'); });
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
    await expect(page.locator('.mq-odds-group', { hasText: 'Legendary' })).toContainText('Dawnbreaker');
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
      const picks = [['crate_starter', 'skin_sprout', 'common'], ['crate_starter', 'sword_moss', 'uncommon'], ['crate_starter', 'skin_robot', 'rare'],
        ['crate_starter', 'sword_void', 'epic'], ['crate_hero', 'skin_rainbow', 'legendary']];
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
      mqProfile.owned.skin_wizard = 2; mqProfile.owned.sword_frost = 1;
      showSection('shop'); mqOnShopOpen(); mqSetTab('inv');
    });
    await expect(page.locator('.inv-card')).toHaveCount(42);
    await expect(page.locator('#invCount')).toHaveText('4 / 42 collected');
    await expect(page.locator('.inv-card.locked')).toHaveCount(38);
    await expect(page.locator('.inv-card:not(.locked) .inv-equip')).toHaveCount(4);
    await expect(page.locator('.inv-card.locked .inv-equip')).toHaveCount(0);
    await expect(page.locator('.inv-card.locked .inv-buy'), 'every locked item can be bought').toHaveCount(38);
    await expect(page.locator('.inv-card:not(.locked) .inv-buy')).toHaveCount(0);
    await expect(page.locator('.inv-card', { hasText: 'Star Wizard' })).toContainText('x2');

    await page.locator('#invF_skin').click();
    await expect(page.locator('.inv-card')).toHaveCount(14);
    await page.locator('#invF_weapon').click();
    await expect(page.locator('.inv-card')).toHaveCount(5);
    await page.locator('#invF_all').click();
    await page.locator('#invHideLocked').check();
    await expect(page.locator('.inv-card')).toHaveCount(4);

    // the loadout preview is a live canvas of the player standing still: no swinging, no label
    const r = await page.evaluate(() => {
      const c = document.getElementById('loadoutCanvas');
      const labels = [], swings = new Set();
      const real = c.getContext('2d').fillText.bind(c.getContext('2d'));
      c.getContext('2d').fillText = (t, ...a) => { labels.push(t); return real(t, ...a); };
      const realDraw = window.drawPlayerCuphead;
      window.drawPlayerCuphead = function (...args) { swings.add(args[11] && args[11].swing); return realDraw.apply(this, args); };
      for (let t = 0; t < 400; t += 7) mqDrawLoadout(c, t);
      window.drawPlayerCuphead = realDraw;
      c.getContext('2d').fillText = real;
      mqDrawLoadout(c, 60);
      return { labels, swings: [...swings], drawn: opaque(c, 0, 0, c.width, c.height) };
    });
    expect(r.labels, 'no SWINGING / READY caption').toEqual([]);
    expect(r.swings, 'the player never swings in the preview').toEqual([0]);
    expect(r.drawn).toBeGreaterThan(5000);
    await expect(page.locator('#loadoutSkin')).toContainText('Classic Cup');
    await expect(page.locator('#loadoutGun')).toContainText('Training Nail');
  });

  test('SHP-07 one skin and one sword can be equipped; only owned items; defaults are always owned', async ({ page }) => {
    const r = await page.evaluate(() => {
      const out = { start: JSON.parse(JSON.stringify(mqProfile.equipped)), owned: Object.keys(mqProfile.owned).sort() };
      mqEquipItem('skin_golden'); out.unowned = mqProfile.equipped.skin;
      mqProfile.owned.skin_golden = 1; mqProfile.owned.skin_wizard = 1; mqProfile.owned.sword_frost = 1;
      mqEquipItem('skin_golden'); mqEquipItem('sword_frost');
      out.golden = JSON.parse(JSON.stringify(mqProfile.equipped));
      mqEquipItem('skin_wizard');
      out.swapped = JSON.parse(JSON.stringify(mqProfile.equipped));
      out.saved = JSON.parse(localStorage.getItem(MQ_PROFILE_KEY)).equipped;
      return out;
    });
    expect(r.start).toEqual({ skin: 'skin_classic', gun: 'sword_training', utility: '' });
    expect(r.owned).toEqual(['skin_classic', 'sword_training']);
    expect(r.unowned).toBe('skin_classic');
    expect(r.golden).toEqual({ skin: 'skin_golden', gun: 'sword_frost', utility: '' });
    expect(r.swapped).toEqual({ skin: 'skin_wizard', gun: 'sword_frost', utility: '' });
    expect(r.saved).toEqual(r.swapped);
    // the Equip button in the UI does the same and marks the card
    await page.evaluate(() => { mqProfile.owned.skin_golden = 1; showSection('shop'); mqOnShopOpen(); mqSetTab('inv'); });
    await page.locator('.inv-card', { hasText: 'Golden Champion' }).getByRole('button', { name: 'Equip' }).click();
    await expect(page.locator('.inv-card.equipped')).toHaveCount(2);
    await expect(page.locator('.inv-card', { hasText: 'Golden Champion' }).locator('.inv-equip')).toHaveText('Equipped ✓');
  });

  test('SHP-08 equipped items are used in the raid and shown to everyone (skin and sword)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      mqProfile.owned.skin_wizard = 1; mqProfile.owned.sword_void = 1;
      mqEquipItem('skin_wizard'); mqEquipItem('sword_void');
      await T.setupRaid('grinmaw');
      const out = { local: [raidLocal.skin, raidLocal.gun], synced: [T.me().skin, T.me().gun] };
      // a teammate's cosmetics come from their player node
      const calls = [];
      const real = window.drawPlayerCuphead;
      window.drawPlayerCuphead = function (ctx, x, y, w, h, f, hp, mhp, sh, inv, isLocal, look) { calls.push({ isLocal, look: JSON.parse(JSON.stringify(look || {})) }); return real.apply(this, arguments); };
      raidG.players = Object.assign({}, raidG.players, { mate: { x: 700, y: 452, health: 5, facing: -1, skin: 'skin_galaxy', gun: 'sword_frost' } });
      raidDraw();
      window.drawPlayerCuphead = real;
      out.mate = calls.find((c) => !c.isLocal).look;
      out.me = calls.find((c) => c.isLocal).look;
      return out;
    });
    expect(r.local).toEqual(['skin_wizard', 'sword_void']);
    expect(r.synced).toEqual(['skin_wizard', 'sword_void']);
    expect(r.mate).toMatchObject({ skin: 'skin_galaxy', gun: 'sword_frost' });
    expect(r.me).toMatchObject({ skin: 'skin_wizard', gun: 'sword_void' });
  });

  test('SHP-09 skins are cosmetic only: no gameplay number depends on the equipped skin or sword', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = [];
      for (const sword of MQ_SWORDS.map((s) => s.id)) {
        raidLocal.gun = sword;
        const bb = raidPolyBounds(raidSlashWorldPoly(Object.assign({}, raidLocal, { swingDir: 'side', utility: '' }), 0.45));
        out.push([RAID_SWORD_DAMAGE, RAID_SWORD_COOLDOWN_FRAMES, RAID_SWORD_SWING_FRAMES, bb.x0, bb.x1, bb.y0, bb.y1].join(','));
      }
      const dims = MQ_SKINS.map((s) => { raidLocal.skin = s.id; return [raidLocal.w, raidLocal.h, raidLocal.maxHealth].join(','); });
      return { swords: [...new Set(out)], dims: [...new Set(dims)] };
    });
    expect(r.swords, 'every sword deals the same damage on the same cooldown with the same reach').toHaveLength(1);
    expect(r.dims).toEqual(['36,48,5']);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
    // sword/skin ids never feed damage or health logic
    expect(src).not.toMatch(/damage[^;\n]*(sword_|skin_)/);
  });
});

const CHARM_COSTS = {
  util_boots: 1, util_coin: 1, util_boots2: 1, util_iron: 1, util_shield: 1, util_regen: 1, util_feather: 1,
  util_range: 2, util_dashi: 2, util_heart: 2, util_ward: 3, util_double: 3, util_minion: 3,
  util_hands: 1, util_stride: 1, util_spring: 1, util_deflect: 1, util_whet: 2, util_cloud: 2, util_hunter: 2, util_hide: 2, util_idol: 2, util_titan: 3
};

test.describe('Charm loadout (WPN-13)', () => {
  test('WPN-13 there are 23 charms; each costs 1-3 charm points', async ({ page }) => {
    const r = await page.evaluate(() => ({
      slots: MQ_CHARM_SLOTS, budget: MQ_CHARM_BUDGET,
      costs: Object.fromEntries(MQ_UTILITY.map((u) => [u.id, u.cost])),
      rarities: MQ_UTILITY.reduce((a, u) => { a[u.rarity] = (a[u.rarity] || 0) + 1; return a; }, {}),
      effects: new Set(MQ_UTILITY.map((u) => u.effect)).size
    }));
    expect(r.slots).toBe(3);
    expect(r.budget).toBe(5);
    expect(r.costs).toEqual(CHARM_COSTS);
    expect(Object.keys(r.costs).length).toBe(23);
    expect(r.effects, 'every charm has its own effect, so none are redundant').toBe(23);
    // the new ones fill every rarity
    ['common', 'uncommon', 'rare', 'epic', 'legendary'].forEach((k) => expect(r.rarities[k], k).toBeGreaterThan(0));
  });

  test('WPN-13 up to three charms can be worn, but their points may not add up to more than 5', async ({ page }) => {
    const r = await page.evaluate(() => {
      ownAll(); mqProfile.equipped.utility = '';
      const eq = (id) => { mqEquipItem(id); return mqProfile.equipped.utility; };
      const out = {};
      out.one = eq('util_boots');
      out.two = eq('util_coin');
      out.three = eq('util_double'); // 1 + 1 + 3 = 5 points, three slots
      out.fourthRefused = eq('util_boots2'); // no free slot
      out.checkSlots = mqCharmEquipCheck(mqProfile.equipped.utility, 'util_boots2');
      out.unequip = eq('util_coin'); // clicking a worn charm takes it off
      out.overBudget = eq('util_ward'); // 1 + 3 + 3 = 7
      out.checkPoints = mqCharmEquipCheck(mqProfile.equipped.utility, 'util_ward');
      out.nearlyOver = eq('util_range'); // 1 + 3 + 2 = 6
      out.fits = eq('util_boots2'); // 1 + 3 + 1 = 5
      out.points = mqCharmPoints(mqProfile.equipped.utility);
      // two big charms never fit together; one big charm plus two small ones does
      mqProfile.equipped.utility = '';
      eq('util_ward'); out.bigPair = eq('util_double');
      out.bigPlusSmall = eq('util_boots') && eq('util_coin');
      out.saved = JSON.parse(localStorage.getItem(MQ_PROFILE_KEY)).equipped.utility;
      // not owned: refused
      mqProfile.equipped.utility = ''; delete mqProfile.owned.util_idol;
      out.unowned = eq('util_idol');
      out.empty = mqCharmEquipCheck('', 'util_boots');
      return out;
    });
    expect(r.one).toBe('util_boots');
    expect(r.two).toBe('util_boots,util_coin');
    expect(r.three).toBe('util_boots,util_coin,util_double');
    expect(r.fourthRefused, 'a fourth charm is refused even when its points would fit').toBe('util_boots,util_coin,util_double');
    expect(r.checkSlots).toEqual({ ok: false, reason: 'slots' });
    expect(r.unequip).toBe('util_boots,util_double');
    expect(r.overBudget, 'a charm whose points do not fit is refused').toBe('util_boots,util_double');
    expect(r.checkPoints).toEqual({ ok: false, reason: 'points', need: 3, left: 1 });
    expect(r.nearlyOver).toBe('util_boots,util_double');
    expect(r.fits).toBe('util_boots,util_double,util_boots2');
    expect(r.points).toBe(5);
    expect(r.bigPair, 'two 3-point charms are 6 points').toBe('util_ward');
    expect(r.bigPlusSmall).toBe('util_ward,util_boots,util_coin');
    expect(r.saved, 'the loadout is saved').toBe('util_ward,util_boots,util_coin');
    expect(r.unowned).toBe('');
    expect(r.empty).toEqual({ ok: true });
  });

  test('WPN-13 a saved loadout is checked on load: only owned charms, three at most, within 5 points; an old single charm still works', async ({ page }) => {
    const r = await page.evaluate(() => {
      const load = (utility, owned) => {
        const o = { skin_classic: 1, sword_training: 1 }; (owned || []).forEach((id) => { o[id] = 1; });
        localStorage.setItem(MQ_PROFILE_KEY, JSON.stringify({ coins: 0, owned: o, equipped: { skin: 'skin_classic', gun: 'sword_training', utility }, stats: {} }));
        return mqLoadProfile().equipped.utility;
      };
      const own = ['util_boots', 'util_coin', 'util_boots2', 'util_iron', 'util_ward', 'util_double'];
      return {
        legacy: load('util_boots', own),
        tooMany: load('util_boots,util_coin,util_boots2,util_iron', own),
        tooCostly: load('util_ward,util_double,util_boots', own), // 3 + 3 refused, then 1 fits
        unowned: load('util_boots,util_heart,util_coin', own),
        junk: load('nope,util_boots,util_boots,,util_coin', own),
        notString: load(['util_boots'], own),
        none: load('', own)
      };
    });
    expect(r.legacy).toBe('util_boots');
    expect(r.tooMany).toBe('util_boots,util_coin,util_boots2');
    expect(r.tooCostly).toBe('util_ward,util_boots');
    expect(r.unowned).toBe('util_boots,util_coin');
    expect(r.junk, 'unknown ids and duplicates are dropped').toBe('util_boots,util_coin');
    expect(r.notString).toBe('');
    expect(r.none).toBe('');
  });

  test('WPN-13 My Items shows the worn charms with their point total, each card shows its cost, and a charm that does not fit says why', async ({ page }) => {
    await page.evaluate(() => { ownAll(); mqProfile.equipped.utility = ''; showSection('shop'); mqOnShopOpen(); mqSetTab('inv'); mqSetFilter('utility'); });
    await expect(page.locator('#loadoutUtility')).toContainText('0 / 5');
    await expect(page.locator('.inv-card', { hasText: 'Warding Sigil' })).toContainText('3 pts');
    await expect(page.locator('.inv-card', { hasText: 'Swift Boots' })).toContainText('1 pt');
    await page.locator('.inv-card', { hasText: 'Warding Sigil' }).getByRole('button', { name: 'Equip' }).click();
    await page.locator('.inv-card', { hasText: 'Swift Boots' }).getByRole('button', { name: 'Equip' }).click();
    await expect(page.locator('#loadoutUtility')).toContainText('4 / 5');
    await expect(page.locator('#loadoutUtility')).toContainText('Warding Sigil');
    await expect(page.locator('#loadoutUtility')).toContainText('Swift Boots');
    // 4 + 2 = 6: refused, with a toast that names the problem
    await page.locator('.inv-card', { hasText: 'Long Reach' }).getByRole('button', { name: 'Equip' }).click();
    await expect(page.locator('#mqToast')).toContainText('charm points');
    expect(await page.evaluate(() => mqProfile.equipped.utility)).toBe('util_ward,util_boots');
    // worn cards are marked and can be taken off again
    await expect(page.locator('.inv-card.equipped')).toHaveCount(2);
    await page.locator('.inv-card', { hasText: 'Swift Boots' }).getByRole('button', { name: 'Unequip' }).click();
    await expect(page.locator('#loadoutUtility')).toContainText('3 / 5');
    // a full set of slots is also explained
    await page.evaluate(() => { mqProfile.equipped.utility = 'util_boots,util_coin,util_boots2'; mqRenderInventory(); });
    await page.locator('.inv-card', { hasText: 'Iron Skin' }).getByRole('button', { name: 'Equip' }).click();
    await expect(page.locator('#mqToast')).toContainText('slots');
  });

  test('WPN-13 the raid uses every worn charm, and the whole loadout is synced to teammates', async ({ page }) => {
    const r = await page.evaluate(async () => {
      ownAll(); mqProfile.equipped.utility = 'util_boots,util_heart,util_feather'; mqSaveProfile();
      await T.setupRaid('grinmaw');
      return {
        local: raidLocal.utility, ids: mqEquippedIds().utility,
        synced: T.me().utility,
        dash: raidDashCooldownFrames(), hearts: raidMaxHealthForLoadout(), hold: raidJumpHoldFrames()
      };
    });
    expect(r.local).toBe('util_boots,util_heart,util_feather');
    expect(r.ids).toBe(r.local);
    expect(r.synced).toBe(r.local);
    expect(r.dash, 'Swift Boots').toBe(135);
    expect(r.hearts, 'Vital Core').toBe(6);
    expect(r.hold, 'Feather Cloak').toBe(Math.round(12 * 1.3)); // RAID_JUMP_HOLD_FRAMES is 12
  });
});

test.describe('Buying items (SHP-10)', () => {
  const PRICES = { common: 400, uncommon: 900, rare: 2200, epic: 5000, legendary: 12000 };

  test('SHP-10 any skin, sword or charm can be bought for coins at a fixed price by rarity - well above what a crate costs', async ({ page }) => {
    const r = await page.evaluate(() => {
      const out = { prices: MQ_BUY_PRICES, byItem: {}, cheapestCrate: {} };
      for (const item of MQ_ITEMS) {
        out.byItem[item.id] = mqItemPrice(item.id);
        const crates = MQ_CRATES.filter((c) => mqCratePool(c).some((e) => e.item.id === item.id)).map((c) => c.price);
        out.cheapestCrate[item.id] = crates.length ? Math.min(...crates) : null;
      }
      out.unknown = mqItemPrice('nope');
      out.rarityOf = Object.fromEntries(MQ_ITEMS.map((i) => [i.id, i.rarity]));
      return out;
    });
    expect(r.prices).toEqual(PRICES);
    expect(r.unknown).toBeNull();
    expect(r.byItem.skin_classic, 'the default skin is never for sale').toBeNull();
    expect(r.byItem.sword_training, 'nor the default sword').toBeNull();
    for (const id of Object.keys(r.byItem)) {
      if (r.byItem[id] === null) continue;
      expect(r.byItem[id], id + ' costs its rarity price').toBe(PRICES[r.rarityOf[id]]);
      if (r.cheapestCrate[id] !== null) expect(r.byItem[id], id + ' costs much more than a crate that can drop it').toBeGreaterThan(r.cheapestCrate[id] * 3);
    }
  });

  test('SHP-10 buying deducts the coins, adds exactly one copy, saves, and refuses when you cannot or need not', async ({ page }) => {
    const r = await page.evaluate(() => {
      const out = {};
      mqProfile.coins = 1000; mqSaveProfile();
      out.broke = mqBuyItem('skin_golden'); // legendary: 12000
      out.brokeCoins = mqProfile.coins; out.brokeOwned = !!mqProfile.owned.skin_golden;
      out.buy = mqBuyItem('util_boots'); // common: 400
      out.coinsAfter = mqProfile.coins; out.owned = mqProfile.owned.util_boots;
      out.again = mqBuyItem('util_boots');
      out.againCoins = mqProfile.coins; out.againOwned = mqProfile.owned.util_boots;
      out.buyDefault = mqBuyItem('skin_classic');
      out.buyUnknown = mqBuyItem('nope');
      out.saved = JSON.parse(localStorage.getItem(MQ_PROFILE_KEY));
      out.cratesStat = mqProfile.stats.crates;
      out.sidebar = document.querySelector('.sidebar-coins .mq-coin-value').textContent;
      // a bought item can be equipped like any other
      mqEquipItem('util_boots');
      out.equipped = mqProfile.equipped.utility;
      return out;
    });
    expect(r.broke).toEqual({ ok: false, reason: 'coins', need: 12000, have: 1000 });
    expect(r.brokeCoins).toBe(1000);
    expect(r.brokeOwned).toBe(false);
    expect(r.buy).toEqual({ ok: true, price: 400 });
    expect(r.coinsAfter).toBe(600);
    expect(r.owned).toBe(1);
    expect(r.again, 'buying what you already have is refused').toEqual({ ok: false, reason: 'owned' });
    expect(r.againCoins).toBe(600);
    expect(r.againOwned).toBe(1);
    expect(r.buyDefault).toEqual({ ok: false, reason: 'unavailable' });
    expect(r.buyUnknown).toEqual({ ok: false, reason: 'unavailable' });
    expect(r.saved.coins).toBe(600);
    expect(r.saved.owned.util_boots).toBe(1);
    expect(r.cratesStat, 'a purchase is not a crate').toBe(0);
    expect(r.sidebar).toBe('600');
    expect(r.equipped).toBe('util_boots');
  });

  test('SHP-10 My Items: every locked card shows its price on a Buy button; clicking it buys, too little coin explains', async ({ page }) => {
    await page.evaluate(() => { mqProfile.coins = 500; mqSaveProfile(); showSection('shop'); mqOnShopOpen(); mqSetTab('inv'); mqSetFilter('utility'); });
    const card = (name) => page.locator('.inv-card', { hasText: name });
    await expect(card('Swift Boots').locator('.inv-buy')).toContainText('400');
    await expect(card('Warding Sigil').locator('.inv-buy')).toContainText('12,000');
    await expect(card('Swift Boots')).not.toContainText('Find in crates');
    // too little: a message, nothing changes
    await card('Warding Sigil').locator('.inv-buy').click();
    await expect(page.locator('#mqToast')).toContainText('coins');
    expect(await page.evaluate(() => [mqProfile.coins, !!mqProfile.owned.util_ward])).toEqual([500, false]);
    // enough: bought, the card unlocks and offers Equip, the balance drops
    await card('Swift Boots').locator('.inv-buy').click();
    expect(await page.evaluate(() => [mqProfile.coins, mqProfile.owned.util_boots])).toEqual([100, 1]);
    await expect(card('Swift Boots')).not.toHaveClass(/locked/);
    await expect(card('Swift Boots').getByRole('button', { name: 'Equip' })).toBeVisible();
    await expect(page.locator('.shop-coins .mq-coin-value')).toHaveText('100');
  });
});

test.describe('Items (spec 10.3)', () => {
  test('ITM-01 14 skins and 5 swords in five rarities, each drawn with animation on the higher tiers', async ({ page }) => {
    const r = await page.evaluate(() => {
      const byRarity = (list) => Object.fromEntries(MQ_RARITY_ORDER.map((k) => [k, list.filter((i) => i.rarity === k).map((i) => i.name)]));
      const draw = (skin, gun, t) => { // gun = the weapon id (always a sword now)
        const c = document.createElement('canvas'); c.width = 160; c.height = 190;
        const ctx = c.getContext('2d');
        ctx.translate(80, 130); ctx.scale(1.2, 1.2);
        drawPlayerCuphead(ctx, -18, -24, 36, 48, 1, 5, 5, false, 0, true, { skin, gun, t, noBar: true, noShadow: true });
        return c;
      };
      const skinHashes = {}, animated = {};
      for (const s of MQ_SKINS) { skinHashes[s.id] = hashCanvas(draw(s.id, 'sword_training', 10)); animated[s.id] = hashCanvas(draw(s.id, 'sword_training', 10)) !== hashCanvas(draw(s.id, 'sword_training', 45)); }
      const ids = MQ_SKINS.map((s) => s.id);
      const errors = [];
      for (const s of MQ_SKINS) for (const g of MQ_SWORDS) { try { draw(s.id, g.id, 5); } catch (e) { errors.push(s.id + '/' + g.id + ': ' + e.message); } }
      const preview = MQ_ITEMS.map((it) => { const c = document.createElement('canvas'); c.width = 150; c.height = 170; mqDrawItemPreview(c, it.id, 20, {}); return [it.id, opaque(c, 0, 0, 150, 170)]; });
      return {
        skins: byRarity(MQ_SKINS), swords: byRarity(MQ_SWORDS), distinctSkins: new Set(Object.values(skinHashes)).size, total: ids.length, errors,
        animatedRare: MQ_SKINS.filter((s) => ['epic', 'legendary'].includes(s.rarity)).map((s) => animated[s.id]),
        emptyPreviews: preview.filter((p) => p[1] < 1500).map((p) => p[0]),
        uniqueIds: new Set(MQ_ITEMS.map((i) => i.id)).size, items: MQ_ITEMS.length
      };
    });
    expect(r.skins).toEqual(SPEC_SKINS);
    expect(r.swords).toEqual(SPEC_SWORDS);
    expect(r.items).toBe(42); // 14 skins + 5 swords + 23 charms
    expect(r.uniqueIds).toBe(42);
    expect(r.distinctSkins, 'every skin looks different').toBe(14);
    expect(r.errors).toEqual([]);
    expect(r.animatedRare, 'epic and legendary skins are animated').toEqual([true, true, true, true]);
    expect(r.emptyPreviews).toEqual([]);
  });

  test('ITM-04 sword skins change the blade colors and share one swing arc with a fading slash trail', async ({ page }) => {
    const r = await page.evaluate(() => {
      const draw = (sword, swing) => { const c = document.createElement('canvas'); c.width = 80; c.height = 100; const ctx = c.getContext('2d'); ctx.translate(40, 70); mqDrawSword(ctx, sword, 0, 0, 1, swing, 5); return hashCanvas(c); };
      return {
        distinctSwords: new Set(MQ_SWORDS.map((s) => draw(s.id, 0))).size,
        idleVsMidSwing: draw('sword_training', 0) !== draw('sword_training', 0.5),
        slashTrailPixels: opaque((() => { const c = document.createElement('canvas'); c.width = 80; c.height = 100; const ctx = c.getContext('2d'); ctx.translate(40, 70); mqDrawSword(ctx, 'sword_training', 0, 0, 1, 0.5, 5); return c; })(), 0, 0, 80, 100),
        noSwingPixels: opaque((() => { const c = document.createElement('canvas'); c.width = 80; c.height = 100; const ctx = c.getContext('2d'); ctx.translate(40, 70); mqDrawSword(ctx, 'sword_training', 0, 0, 1, 0, 5); return c; })(), 0, 0, 80, 100)
      };
    });
    expect(r.distinctSwords, 'every sword has its own colors').toBe(5);
    expect(r.idleVsMidSwing, 'the swing arc animates').toBe(true);
    expect(r.slashTrailPixels).toBeGreaterThan(r.noSwingPixels); // the crescent slash trail only shows mid-swing
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
      mqProfile.coins = 777; mqProfile.owned.skin_ninja = 3; mqProfile.owned.sword_moss = 1;
      mqEquipItem('skin_ninja'); mqEquipItem('sword_moss'); mqSaveProfile();
    });
    await page.reload();
    await page.waitForFunction(() => typeof mqProfile !== 'undefined');
    const r = await page.evaluate(() => ({ coins: mqProfile.coins, ninja: mqProfile.owned.skin_ninja, equipped: mqProfile.equipped, side: document.querySelector('.sidebar-coins .mq-coin-value').textContent, fbCoinWrites: __fb.db.log.filter((l) => /coin|profile/i.test(l.path)).length }));
    expect(r).toEqual({ coins: 777, ninja: 3, equipped: { skin: 'skin_ninja', gun: 'sword_moss', utility: '' }, side: '777', fbCoinWrites: 0 });
  });

  test('GEN-06 a corrupt or tampered save falls back safely', async ({ page }) => {
    const r = await page.evaluate(() => {
      const load = (raw) => { localStorage.setItem(MQ_PROFILE_KEY, raw); return mqLoadProfile(); };
      const bad = load('{not json');
      const junk = load(JSON.stringify({ coins: -50, owned: { skin_golden: 1, made_up_item: 9 }, equipped: { skin: 'skin_wizard', gun: 'sword_frost' }, stats: { crates: 'x' } }));
      // a save from before the guns were removed: its gun ids are dropped, the skin it owned stays
      const legacy = load(JSON.stringify({ coins: 40, owned: { skin_classic: 1, skin_ninja: 2, gun_standard: 1, gun_frost: 1, sword_training: 1 }, equipped: { skin: 'skin_ninja', gun: 'gun_frost', utility: '' }, stats: {} }));
      return { bad, junk, legacy };
    });
    expect(r.bad.coins).toBe(0);
    expect(r.bad.equipped).toEqual({ skin: 'skin_classic', gun: 'sword_training', utility: '' });
    expect(r.junk.coins).toBe(0);
    expect(Object.keys(r.junk.owned).sort()).toEqual(['skin_classic', 'skin_golden', 'sword_training']);
    expect(r.junk.equipped).toEqual({ skin: 'skin_classic', gun: 'sword_training', utility: '' }); // equipped items must be owned
    expect(r.junk.stats.crates).toBe(0);
    // an old save keeps its coins and skins; its guns vanish and it falls back to the default sword
    expect(r.legacy.coins).toBe(40);
    expect(Object.keys(r.legacy.owned).sort()).toEqual(['skin_classic', 'skin_ninja', 'sword_training']);
    expect(r.legacy.equipped).toEqual({ skin: 'skin_ninja', gun: 'sword_training', utility: '' });
  });
});
