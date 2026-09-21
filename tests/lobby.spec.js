// Spec section 7: the raid lobby flow (create, boss/difficulty, waiting room, join, leave, cleanup).
const { test, expect } = require('./support/fixtures');

// Create a lobby through the real UI function; optionally force the generated codes.
async function createLobbyViaUi(page, name = 'Test Lobby', randoms = null) {
  return page.evaluate(async ({ name, randoms }) => {
    if (randoms) { const seq = randoms.slice(); const real = Math.random; Math.random = () => (seq.length ? seq.shift() : real()); }
    document.getElementById('lobbyNameInput').value = name;
    await createLobby();
    return currentLobbyId;
  }, { name, randoms });
}

test.describe('Lobby list (LOB-01, LOB-02, LOB-07)', () => {
  test('LOB-01 the list shows boss, difficulty, code, host, status and player count', async ({ page }) => {
    await page.evaluate(async () => {
      await startFirebase();
      await lobbyRef.child('1111').set({ name: 'Alpha', bossType: 'wyrm', difficulty: 'hard', status: 'waiting', playerCount: 2, hostId: 'someone', createdAt: 2 });
      await lobbyRef.child('2222').set({ name: 'Busy', bossType: 'grinmaw', difficulty: 'easy', status: 'playing', playerCount: 3, hostId: 'x', createdAt: 1 });
      await lobbyRef.child('3333').set({ name: 'Packed', bossType: 'glutton', difficulty: 'normal', status: 'waiting', playerCount: 6, hostId: 'x', createdAt: 3 });
      await lobbyRef.child('4444').set({ name: 'Undecided', status: 'waiting', playerCount: 1, hostId: 'x', createdAt: 4 });
      await refreshLobbies();
    });
    const cards = page.locator('.lobby-card');
    await expect(cards).toHaveCount(4);
    const alpha = cards.filter({ hasText: 'Alpha' });
    await expect(alpha).toContainText('Trio, the Three-Headed Wyrm');
    await expect(alpha).toContainText('Hard');
    await expect(alpha).toContainText('Code: 1111');
    await expect(alpha).toContainText('Waiting');
    await expect(alpha).toContainText('2/6');
    await expect(alpha.locator('.join-btn')).toBeEnabled();
    await expect(cards.filter({ hasText: 'Busy' })).toContainText('In Raid');
    await expect(cards.filter({ hasText: 'Busy' }).locator('.join-btn')).toBeDisabled();
    await expect(cards.filter({ hasText: 'Packed' }).locator('.join-btn')).toBeDisabled();
    await expect(cards.filter({ hasText: 'Undecided' })).toContainText('choosing a boss');
  });

  test('LOB-02 creating a lobby makes a unique 4-digit code (never overwrites an existing one)', async ({ page }) => {
    await page.evaluate(async () => {
      await startFirebase();
      await lobbyRef.child('1000').set({ name: 'Existing', status: 'waiting', playerCount: 1, hostId: 'x', createdAt: 1 });
    });
    // first generated code (1000) is taken, the second (5500) is free
    const id = await createLobbyViaUi(page, 'Fresh', [0, 0.5]);
    expect(id).toBe('5500');
    const lobbies = await page.evaluate(() => __fb.db.get('lobbies'));
    expect(Object.keys(lobbies).sort()).toEqual(['1000', '5500']);
    expect(lobbies['1000'].name).toBe('Existing');
    expect(lobbies['5500']).toMatchObject({ name: 'Fresh', status: 'waiting', playerCount: 1, hostId: 'test-uid' });
    expect(Object.keys(lobbies)).toEqual(expect.arrayContaining([expect.stringMatching(/^\d{4}$/)]));
  });

  test('LOB-07 max 6 players; full and in-progress lobbies cannot be joined', async ({ page }) => {
    await page.evaluate(async () => {
      await startFirebase();
      await lobbyRef.child('1111').set({ name: 'Full', bossType: 'grinmaw', status: 'waiting', playerCount: 6, hostId: 'x', createdAt: 1, players: { a: { joinedAt: 1 } } });
      await lobbyRef.child('2222').set({ name: 'Busy', bossType: 'grinmaw', status: 'playing', playerCount: 2, hostId: 'x', createdAt: 1 });
      await lobbyRef.child('3333').set({ name: 'Open', bossType: 'warden', status: 'waiting', playerCount: 2, hostId: 'x', createdAt: 1, players: { a: { joinedAt: 1 }, b: { joinedAt: 1 } } });
    });
    await page.evaluate(() => joinLobby('1111'));
    await page.evaluate(() => joinLobby('2222'));
    expect(page.dialogs.some((d) => /full/i.test(d))).toBe(true);
    expect(page.dialogs.some((d) => /in a raid/i.test(d))).toBe(true);
    expect(await page.evaluate(() => currentLobbyId)).toBeNull();

    await page.evaluate(() => joinLobby('3333'));
    const r = await page.evaluate(() => ({ id: currentLobbyId, count: __fb.db.get('lobbies/3333/playerCount'), joined: !!__fb.db.get('lobbies/3333/players/' + mathQuestUid), boss: currentBossType }));
    expect(r).toEqual({ id: '3333', count: 3, joined: true, boss: 'warden' });
  });
});

