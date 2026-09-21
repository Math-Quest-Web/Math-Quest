// Spec section 13: how the tests themselves run.
const { test, expect } = require('./support/fixtures');

test('TST-06 the game runs against the in-memory Firebase stub and never contacts the live project', async ({ page }) => {
  const r = await page.evaluate(async () => {
    await startFirebase();
    document.getElementById('lobbyNameInput').value = 'Stubbed';
    await createLobby();
    const stored = __fb.db.get('lobbies');
    const external = performance.getEntriesByType('resource').map((e) => e.name)
      .filter((n) => /firebaseio\.com|firestore\.googleapis|identitytoolkit|securetoken/.test(n));
    return {
      isStub: typeof __fb === 'object' && typeof __fb.db.notify === 'function',
      appsInitialised: firebase.apps.length,
      uid: mathQuestUid,
      lobbyInMemory: Object.values(stored || {}).map((l) => l.name),
      external
    };
  });
  expect(r.isStub).toBe(true);
  expect(r.appsInitialised).toBe(1);
  expect(r.uid).toBe('test-uid');
  expect(r.lobbyInMemory).toEqual(['Stubbed']);
  expect(r.external).toEqual([]);
});

test('TST-06 the stub behaves like Firebase where the game depends on it', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const db = firebase.database();
    const out = {};
    // undefined is rejected, like the real SDK
    try { await db.ref('x').set({ a: undefined }); out.undefinedRejected = false; } catch (e) { out.undefinedRejected = true; }
    // empty objects and arrays are dropped
    await db.ref('y').set({ list: [], obj: {}, keep: 1 });
    out.dropsEmpty = JSON.stringify((await db.ref('y').once('value')).val());
    // local writes notify listeners synchronously
    let seen = null; db.ref('z').on('value', (s) => { seen = s.val(); });
    await Promise.resolve();
    db.ref('z').set(5); out.sync = seen;
    // transactions abort when the callback returns undefined
    const t = await db.ref('z').transaction((cur) => (cur === 5 ? undefined : 1));
    out.abort = t.committed;
    return out;
  });
  expect(r).toEqual({ undefinedRejected: true, dropsEmpty: '{"keep":1}', sync: 5, abort: false });
});
