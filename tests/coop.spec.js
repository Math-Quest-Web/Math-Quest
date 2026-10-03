// Co-op rules: hits on teammates, fighting on after a teammate falls, leaving on exit, fullscreen.
const { test, expect } = require('./support/fixtures');

async function createLobbyViaUi(page, name = 'Test Lobby') {
  return page.evaluate(async (name) => {
    document.getElementById('lobbyNameInput').value = name;
    await createLobby();
    return currentLobbyId;
  }, name);
}

// A second raid player who is "somewhere else" (we only see their synced entry).
const addTeammate = (page, id = 'p_zz_mate', extra = {}) => page.evaluate(async ({ id, extra }) => {
  await raidPlayerRef.child(id).set(Object.assign({ x: 300, y: raidGROUND_Y - 48, health: 5, maxHealth: 5, invincible: 0, shield: false, facing: 1 }, extra));
  return id;
}, { id, extra });

test.describe('Hits on teammates (RAI-25)', () => {
  test('RAI-25 the host delivers a hit on a teammate as a hit event instead of overwriting their health', async ({ page }) => {
    await page.evaluate(() => T.setupRaid('grinmaw'));
    await addTeammate(page);
    const r = await page.evaluate(() => {
      const mate = raidG.players.p_zz_mate;
      raidDamagePlayer('p_zz_mate', mate, 1);
      raidDamagePlayer('p_zz_mate', raidG.players.p_zz_mate, 1); // same frame: must not land twice
      const hits = Object.values(__fb.db.get('bossRaid/9001/hits') || {});
      return { hits, mateHealth: __fb.db.get('bossRaid/9001/players/p_zz_mate/health') };
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ target: 'p_zz_mate', amount: 1 });
    expect(r.mateHealth).toBe(5); // only the teammate's own client changes their health
  });

  test('RAI-25 the hit player applies it once, stays hurt (no instant heal) and the event is consumed', async ({ page }) => {
    await page.evaluate(() => T.setupRaid('grinmaw'));
    const r = await page.evaluate(async () => {
      raidLocal.health = 5; raidLocal.invincible = 0;
      await raidPlayerRef.child(raidMyId).update({ health: 5 });
      await raidRoomRef.child('hits').push({ target: raidMyId, amount: 1, inv: 30, at: Date.now() });
      await raidRoomRef.child('hits').push({ target: 'someone_else', amount: 1, inv: 30, at: Date.now() });
      const afterHit = { health: raidLocal.health, inv: raidLocal.invincible };
      raidSendLocalState(); // the next regular sync must carry the lower health, not overwrite it
      const synced = __fb.db.get('bossRaid/9001/players/' + raidMyId + '/health');
      const left = Object.values(__fb.db.get('bossRaid/9001/hits') || {}).map((h) => h.target);
      return { afterHit, synced, left };
    });
    expect(r.afterHit).toEqual({ health: 4, inv: 30 });
    expect(r.synced).toBe(4);
    expect(r.left).toEqual(['someone_else']);
  });
});

test.describe('Fighting on after a teammate falls (RAI-11, RAI-26)', () => {
  test('RAI-11 the raid is lost only when every player is down, not when one is', async ({ page }) => {
    await page.evaluate(() => T.setupRaid('grinmaw'));
    await addTeammate(page);
    const r = await page.evaluate(() => {
      T.prepBoss('grinmaw', 1);
      const out = {};
      raidLocal.health = 1; raidG.players[raidMyId].health = 1; raidG.players[raidMyId].invincible = 0;
      raidDamagePlayer(raidMyId, raidG.players[raidMyId], 1);
      out.hostDownOnly = raidG.gameOver;
      raidG.players.p_zz_mate.health = 0; // the teammate is down too
      raidDamagePlayer(raidMyId, raidG.players[raidMyId], 1); // already down: ignored
      out.afterIgnored = raidG.gameOver;
      raidCheckAllDown();
      out.allDown = raidG.gameOver;
      return out;
    });
    expect(r).toEqual({ hostDownOnly: false, afterIgnored: false, allDown: true });
  });

  test('RAI-26 a fallen player can no longer act and the boss no longer targets them', async ({ page }) => {
    await page.evaluate(() => T.setupRaid('grinmaw'));
    await addTeammate(page, 'p_zz_mate', { health: 0 });
    const r = await page.evaluate(() => {
      T.prepBoss('grinmaw', 1);
      raidLocal.health = 0; raidLocal.input.right = true; raidLocal.input.left = false;
      const x0 = raidLocal.x;
      raidSwordSwing();
      T.step(10, { local: true });
      const fallen = { moved: raidLocal.x !== x0, swung: raidLocal.swingTimer > 0 };
      // targeting: a downed teammate is never picked, and damage skips them
      raidLocal.health = 5; raidG.players[raidMyId] = Object.assign({}, raidG.players[raidMyId], { health: 5 });
      raidG.players.p_zz_mate.health = 0;
      const picks = new Set();
      for (let i = 0; i < 40; i++) picks.add(raidRandomPlayer().id);
      raidDamagePlayer('p_zz_mate', raidG.players.p_zz_mate, 1);
      return { fallen, picks: [...picks], hits: Object.keys(__fb.db.get('bossRaid/9001/hits') || {}).length };
    });
    expect(r.fallen).toEqual({ moved: false, swung: false });
    expect(r.picks).toEqual([await page.evaluate(() => raidMyId)]);
    expect(r.hits).toBe(0);
  });

  test('RAI-26 the survivors keep playing: the fight is not ended by one player falling', async ({ page }) => {
    await page.evaluate(() => T.setupRaid('grinmaw'));
    await addTeammate(page);
    const r = await page.evaluate(() => {
      T.prepBoss('grinmaw', 1);
      raidG.players.p_zz_mate.health = 0;
      raidCheckAllDown();
      const stillOn = !raidG.gameOver;
      raidLocal.input.right = true;
      const x0 = raidLocal.x;
      T.step(10, { local: true });
      return { stillOn, moved: raidLocal.x > x0 };
    });
    expect(r).toEqual({ stillOn: true, moved: true });
  });
});