test.describe('Boss and difficulty selection, waiting room (LOB-03 to LOB-06, LOB-08)', () => {
  test('LOB-03 after creating, the host picks a boss and a difficulty; others just wait', async ({ page }) => {
    const id = await createLobbyViaUi(page);
    await expect(page.locator('#raidBossChooseStep')).toBeVisible();
    await expect(page.locator('#raidBossPicker .boss-pick-card')).toHaveCount(4);
    await expect(page.locator('.difficulty-btn')).toHaveCount(3);
    await expect(page.locator('.difficulty-btn.selected')).toContainText('Normal');

    await page.locator('.difficulty-btn[data-difficulty="hard"]').click();
    await expect(page.locator('.difficulty-btn.selected')).toContainText('Hard');
    await page.locator('.boss-pick-card[data-boss="glutton"]').click();

    await expect(page.locator('#raidWaitingReady')).toBeVisible();
    await expect(page.locator('#waitingBossName')).toHaveText('The Glutton');
    await expect(page.locator('#waitingDifficultyLabel')).toContainText('Hard');
    const lobby = await page.evaluate((id) => __fb.db.get('lobbies/' + id), id);
    expect(lobby.bossType).toBe('glutton');
    expect(lobby.difficulty).toBe('hard');

    // a non-host in a lobby with no boss yet sees only a waiting message
    await page.evaluate(async () => {
      await lobbyRef.child(currentLobbyId).child('bossType').remove();
      isLobbyHost = false; showRaidBossChooseStep();
    });
    await expect(page.locator('#raidBossChooseNotice')).toBeVisible();
    await expect(page.locator('#raidBossPicker')).toBeHidden();
    await expect(page.locator('#raidDifficultyPicker')).toBeHidden();
  });

  test('LOB-04 only the host sees Start Raid; everyone can leave and sees the players', async ({ page }) => {
    await createLobbyViaUi(page);
    await page.locator('.boss-pick-card[data-boss="warden"]').click();
    await expect(page.locator('#startRaidBtn')).toBeVisible();
    await expect(page.locator('#raidWaitingReady').getByRole('button', { name: /LEAVE LOBBY/ })).toBeVisible();

    await page.evaluate(() => { isLobbyHost = false; showRaidWaitingReady(); renderWaitingPlayerList({ [mathQuestUid]: { joinedAt: 1 }, other: { joinedAt: 2 } }); });
    await expect(page.locator('#startRaidBtn')).toBeHidden();
    await expect(page.locator('#waitingHostNotice')).toBeVisible();
    await expect(page.locator('.waiting-player-chip')).toHaveCount(2);
    await expect(page.locator('.waiting-player-chip').first()).toContainText('You');
    await expect(page.locator('#raidWaitingReady').getByRole('button', { name: /LEAVE LOBBY/ })).toBeVisible();
  });

  test('LOB-05 Start Raid signals everyone: every client switches to the game and counts down', async ({ page }) => {
    // host side: pressing Start writes the signal
    await createLobbyViaUi(page);
    await page.locator('.boss-pick-card[data-boss="grinmaw"]').click();
    await page.locator('#startRaidBtn').click();
    await expect.poll(() => page.evaluate(() => { const l = __fb.db.get('lobbies/' + currentLobbyId); return l.status + ':' + (l.raidStart > 0); })).toBe('playing:true');
    await expect(page.locator('#raidGameWrapper')).toBeVisible();
    expect(await page.evaluate(() => countdownActive)).toBe(true);
    await page.evaluate(() => leaveLobby());

    // non-host side: joining a lobby whose raid has been signalled starts the game and countdown
    await page.evaluate(async () => {
      await lobbyRef.child('7000').set({ name: 'X', hostId: 'someone-else', status: 'playing', playerCount: 2, createdAt: 1, bossType: 'warden', difficulty: 'normal', raidStart: Date.now(), players: { 'someone-else': { joinedAt: 1 }, [mathQuestUid]: { joinedAt: 2 } } });
      enterRaidRoom('7000', 'X', false, 'warden');
    });
    await expect(page.locator('#raidGameWrapper')).toBeVisible();
    await expect(page.locator('#raidWaitingRoom')).toBeHidden();
    expect(await page.evaluate(() => ({ countdown: countdownActive, boss: raidG.boss.type }))).toEqual({ countdown: true, boss: 'warden' });
  });

  test('LOB-06 the raid page has a tutorial that mentions controls but not math or boss weakness', async ({ page }) => {
    await createLobbyViaUi(page);
    const tut = page.locator('details.raid-tutorial');
    await expect(tut).toBeVisible();
    await tut.locator('summary').click();
    await expect(tut).toHaveAttribute('open', '');
    const text = await tut.innerText();
    ['Move', 'Jump', 'Shoot', 'Shield', 'Dash'].forEach((w) => expect(text).toContain(w));
    expect(text).not.toMatch(/math/i);
    expect(text).not.toMatch(/weak|vulnerable|exposed/i);
  });

  test('LOB-08 Start Raid works again for every new lobby in the same page session', async ({ page }) => {
    for (let i = 0; i < 3; i++) {
      await createLobbyViaUi(page, 'Round ' + i);
      await page.locator('.boss-pick-card[data-boss="wyrm"]').click();
      await expect(page.locator('#startRaidBtn')).toBeEnabled();
      await page.locator('#startRaidBtn').click();
      await expect(page.locator('#raidGameWrapper')).toBeVisible();
      await page.evaluate(() => leaveLobby());
      await expect.poll(() => page.evaluate(() => currentLobbyId)).toBeNull();
    }
  });
});

