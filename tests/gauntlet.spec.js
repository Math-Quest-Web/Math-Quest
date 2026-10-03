// Spec 8.6: the Gauntlet (all bosses in a row), its healing tiers, challenges (handicaps) and trophies.
const { test, expect } = require('./support/fixtures');

async function createLobbyViaUi(page, name = 'Gauntlet Lobby') {
  return page.evaluate(async (name) => {
    document.getElementById('lobbyNameInput').value = name;
    await createLobby();
    return currentLobbyId;
  }, name);
}

// Start a gauntlet raid the way the lobby does, with the given difficulty and challenges.
const startGauntlet = (page, difficulty = 'normal', challenges = []) => page.evaluate(async ({ difficulty, challenges }) => {
  currentMode = 'gauntlet'; currentChallenges = challenges;
  await T.setupRaid('grinmaw', difficulty);
  T.prepBoss('grinmaw', 1);
  raidG.boss.maxHp = raidBossMaxHp('grinmaw'); raidG.boss.hp = raidG.boss.maxHp;
  raidG.gauntlet = { stage: 0, rest: 0 };
}, { difficulty, challenges });

// Kill the current boss and let the host process it (one frame).
const killBoss = (page) => page.evaluate(() => { raidG.boss.hp = 0; T.step(1); });

test.describe('Choosing the gauntlet (GAU-01)', () => {
  test('GAU-01 the host can pick the gauntlet with challenges; the lobby stores it and shows it', async ({ page }) => {
    const id = await createLobbyViaUi(page);
    await expect(page.locator('#raidGauntletBtn')).toBeVisible();
    await page.locator('.challenge-btn[data-challenge="nodash"]').click();
    await page.locator('.challenge-btn[data-challenge="titan"]').click();
    await page.locator('.difficulty-btn[data-difficulty="hard"]').click();
    await page.locator('#raidGauntletBtn').click();
    await expect(page.locator('#raidWaitingReady')).toBeVisible();
    await expect(page.locator('#waitingBossName')).toContainText('Gauntlet');
    await expect(page.locator('#waitingDifficultyLabel')).toContainText('Hard');
    await expect(page.locator('#waitingDifficultyLabel')).toContainText('No Dash');
    const lobby = await page.evaluate((id) => __fb.db.get('lobbies/' + id), id);
    expect(lobby).toMatchObject({ mode: 'gauntlet', bossType: 'grinmaw', difficulty: 'hard' });
    expect(Object.values(lobby.challenges).sort()).toEqual(['nodash', 'titan']);
    await page.evaluate(() => refreshLobbies());
    await expect(page.locator('.lobby-card').first()).toContainText('Gauntlet');
  });

  test('GAU-01 picking a single boss still works and clears any gauntlet settings', async ({ page }) => {
    const id = await createLobbyViaUi(page);
    await page.locator('.challenge-btn[data-challenge="nodash"]').click();
    await page.locator('.boss-pick-card[data-boss="wyrm"]').click();
    await expect(page.locator('#waitingBossName')).toContainText('Wyrm');
    const lobby = await page.evaluate((id) => __fb.db.get('lobbies/' + id), id);
    expect(lobby.mode).toBe('boss');
    expect(lobby.challenges || null).toBeNull();
    expect(await page.evaluate(() => currentMode)).toBe('boss');
  });
});

