// The boss-fight review changes: a punish window after the Wyrm's sweep (BOS-22), a hittable Grinmaw while he
// bombards (BOS-20), one move per boss that only appears in phase 3 (BOS-49), and a reward for the first win
// over each boss (RWD-04).
const { test, expect } = require('./support/fixtures');

const RUNS = `
  window.runs = (max, stop) => {
    const out = []; let cur = null;
    for (let i = 0; i < max; i++) {
      T.step(1);
      const s = raidG.boss.anim.state;
      if (!cur || cur[0] !== s) { cur = [s, 0]; out.push(cur); }
      cur[1]++;
      if (stop && stop()) break;
    }
    return out;
  };
`;
async function setup(page, boss) {
  await page.evaluate((b) => T.setupRaid(b), boss);
  await page.evaluate(RUNS);
}
const near = (value, expected, tol = 1) => {
  expect(value).toBeGreaterThanOrEqual(expected - tol);
  expect(value).toBeLessThanOrEqual(expected + tol);
};

test.describe('A punish window after the Wyrm sweeps (BOS-22)', () => {
  test('BOS-22 after its sweep the Wyrm settles to its hover height at the edge and is stunned for 80 frames, then flies back', async ({ page }) => {
    await setup(page, 'wyrm');
    const r = await page.evaluate(() => {
      T.prepBoss('wyrm', 1); T.place(500, 60); raidG.boss.attackTimer = 99999;
      wyrmSweep(raidG.boss); raidG.boss.anim.dir = 1; raidG.boss.anim.startX = 70; raidG.boss.anim.endX = 930;
      let exposedAtDaze = 0, yAtDaze = null, hittable = null;
      const seq = runs(500, () => {
        const a = raidG.boss.anim;
        if (a.state === 'sweepDaze' && a.timer === 30) { exposedAtDaze = raidG.boss.exposed; yAtDaze = Math.round(raidG.boss.y); hittable = !raidBossUntargetable(raidG.boss); }
        return a.state === 'idle';
      });
      return { names: seq.map((q) => q[0]), lens: seq.map((q) => q[1]), exposedAtDaze, yAtDaze, hittable, hover: Math.round(BOSS_HOVER_Y.wyrm), x: Math.round(raidG.boss.x) };
    });
    expect(r.names).toEqual(['sweepAim', 'sweepPass', 'sweepDaze', 'sweepOut', 'idle']);
    near(r.lens[2], 80);
    expect(r.exposedAtDaze, 'stunned (so it takes double damage, BOS-11) while it recovers').toBeGreaterThan(40);
    expect(r.hittable).toBe(true);
    expect(Math.abs(r.yAtDaze - r.hover), 'back down at its hover height, where a jump can reach it').toBeLessThan(25);
  });
});