test.describe('Leaving on exit (LOB-12)', () => {
  test('LOB-12 clicking a sidebar button leaves the lobby and deletes it when it was the last player', async ({ page }) => {
    const id = await createLobbyViaUi(page);
    await page.locator('.nav-button', { hasText: 'Shop' }).click();
    await expect.poll(() => page.evaluate(() => currentLobbyId)).toBeNull();
    await expect.poll(() => page.evaluate((id) => JSON.stringify([__fb.db.get('lobbies/' + id), __fb.db.get('bossRaid/' + id)]), id)).toBe('[null,null]');
    await expect(page.locator('#shop')).toHaveClass(/active/); // we stay where the click took us
  });

  test('LOB-12 every sidebar button does it, including Raid and Play', async ({ page }) => {
    for (const label of ['Raid', 'Play', 'Home']) {
      const id = await createLobbyViaUi(page, 'L ' + label);
      await page.locator('.nav-button', { hasText: label }).click();
      await expect.poll(() => page.evaluate(() => currentLobbyId), label).toBeNull();
      await expect.poll(() => page.evaluate((id) => __fb.db.get('lobbies/' + id), id), label).toBeNull();
    }
  });

  test('LOB-12 closing the tab leaves the lobby too (deleted when it was the last player)', async ({ page }) => {
    const id = await createLobbyViaUi(page);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect.poll(() => page.evaluate((id) => JSON.stringify([__fb.db.get('lobbies/' + id), __fb.db.get('bossRaid/' + id)]), id)).toBe('[null,null]');
  });

  test('LOB-12 with teammates still in the lobby, leaving only removes you', async ({ page }) => {
    const id = await createLobbyViaUi(page);
    await page.evaluate(async (id) => {
      await lobbyRef.child(id).child('players/other').set({ joinedAt: 1 });
      await lobbyRef.child(id).child('playerCount').set(2);
    }, id);
    await page.locator('.nav-button', { hasText: 'Design' }).click();
    await expect.poll(() => page.evaluate(() => currentLobbyId)).toBeNull();
    const lobby = await page.evaluate((id) => __fb.db.get('lobbies/' + id), id);
    expect(lobby.playerCount).toBe(1);
    expect(Object.keys(lobby.players)).toEqual(['other']);
    expect(lobby.hostId).toBe('other');
  });
});

test.describe('Fullscreen battle (RAI-27)', () => {
  test('RAI-27 the battle fills the whole window, hides the sidebar, and it ends when leaving', async ({ page }) => {
    await createLobbyViaUi(page);
    await page.locator('.boss-pick-card[data-boss="wyrm"]').click();
    await page.locator('#startRaidBtn').click();
    await expect(page.locator('#raidGameWrapper')).toBeVisible();
    const vp = page.viewportSize();
    const box = await page.locator('#raidGameWrapper').boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0 });
    expect(Math.round(box.width)).toBe(vp.width);
    expect(Math.round(box.height)).toBe(vp.height);
    await expect(page.locator('#sidebar').first()).toBeHidden();
    const canvas = await page.locator('#raidCanvas').boundingBox();
    expect(canvas.width).toBeGreaterThan(vp.width * 0.6);
    expect(canvas.x + canvas.width).toBeLessThanOrEqual(vp.width + 1);
    expect(canvas.y + canvas.height).toBeLessThanOrEqual(vp.height + 1);
    await expect(page.locator('#raidLeaveBtn')).toBeVisible();

    await page.locator('#raidLeaveBtn').click();
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('raid-fs'))).toBe(false);
    await expect(page.locator('#sidebar').first()).toBeVisible();
  });
  test('RAI-27 Esc (or the browser leaving real fullscreen) returns to the normal layout, and the sidebar buttons work again', async ({ page }) => {
    await createLobbyViaUi(page);
    await page.locator('.boss-pick-card[data-boss="wyrm"]').click();
    await page.locator('#startRaidBtn').click();
    await expect(page.locator('#raidGameWrapper')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#sidebar')).toBeVisible();
    expect(await page.evaluate(() => document.body.classList.contains('raid-fs'))).toBe(false);
    expect(await page.evaluate(() => currentLobbyId)).not.toBeNull(); // still in the raid
    await page.locator('.nav-button', { hasText: 'Shop' }).click();
    await expect.poll(() => page.evaluate(() => currentLobbyId)).toBeNull();

    // the browser's own fullscreen exit (its Esc is swallowed by the browser) does the same
    await createLobbyViaUi(page, 'Again');
    await page.locator('.boss-pick-card[data-boss="wyrm"]').click();
    await page.locator('#startRaidBtn').click();
    await expect(page.locator('#sidebar')).toBeHidden();
    await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); else document.dispatchEvent(new Event('fullscreenchange')); });
    await expect(page.locator('#sidebar')).toBeVisible();
  });
});