test.describe('Bosses in a row with a rest between (GAU-02, GAU-03)', () => {
  test('GAU-02 beating a boss starts a rest, then the next boss in order; the last one wins the run', async ({ page }) => {
    await startGauntlet(page);
    const r = await page.evaluate(() => {
      const out = { seen: ['grinmaw'], restAfterKill: null, victoryEarly: false, hp: [] };
      for (let stage = 0; stage < 6; stage++) {
        raidG.boss.hp = 0; T.step(1);
        if (stage === 0) out.restAfterKill = raidG.gauntlet.rest;
        out.victoryEarly = out.victoryEarly || raidG.victory;
        T.step(GAUNTLET_REST_FRAMES + 1);
        out.seen.push(raidG.boss.type);
        out.hp.push(raidG.boss.hp === raidG.boss.maxHp && raidG.gauntlet.rest === 0);
      }
      out.stage = raidG.gauntlet.stage;
      raidG.boss.hp = 0; T.step(1);
      out.victory = raidG.victory;
      return out;
    });
    expect(r.seen).toEqual(['grinmaw', 'warden', 'wyrm', 'glutton', 'bramblehide', 'colossus', 'griffon']);
    expect(r.restAfterKill).toBeGreaterThan(200);
    expect(r.victoryEarly).toBe(false);
    expect(r.hp.every(Boolean)).toBe(true);
    expect(r.stage).toBe(6);
    expect(r.victory).toBe(true);
  });

  test('GAU-02 the stage HUD, rest banner and end screens draw without errors', async ({ page }) => {
    await startGauntlet(page, 'normal', ['nodash', 'titan']);
    const r = await page.evaluate(() => {
      raidDraw();                       // fight HUD
      raidG.boss.hp = 0; T.step(1); raidDraw(); // rest banner
      raidG.gauntlet.stage = 6; raidG.gauntlet.rest = 0; raidG.boss.hp = 0; T.step(2); raidDraw(); // clear screen with trophies
      raidG.victory = false; raidG.gameOver = true; raidDraw(); // defeat screen
      return raidG.gauntlet.stage;
    });
    expect(r).toBe(6);
  });

  test('GAU-02 the boss does nothing during the rest', async ({ page }) => {
    await startGauntlet(page);
    const r = await page.evaluate(() => {
      raidG.boss.hp = 0; T.step(1);
      raidG.boss.attackTimer = 0;
      T.step(60);
      return { hazards: raidG.hazards.length, projectiles: raidG.projectiles.length, anim: raidG.boss.anim.state, rest: raidG.gauntlet.rest };
    });
    expect(r).toMatchObject({ hazards: 0, projectiles: 0, anim: 'idle' });
    expect(r.rest).toBeLessThan(await page.evaluate(() => GAUNTLET_REST_FRAMES));
  });

  test('GAU-03 the rest heals by difficulty: Easy full, Normal 3 hearts, Hard 1', async ({ page }) => {
    const out = {};
    for (const d of ['easy', 'normal', 'hard']) {
      await startGauntlet(page, d);
      out[d] = await page.evaluate(() => { raidLocal.health = 1; raidPlayerRef.child(raidMyId).update({ health: 1 }); raidG.boss.hp = 0; T.step(1); return raidLocal.health; });
    }
    expect(out).toEqual({ easy: 5, normal: 4, hard: 2 });
    expect(await page.evaluate(() => [gauntletHealedTo('easy', 2, 5), gauntletHealedTo('normal', 4, 5), gauntletHealedTo('hard', 3, 5), gauntletHealedTo('normal', 0, 7)])).toEqual([5, 5, 4, 3]);
  });

  test('GAU-03 the rest revives a downed player and refills the shield; teammates get a heal event', async ({ page }) => {
    await startGauntlet(page, 'hard');
    await page.evaluate(async () => {
      await raidPlayerRef.child('p_zz_mate').set({ x: 300, y: raidGROUND_Y - 48, health: 0, maxHealth: 5, invincible: 0, shield: false, facing: 1 });
      raidLocal.health = 0; raidMathShieldCharges = 0;
      raidG.players[raidMyId].health = 0;
    });
    const r = await page.evaluate(() => {
      raidG.boss.hp = 0; T.step(1);
      return { health: raidLocal.health, shield: raidMathShieldCharges, gameOver: raidG.gameOver, hits: Object.values(__fb.db.get('bossRaid/9001/hits') || {}) };
    });
    expect(r.health).toBe(1);
    expect(r.shield).toBeGreaterThanOrEqual(2);
    expect(r.hits.filter((h) => h.target === 'p_zz_mate' && h.heal > 0)).toHaveLength(1);
  });
});

test.describe('Challenges (GAU-04)', () => {
  test('GAU-04 there are six handicaps, each with a coin bonus', async ({ page }) => {
    const defs = await page.evaluate(() => CHALLENGE_ORDER.map((id) => ({ id, bonus: CHALLENGE_DEFS[id].bonus, name: CHALLENGE_DEFS[id].name })));
    expect(defs.map((d) => d.id)).toEqual(['fragile', 'noshield', 'nodash', 'frenzy', 'titan', 'nohealing']);
    expect(defs.every((d) => d.bonus > 0 && d.name)).toBe(true);
  });

  test('GAU-04 Fragile caps hearts at 3, No Shield and No Dash disable them', async ({ page }) => {
    await startGauntlet(page, 'normal', ['fragile', 'noshield', 'nodash']);
    const r = await page.evaluate(() => {
      const out = { maxHealth: raidMaxHealthForLoadout() };
      raidG.victory = false; raidG.gameOver = false; raidLocal.health = 3; countdownActive = false;
      raidMathShieldCharges = 2; raidTryShield(); out.shielded = raidLocal.shield; out.charges = raidMathShieldCharges;
      raidLocal.dashCooldown = 0; raidTryDash(); out.dashed = raidLocal.dashTimer > 0;
      return out;
    });
    expect(r).toEqual({ maxHealth: 3, shielded: false, charges: 2, dashed: false });
  });

  test('GAU-04 Frenzy shortens the attack gap and Titan Bosses raises boss HP by half; No Healing skips the heal', async ({ page }) => {
    await startGauntlet(page, 'normal', ['frenzy', 'titan', 'nohealing']);
    const r = await page.evaluate(() => {
      const out = { titanHp: raidBossMaxHp('grinmaw'), frenzy: raidCooldownMult() };
      raidLocal.health = 2; raidPlayerRef.child(raidMyId).update({ health: 2 });
      raidG.boss.hp = 0; T.step(1);
      out.after = raidLocal.health;
      return out;
    });
    expect(r.titanHp).toBe(Math.round(150 * 1.5));
    expect(r.frenzy).toBeCloseTo(0.6, 5);
    expect(r.after).toBe(2);
  });

  test('GAU-04 challenges do nothing outside the gauntlet', async ({ page }) => {
    const r = await page.evaluate(async () => {
      currentMode = 'boss'; currentChallenges = ['fragile', 'titan', 'frenzy'];
      await T.setupRaid('grinmaw', 'normal');
      return { max: raidMaxHealthForLoadout(), hp: raidBossMaxHp('grinmaw'), cd: raidCooldownMult() };
    });
    expect(r).toEqual({ max: 5, hp: 150, cd: 1 });
  });
});