test.describe('Grinmaw can be hit while he bombards (BOS-20)', () => {
  test('BOS-20 he is untargetable only while he travels (withdraw and advance); while he lobs rubble from the background a jump and an upward swing reach him', async ({ page }) => {
    await setup(page, 'grinmaw');
    const r = await page.evaluate(() => {
      T.prepBoss('grinmaw', 1); T.place(900, 60); raidG.boss.attackTimer = 99999;
      raidG.boss.anim = { state: 'withdraw', timer: 0, homeX: raidG.boss.x, homeY: raidG.boss.y, waves: [25, 120] };
      const out = { travelling: [], hurling: [], reach: null };
      const sw = [];
      for (let f = 0; f < 400; f++) {
        T.step(1);
        const a = raidG.boss.anim, b = raidG.boss;
        if (a.state === 'withdraw' && a.timer === 30) out.travelling.push(raidBossUntargetable(b));
        if (a.state === 'hurl' && a.timer === 40) {
          out.hurling.push(raidBossUntargetable(b));
          // a player at the top of a small hop (body centre 120 px up), directly beneath, swinging up
          const p = { x: b.x - 18, y: 500 - 24 - 120 - 24, facing: 1, swingDir: 'up', utility: '' };
          out.reach = raidSwingHitsBoss(p, b);
          out.scale = b.animScale;
        }
        if (a.state === 'advance' && a.timer === 20) out.travelling.push(raidBossUntargetable(b));
        if (a.state === 'slam') break;
      }
      // and it really takes the damage
      T.prepBoss('grinmaw', 1); const b = raidG.boss; b.anim = { state: 'hurl', timer: 40, waves: [25, 120] }; b.animScale = 0.6; b.animOffsetY = -50;
      T.step(1); raidG.boss.anim = { state: 'hurl', timer: 40, waves: [25, 120] }; raidG.boss.animScale = 0.6;
      const hp0 = raidG.boss.hp;
      raidG.playerProjectiles = [{ x: raidG.boss.x, y: raidG.boss.y, vx: 0, vy: 0, life: 50, damage: 3, r: 6 }];
      T.step(1);
      out.damaged = hp0 - raidG.boss.hp;
      return out;
    });
    expect(r.travelling, 'untargetable while travelling to and from the background').toEqual([true, true]);
    expect(r.hurling, 'targetable while he throws').toEqual([false]);
    expect(r.scale, 'still drawn small, far back').toBeLessThan(0.7);
    expect(r.reach, 'an upward swing from the top of a hop reaches him').toBe(true);
    expect(r.damaged).toBe(3);
  });
});