test.describe('Leaving and cleanup (LOB-09 to LOB-11)', () => {
  test('LOB-09 when the last player leaves, the lobby and its raid data are deleted', async ({ page }) => {
    const id = await createLobbyViaUi(page);
    await page.evaluate(async (id) => { await raidDb.ref('bossRaid/' + id + '/gameState').set({ victory: false }); }, id);
    await page.evaluate(() => leaveLobby());
    const r = await page.evaluate((id) => ({ lobby: __fb.db.get('lobbies/' + id), raid: __fb.db.get('bossRaid/' + id) }), id);
    expect(r).toEqual({ lobby: null, raid: null });
  });

  test('LOB-09 empty lobbies are removed together with their raid data by the periodic sweep', async ({ page }) => {
    await page.evaluate(async () => {
      await startFirebase();
      await lobbyRef.child('6001').set({ name: 'Ghost', status: 'waiting', playerCount: 0, createdAt: Date.now() - 60000, hostId: 'x' });
      await raidDb.ref('bossRaid/6001/gameState').set({ victory: false });
    });
    await expect.poll(() => page.evaluate(() => JSON.stringify([__fb.db.get('lobbies/6001'), __fb.db.get('bossRaid/6001')])), { timeout: 8000 }).toBe('[null,null]');
  });

  test('LOB-09 a lobby whose players timed out is deleted with its raid data', async ({ page }) => {
    await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      // setupRaid leaves playerCount at 1; a stale presence entry makes the game drop that player
      await raidDb.ref('bossRaid/9001/presence/p_gone').set(Date.now() - 60000);
    });
    await expect.poll(() => page.evaluate(() => JSON.stringify([__fb.db.get('lobbies/9001'), __fb.db.get('bossRaid/9001')])), { timeout: 12000 }).toBe('[null,null]');
  });

  test('LOB-10 raid data of deleted lobbies is swept once per load; live and unrelated nodes stay', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await startFirebase();
      await lobbyRef.child('2222').set({ name: 'Live', status: 'waiting', playerCount: 1, createdAt: Date.now(), hostId: 'x', players: { x: { joinedAt: 1 } } });
      for (const id of ['1111', '2222', 'global', '-Pabcdefgh']) await raidDb.ref('bossRaid/' + id + '/gameState').set({ victory: false });
      orphanSweepDone = false;
      await sweepOrphanRaidData();
      const after = Object.keys(__fb.db.get('bossRaid') || {}).sort();
      // and it only runs once per page load
      await raidDb.ref('bossRaid/3333/gameState').set({ victory: false });
      await sweepOrphanRaidData();
      return { after, stillThere: !!__fb.db.get('bossRaid/3333') };
    });
    expect(r.after).toEqual(['-Pabcdefgh', '2222', 'global']);
    expect(r.stillThere).toBe(true);
  });

  test('LOB-10 a new lobby never inherits stale raid data left under a reused code', async ({ page }) => {
    await page.evaluate(async () => { await startFirebase(); await raidDb.ref('bossRaid/5500/gameState').set({ victory: true, gameOver: true }); });
    const id = await createLobbyViaUi(page, 'Recycled', [0.5]);
    expect(id).toBe('5500');
    expect(await page.evaluate(() => __fb.db.get('bossRaid/5500'))).toBeNull();
  });

  test('LOB-11 leaving cleans up listeners, timers and the leave button fires once', async ({ page }) => {
    await page.evaluate(async () => { await T.setupRaid('grinmaw'); __fb.db.log.length = 0; });
    await page.evaluate(() => document.getElementById('raidLeaveBtn').click());
    await expect.poll(() => page.evaluate(() => currentLobbyId)).toBeNull();
    const r = await page.evaluate(() => ({
      leaves: __fb.db.log.filter((l) => l.op === 'transaction' && l.path === 'lobbies/9001/playerCount').length,
      presence: raidPresenceInterval, hostCheck: raidHostCheckInterval, shots: raidShotsRef, connected: raidConnectedRef,
      loop: raidLoopRunning, initialized: raidInitialized,
      raidListeners: __fb.db.listeners.filter((l) => l.path.startsWith('bossRaid/9001')).length
    }));
    expect(r).toEqual({ leaves: 1, presence: null, hostCheck: null, shots: null, connected: null, loop: false, initialized: false, raidListeners: 0 });
  });
});