test.describe('Gauntlet rewards and trophies (GAU-05, GAU-06)', () => {
  test('GAU-05 a clear pays 5 fights of coins plus 10 per heart, boosted by each challenge', async ({ page }) => {
    const r = await page.evaluate(() => ({
      easy: gauntletReward('easy', [], 5, 1), normal: gauntletReward('normal', [], 5, 1), hard: gauntletReward('hard', [], 5, 1),
      nodash: gauntletReward('normal', ['nodash'], 5, 1), all: gauntletReward('normal', CHALLENGE_ORDER, 5, 1), charm: gauntletReward('normal', [], 5, 1.1),
      loss: gauntletLossReward('normal', [], 3, 1), lossNone: gauntletLossReward('normal', [], 0, 1)
    }));
    expect(r.easy).toBe(60 * 5 + 50);
    expect(r.normal).toBe(120 * 5 + 50);
    expect(r.hard).toBe(250 * 5 + 50);
    expect(r.nodash).toBe(Math.round(650 * 1.2));
    expect(r.all).toBeGreaterThanOrEqual(1592);
    expect(r.all).toBeLessThanOrEqual(1593);
    expect(r.charm).toBe(Math.round(650 * 1.1));
    expect(r.loss).toBe(Math.round(120 * 0.5 * 3));
    expect(r.lossNone).toBe(0);
  });

  test('GAU-05 winning the gauntlet pays the player once; falling pays for the bosses beaten', async ({ page }) => {
    await startGauntlet(page, 'normal', ['nodash']);
    const win = await page.evaluate(() => {
      const before = mqProfile.coins;
      raidG.gauntlet.stage = 6; raidLocal.health = 4; raidG.boss.hp = 0; T.step(2);
      return { gained: mqProfile.coins - before, expected: gauntletReward('normal', ['nodash'], 4, mqCoinMultiplier(mqProfile.equipped.utility)) };
    });
    expect(win.gained).toBe(win.expected);
    expect(win.gained).toBeGreaterThan(600);

    await startGauntlet(page, 'normal', []);
    const lose = await page.evaluate(() => {
      const before = mqProfile.coins;
      raidG.gauntlet.stage = 2; raidG.gameOver = true; T.step(3);
      const first = mqProfile.coins - before;
      T.step(5);
      return { first, again: mqProfile.coins - before };
    });
    expect(lose).toEqual({ first: 120 * 0.5 * 2, again: 120 * 0.5 * 2 });
  });

  test('GAU-06 a clear earns the difficulty trophy and a trophy per challenge; they are saved and shown', async ({ page }) => {
    expect(await page.evaluate(() => gauntletTrophyIds('hard', ['nodash', 'titan']))).toEqual(['gauntlet_hard', 'challenge_nodash', 'challenge_titan']);
    expect(await page.evaluate(() => gauntletTrophyIds('easy', []))).toEqual(['gauntlet_easy']);
    expect(await page.evaluate(() => gauntletTrophyIds('normal', CHALLENGE_ORDER))).toEqual(['gauntlet_normal', ...['fragile', 'noshield', 'nodash', 'frenzy', 'titan', 'nohealing'].map((c) => 'challenge_' + c), 'challenge_all']);

    await startGauntlet(page, 'hard', ['nodash']);
    await page.evaluate(() => { raidG.gauntlet.stage = 6; raidG.boss.hp = 0; T.step(2); });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(MQ_PROFILE_KEY)).trophies);
    expect(saved).toEqual({ gauntlet_hard: 1, challenge_nodash: 1 });
    await page.evaluate(() => mqSaveProfile());
    await page.reload();
    await page.waitForFunction(() => window.__fb && typeof mqProfile !== 'undefined');
    await page.addScriptTag({ path: require('path').join(__dirname, 'support', 'page-helpers.js') });
    expect(await page.evaluate(() => mqProfile.trophies)).toEqual({ gauntlet_hard: 1, challenge_nodash: 1 });
    await page.evaluate(() => renderTrophyCase());
    await expect(page.locator('#trophyCase .trophy')).toHaveCount(2);
    await expect(page.locator('#trophyCase')).toContainText('Gold Gauntlet');

    // a loss earns none
    await startGauntlet(page, 'easy', ['nodash']);
    await page.evaluate(() => { raidG.gauntlet.stage = 3; raidG.gameOver = true; T.step(2); });
    expect(await page.evaluate(() => Object.keys(mqProfile.trophies).sort())).toEqual(['challenge_nodash', 'gauntlet_hard']);
  });
});