test.describe('Phase 3 adds a move to every boss (BOS-49)', () => {
  const key = (a) => a.state + ':' + (a.kind || '') + ':' + (a.extra || 0);
  const picks = async (page, boss, phase) => page.evaluate(([b, ph]) => {
    T.seed(5); const set = new Set();
    for (let i = 0; i < 400; i++) { T.prepBoss(b, ph); BOSS_ATTACK_FNS[b](raidG.boss); const a = raidG.boss.anim; set.add(a.state + ':' + (a.kind || '') + ':' + (a.extra || 0)); }
    return [...set].sort();
  }, [boss, phase]);
  const NEW = { grinmaw: 'windup:rage:0', warden: 'raise:cage:0', wyrm: 'coil:storm:0', glutton: 'sink:frenzy:2', bramblehide: 'quillWindup:barrage:0', colossus: 'pulseWindup:melt:0', griffon: 'rainWindup:tempest:0' };
  for (const boss of Object.keys(NEW)) {
    test(`BOS-49 ${boss} gets one move that only appears in phase 3`, async ({ page }) => {
      await setup(page, boss);
      const p2 = await picks(page, boss, 2), p3 = await picks(page, boss, 3);
      expect(p2, 'not there in phase 2').not.toContain(NEW[boss]);
      expect(p3.filter((k) => !p2.includes(k)), 'the only new thing in phase 3').toEqual([NEW[boss]]);
      expect(p2.every((k) => p3.includes(k)), 'and everything from phase 2 is still there').toBe(true);
    });
  }

  test('BOS-49 Grinmaw\'s rage: two slams in a row (a quicker second rise), each with its own pair of shockwaves, each with his body on the floor, stunned after the second', async ({ page }) => {
    await setup(page, 'grinmaw');
    const r = await page.evaluate(() => {
      T.prepBoss('grinmaw', 3); T.place(900); raidG.boss.attackTimer = 99999;
      raidG.boss.anim = { state: 'windup', timer: 0, kind: 'rage', again: 1, len: 44 };
      const bottom = () => Math.max(...raidBossRects(raidG.boss).map((q) => q[3]));
      const waves = []; let lastWaves = 0;
      const seq = runs(600, () => {
        const n = raidG.hazards.filter((h) => h.kind === 'shockwave').length;
        if (n > lastWaves) waves.push(Math.round(bottom()));
        lastWaves = n;
        return raidG.boss.anim.state === 'idle';
      });
      return { names: seq.map((q) => q[0]), lens: seq.map((q) => q[1]), waves };
    });
    expect(r.names).toEqual(['windup', 'slam', 'windup', 'slam', 'dazed', 'settle', 'idle']);
    near(r.lens[0], 44);
    near(r.lens[2], 36);
    expect(r.waves.length, 'two pairs of shockwaves').toBe(2);
    r.waves.forEach((b) => expect(b).toBeGreaterThanOrEqual(475));
  });

  test('BOS-49 the Warden\'s chain cage: four chains marked at once around the nearest player, leaving a safe space where they stand', async ({ page }) => {
    await setup(page, 'warden');
    const r = await page.evaluate(() => {
      T.prepBoss('warden', 3); T.place(500); raidG.boss.attackTimer = 99999;
      wardenChainCage(raidG.boss);
      const chains = raidG.hazards.filter((h) => h.kind === 'chainLash').map((h) => ({ tx: Math.round(h.tx), delay: h.delay }));
      let hurt = 5;
      for (let f = 0; f < 130; f++) { T.place(500, undefined, { health: T.me().health, invincible: 0 }); T.step(1); }
      hurt = T.me().health;
      const out = { chains, stillSafe: hurt };
      raidLocal.health = 5; T.prepBoss('warden', 3); raidG.boss.attackTimer = 99999; wardenChainCage(raidG.boss);
      for (let f = 0; f < 130; f++) { T.place(500 - 110, undefined, { health: T.me().health, invincible: 0 }); T.step(1); }
      out.stepAside = T.me().health;
      return out;
    });
    expect(r.chains.map((c) => c.tx).sort((a, b) => a - b)).toEqual([280, 390, 610, 720]);
    expect(r.chains.map((c) => c.delay).sort((a, b) => a - b)).toEqual([0, 8, 16, 24]);
    expect(r.stillSafe, 'standing still in the middle of the cage is safe').toBe(5);
    expect(r.stepAside, 'running into a chain is not').toBeLessThan(5);
  });

  test('BOS-49 the Wyrm\'s firestorm: after a coil six pillars of flame are marked in a row across the arena and erupt one after another, 74 px of floor between each', async ({ page }) => {
    await setup(page, 'wyrm');
    const r = await page.evaluate(() => {
      T.prepBoss('wyrm', 3); T.place(500, 60); raidG.boss.attackTimer = 99999;
      raidG.boss.anim = { state: 'coil', timer: 0, age: 0, kind: 'storm', shots: [30] };
      T.watch();
      const frames = T.until(() => T.hazardSpawns.length > 0, 80);
      const jets = T.hazardSpawns.map((h) => ({ kind: h.kind, x: Math.round(h.x), delay: h.delay || 0 }));
      const hit = (x, frame) => { T.prepBoss('wyrm', 3); raidLocal.health = 5; raidG.boss.attackTimer = 99999; jets.forEach((j) => raidHazard({ kind: 'pillar', x: j.x, delay: j.delay, life: j.delay + 66 })); for (let f = 0; f < 140; f++) { T.place(x, undefined, { health: T.me().health, invincible: 0 }); T.step(1); } return T.me().health; };
      return { frames, jets, onJet: hit(jets.length ? jets[2].x : 500), between: hit(jets.length ? Math.round((jets[2].x + jets[3].x) / 2) : 500) };
    });
    expect(r.frames).toBe(30);
    expect(r.jets.length).toBe(6);
    expect(r.jets.every((j) => j.kind === 'pillar')).toBe(true);
    expect(r.jets.map((j) => j.delay).sort((a, b) => a - b)).toEqual([0, 14, 28, 42, 56, 70]);
    const xs = r.jets.map((j) => j.x).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(140);
    expect(r.onJet, 'standing in a jet is a hit').toBeLessThan(5);
    expect(r.between, 'the gap between two is safe').toBe(5);
  });

  test('BOS-49 the Glutton\'s frenzy: three chomps in a row at three different spots, stunned only after the last', async ({ page }) => {
    await setup(page, 'glutton');
    const r = await page.evaluate(() => {
      T.prepBoss('glutton', 3); T.place(300);
      raidPlayerRef.child('p2').set(Object.assign({}, T.me(), { x: 760 - 18 }));
      raidG.boss.attackTimer = 99999;
      gluttonStartChomp(raidG.boss, 2); raidG.boss.anim.kind = 'frenzy';
      const bites = []; let last = '';
      for (let f = 0; f < 1100; f++) {
        T.place(960, 60); raidPlayerRef.child('p2').update({ x: 960 - 18, y: 60 });
        T.step(1);
        const st = raidG.boss.anim.state;
        if (st === 'bite' && last !== 'bite') bites.push(Math.round(raidG.boss.x));
        last = st;
        if (st === 'idle') break;
      }
      return { bites };
    });
    expect(r.bites.length).toBe(3);
    expect(Math.abs(r.bites[1] - r.bites[0])).toBeGreaterThan(60);
    expect(Math.abs(r.bites[2] - r.bites[1])).toBeGreaterThan(60);
  });

  test('BOS-49 Bramblehide\'s quill barrage: two fans of quills one after the other, the second shifted 60 px so its gaps are somewhere else', async ({ page }) => {
    await setup(page, 'bramblehide');
    const r = await page.evaluate(() => {
      T.prepBoss('bramblehide', 3); T.place(900, 60); raidG.boss.x = 300; raidG.boss.attackTimer = 99999; T.watch();
      raidG.boss.anim = { state: 'quillWindup', timer: 0, kind: 'barrage', again: 1 };
      const frames = []; let seen = 0;
      for (let f = 1; f <= 140; f++) { T.step(1); if (T.spawns.length > seen) { frames.push(f); seen = T.spawns.length; } }
      const landings = (from, to) => T.spawns.slice(from, to).map((p) => Math.round(raidProjectileLandingX(p))).sort((a, b) => a - b);
      return { frames, n: T.spawns.length, first: landings(0, 7), second: landings(7, 14) };
    });
    expect(r.frames[0]).toBe(34);
    expect(r.n, 'two fans of seven (it is phase 3)').toBe(14);
    expect(r.frames[r.frames.length - 1] - r.frames[0], 'the second a moment after the first').toBeGreaterThan(20);
    expect(r.second[0] - r.first[0], 'shifted').toBeGreaterThanOrEqual(50);
  });

  test('BOS-49 the Colossus\'s meltdown: the overload pulse and a line of tremors marching away from it in both directions', async ({ page }) => {
    await setup(page, 'colossus');
    const r = await page.evaluate(() => {
      T.prepBoss('colossus', 3); T.place(960, 60); raidG.boss.attackTimer = 99999; raidG.boss.x = 500;
      raidG.boss.anim = { state: 'pulseWindup', timer: 0, kind: 'melt' };
      T.until(() => raidG.hazards.length > 0, 80);
      const waves = raidG.hazards.filter((h) => h.kind === 'shockwave').length;
      const tremors = raidG.hazards.filter((h) => h.kind === 'tremor').map((h) => Math.round(h.x)).sort((a, b) => a - b);
      T.prepBoss('colossus', 3); T.place(960, 60); raidG.boss.x = 500; raidG.boss.anim = { state: 'pulseWindup', timer: 0 };
      T.until(() => raidG.hazards.length > 0, 80);
      return { waves, tremors, plainTremors: raidG.hazards.filter((h) => h.kind === 'tremor').length };
    });
    expect(r.waves).toBe(2);
    expect(r.tremors, 'three steps away from the golem each way').toEqual([110, 240, 370, 630, 760, 890]);
    expect(r.plainTremors, 'the ordinary pulse has none').toBe(0);
  });

  test('BOS-49 the Griffon\'s tempest: nine feather columns in two rounds, the second round striking between the first', async ({ page }) => {
    await setup(page, 'griffon');
    const r = await page.evaluate(() => {
      T.prepBoss('griffon', 3); T.place(960, 60); raidG.boss.attackTimer = 99999;
      raidG.boss.anim = { state: 'rainWindup', timer: 0, kind: 'tempest' };
      const frames = T.until(() => raidG.hazards.some((h) => h.kind === 'featherFall'), 100);
      const cols = raidG.hazards.filter((h) => h.kind === 'featherFall').map((h) => ({ x: Math.round(h.x), delay: h.delay }));
      const first = cols.filter((c) => c.delay < 60).map((c) => c.x), second = cols.filter((c) => c.delay >= 60).map((c) => c.x);
      return { frames, n: cols.length, first: first.length, second: second.length };
    });
    expect(r.frames).toBe(40);
    expect(r.n).toBe(9);
    expect(r.first).toBe(5);
    expect(r.second).toBe(4);
  });
});

test.describe('The first win over each boss unlocks a charm (RWD-04)', () => {
  test('RWD-04 each boss has its own first-kill charm; the first win grants it once, later wins do not, and a charm you already own pays its duplicate coins instead', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const map = Object.assign({}, BOSS_FIRST_KILL);
      mqProfile.owned = { skin_classic: 1, sword_training: 1 }; mqProfile.firstKills = {}; mqProfile.coins = 0;
      const first = mqGrantFirstKill('colossus');
      const again = mqGrantFirstKill('colossus');
      const ownedNow = !!mqProfile.owned[map.colossus];
      mqProfile.owned.util_hide = 1; const coins0 = mqProfile.coins;
      const dup = mqGrantFirstKill('grinmaw');
      return {
        map, distinct: new Set(Object.values(map)).size, real: Object.values(map).every((id) => MQ_ITEM_MAP[id] && MQ_ITEM_MAP[id].type === 'utility'),
        first, again, ownedNow, dup, dupCoins: mqProfile.coins - coins0, refund: MQ_RARITY[MQ_ITEM_MAP.util_hide.rarity].refund,
        none: mqGrantFirstKill('not-a-boss')
      };
    });
    expect(Object.keys(r.map).sort()).toEqual(['bramblehide', 'colossus', 'glutton', 'griffon', 'grinmaw', 'warden', 'wyrm']);
    expect(r.distinct, 'a different charm for each boss').toBe(7);
    expect(r.real).toBe(true);
    expect(r.first).toMatchObject({ boss: 'colossus', id: r.map.colossus, dup: false });
    expect(r.again, 'only the first time').toBeNull();
    expect(r.ownedNow).toBe(true);
    expect(r.dup).toMatchObject({ boss: 'grinmaw', id: 'util_hide', dup: true });
    expect(r.dupCoins).toBe(r.refund);
    expect(r.none).toBeNull();
  });

  test('RWD-04 a single-boss victory pays its first-kill charm along with the coins, the gauntlet clear grants every one still missing, and the record survives a reload', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('wyrm');
      mqProfile.owned = { skin_classic: 1, sword_training: 1 }; mqProfile.firstKills = {}; mqProfile.coins = 0;
      currentMode = 'raid'; currentBossType = 'wyrm'; raidLocal.health = 5;
      const win1 = mqAwardRaidVictory();
      const win2 = mqAwardRaidVictory();
      const saved = JSON.parse(localStorage.getItem(MQ_PROFILE_KEY));
      const reloaded = mqLoadProfile();
      currentMode = 'gauntlet'; currentChallenges = [];
      const clear = mqAwardGauntletClear();
      currentMode = 'raid';
      return {
        win1: win1.firstKill, win2: win2.firstKill, savedKills: saved.firstKills, reloadedKills: reloaded.firstKills, wyrmOwned: !!reloaded.owned.util_cloud,
        clearKills: (clear.firstKills || []).map((k) => k.boss).sort(), allKills: Object.keys(mqProfile.firstKills).sort()
      };
    });
    expect(r.win1).toMatchObject({ boss: 'wyrm', id: 'util_cloud', dup: false });
    expect(r.win2, 'not a second time').toBeNull();
    expect(r.savedKills).toEqual({ wyrm: true });
    expect(r.reloadedKills).toEqual({ wyrm: true });
    expect(r.wyrmOwned).toBe(true);
    expect(r.clearKills, 'the gauntlet clear grants the other six').toEqual(['bramblehide', 'colossus', 'glutton', 'griffon', 'grinmaw', 'warden']);
    expect(r.allKills.length).toBe(7);
  });

  test('RWD-04 the victory screen announces the unlocked charm', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('colossus');
      mqProfile.owned = { skin_classic: 1, sword_training: 1 }; mqProfile.firstKills = {}; mqProfile.coins = 0;
      currentMode = 'raid'; currentBossType = 'colossus'; raidLocal.health = 5;
      raidG.victory = true; raidLastReward = mqAwardRaidVictory();
      const seen = []; const real = raidCtx.fillText.bind(raidCtx);
      raidCtx.fillText = (t, ...a) => { seen.push(String(t)); return real(t, ...a); };
      raidDraw(); raidCtx.fillText = real;
      raidG.victory = false; raidLastReward = null;
      return seen.filter((t) => /first victory|unlocked/i.test(t));
    });
    expect(r.length).toBe(1);
    expect(r[0]).toMatch(/Ironclad Colossus/);
    expect(r[0]).toMatch(/Steady Stance/);
  });
});

test.describe('Bosses attack at a slower pace (BOS-05)', () => {
  test('BOS-05 the boss simulation runs at 75% speed in the live game: three updates for every four frames, so every windup, shot and cooldown takes a third longer', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const real = window.raidBossUpdate; let calls = 0; window.raidBossUpdate = () => { calls++; };
      raidBossAcc = 0;
      const ran = []; for (let i = 0; i < 100; i++) ran.push(raidRunBossFrame());
      window.raidBossUpdate = real;
      return { calls, tempo: RAID_BOSS_TEMPO, firstFour: ran.slice(0, 8).map(Number) };
    });
    expect(r.tempo).toBe(0.75);
    expect(r.calls, 'about three in four').toBe(75);
    expect(r.firstFour.reduce((a, b) => a + b, 0), 'never two skipped in a row').toBe(6);
  });
});

test.describe('Attacks do not come from or land on the same spot every time (BOS-50)', () => {
  const spread = (arr) => ({ n: new Set(arr.map((x) => Math.round(x))).size, range: Math.max(...arr) - Math.min(...arr) });

  test('BOS-50 the Wyrm\'s sweep is centred somewhere different each time (the low stretch moves with it), and the Griffon\'s strafe does not always start from the same side', async ({ page }) => {
    await setup(page, 'wyrm');
    const r = await page.evaluate(() => {
      const centres = [], spans = [], lows = [];
      for (let i = 0; i < 40; i++) { T.prepBoss('wyrm', 1); wyrmSweep(raidG.boss); const a = raidG.boss.anim; centres.push((a.startX + a.endX) / 2); spans.push(Math.abs(a.endX - a.startX)); lows.push(a.lowHalf); }
      const inside = centres.every((c, i) => c - spans[i] / 2 >= 40 && c + spans[i] / 2 <= 960);
      const sides = new Set();
      for (let i = 0; i < 40; i++) { T.prepBoss('griffon', 1); T.place(500); griffonStrafeStart(raidG.boss); sides.add(raidG.boss.anim.dir); }
      return { centres, spans, inside, lowOk: lows.every((h, i) => Math.abs(h - 0.2215 * spans[i]) < 3), sides: [...sides].sort() };
    });
    const sp = spread(r.centres);
    expect(sp.n, 'a different centre most times').toBeGreaterThan(15);
    expect(sp.range).toBeGreaterThan(80);
    expect(r.inside, 'always inside the arena').toBe(true);
    expect(Math.min(...r.spans), 'still crosses nearly the whole map').toBeGreaterThanOrEqual(700);
    expect(r.lowOk, 'the marked low stretch is as wide as the real one').toBe(true);
    expect(r.sides, 'the strafe starts from either side when you stand in the middle').toEqual([-1, 1]);
  });

  test('BOS-50 the column and pillar attacks (feather rain, tempest, firestorm, bubble fan) are laid out at a different offset each time, always with gaps to stand in', async ({ page }) => {
    await setup(page, 'griffon');
    const r = await page.evaluate(() => {
      const first = { rain: [], tempest: [], storm: [], fan: [] }, minGap = { rain: 1e9, storm: 1e9, fan: 1e9 };
      const gaps = (xs, key) => { const s = xs.slice().sort((a, b) => a - b); for (let i = 1; i < s.length; i++) minGap[key] = Math.min(minGap[key], s[i] - s[i - 1]); };
      for (let i = 0; i < 40; i++) {
        T.prepBoss('griffon', 2); griffonFeatherRain(raidG.boss);
        let xs = raidG.hazards.filter((h) => h.kind === 'featherFall').map((h) => h.x); first.rain.push(Math.min(...xs)); gaps(xs, 'rain');
        T.prepBoss('griffon', 3); griffonTempest(raidG.boss);
        xs = raidG.hazards.filter((h) => h.kind === 'featherFall' && h.delay < 60).map((h) => h.x); first.tempest.push(Math.min(...xs));
        T.prepBoss('wyrm', 3); wyrmFirestorm(raidG.boss);
        xs = raidG.hazards.filter((h) => h.kind === 'pillar').map((h) => h.x); first.storm.push(Math.min(...xs)); gaps(xs, 'storm');
        T.prepBoss('glutton', 2); T.place(960, 60); gluttonBubbleFan(raidG.boss);
        xs = raidG.projectiles.map((p) => raidProjectileLandingX(p)); first.fan.push(Math.min(...xs)); gaps(xs, 'fan');
      }
      return { first, minGap };
    });
    for (const k of ['rain', 'tempest', 'storm', 'fan']) {
      const sp = spread(r.first[k]);
      expect(sp.n, k + ' starts somewhere different most times').toBeGreaterThan(15);
      expect(sp.range, k).toBeGreaterThan(50);
    }
    expect(r.minGap.rain, 'rain columns stay well apart').toBeGreaterThanOrEqual(110);
    expect(r.minGap.storm, 'so do the firestorm pillars').toBeGreaterThanOrEqual(140);
    expect(r.minGap.fan, 'and the bubbles').toBeGreaterThan(100);
  });

  test('BOS-50 Grinmaw backs away to a different spot of the hall each bombardment and slams down in a different place each time; Bramblehide\'s quill fan opens a different distance away', async ({ page }) => {
    await setup(page, 'grinmaw');
    const r = await page.evaluate(() => {
      const slam = [];
      for (let i = 0; i < 12; i++) {
        let tries = 0;
        do { T.prepBoss('grinmaw', 1); T.place(960, 60); raidG.boss.attackTimer = 99999; BOSS_ATTACK_FNS.grinmaw(raidG.boss); } while (raidG.boss.anim.state !== 'withdraw' && ++tries < 80);
        for (let g = 0; g < 700; g++) { T.step(1); if (raidG.boss.anim.state === 'slam') { slam.push(raidG.boss.x); break; } }
      }
      const picks = [];
      for (let i = 0; i < 40; i++) { T.prepBoss('grinmaw', 1); let a = null; for (let k = 0; k < 50 && !(a && a.state === 'withdraw'); k++) { T.prepBoss('grinmaw', 1); BOSS_ATTACK_FNS.grinmaw(raidG.boss); a = raidG.boss.anim; } picks.push(a.farX); }
      const quill = [];
      for (let i = 0; i < 30; i++) { T.prepBoss('bramblehide', 1); T.place(900, 60); raidG.boss.x = 300; T.watch(); bramblehideQuills(raidG.boss); quill.push(T.spawns.reduce((m, p) => m + raidProjectileLandingX(p), 0) / T.spawns.length); }
      return { slam, picks, quill };
    });
    expect(r.picks.every((x) => x >= 250 && x <= 750), 'the far spot is somewhere in the middle of the hall').toBe(true);
    expect(spread(r.picks).range, 'a different back spot each time').toBeGreaterThan(150);
    expect(spread(r.slam).n, 'he comes forward to a different spot each time').toBeGreaterThan(6);
    expect(spread(r.slam).range).toBeGreaterThan(150);
    expect(spread(r.quill).range, 'the quill fan opens a different distance away').toBeGreaterThan(40);
  });
});

test.describe('Bosses do not fly home between attacks (BOS-51)', () => {
  // Runs one attack, remembers where the boss was at the end of its last "active" state, and where it is when it goes idle.
  const run = (page, boss, phase, start, active) => page.evaluate(([b, ph, startSrc, act]) => {
    T.prepBoss(b, ph); T.place(700, 60); raidG.boss.attackTimer = 99999; raidG.boss.x = 420;
    new Function('b', startSrc)(raidG.boss);
    let lastActiveX = null; const states = new Set(); let idleX = null, steps = 0;
    for (let f = 0; f < 1500; f++) {
      T.place(700, 60); T.step(1); steps++;
      const st = raidG.boss.anim.state; states.add(st);
      if (st === act) lastActiveX = raidG.boss.x;
      if (st === 'idle' && f > 5) { idleX = raidG.boss.x; break; }
    }
    // and it stays put through the rest that follows
    const x0 = raidG.boss.x; let drift = 0;
    for (let f = 0; f < 36; f++) { T.place(700, 60); T.step(1); drift = Math.max(drift, Math.abs(raidG.boss.x - x0)); }
    return { lastActiveX, idleX, drift, states: [...states] };
  }, [boss, phase, start, active]);

  const CASES = [
    ['warden', 1, 'wardenStartVanish(b)', 'dazed', 2],
    ['wyrm', 2, 'wyrmDiveBomb(b)', 'crash', 2],
    ['griffon', 1, 'griffonWindDive(b)', 'thud', 2],
    ['glutton', 1, 'gluttonStartChomp(b)', 'dazed', 2],
    ['bramblehide', 1, 'b.anim = { state: "chargeWindup", timer: 0, dir: 1 }', 'dazed', 2],
    ['wyrm', 1, 'wyrmSweep(b)', 'sweepDaze', 100],
    ['griffon', 1, 'griffonStrafeStart(b)', 'strafe', 100]
  ];
  for (const [boss, phase, start, active, tol] of CASES) {
    test(`BOS-51 ${boss} ends ${start.replace(/\(.*$/, '')} where the action ended, goes idle there and stays put for a while`, async ({ page }) => {
      await setup(page, boss);
      const r = await run(page, boss, phase, start, active);
      expect(r.lastActiveX).not.toBeNull();
      expect(Math.abs(r.idleX - r.lastActiveX), 'no trip back to a home spot').toBeLessThanOrEqual(tol);
      expect(r.idleX, 'and still on screen').toBeGreaterThan(100);
      expect(r.idleX).toBeLessThan(900);
      expect(r.drift, 'it rests before it moves again').toBeLessThan(2);
      expect(r.states, 'Bramblehide no longer trots home').not.toContain('trot');
    });
  }
});
