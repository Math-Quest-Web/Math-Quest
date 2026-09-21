// Shared Playwright fixture: loads the real index.html with Firebase replaced by an in-memory stub,
// captures uncaught page errors (any error fails the test) and alert() dialogs, and injects window.T.
const fs = require('fs');
const path = require('path');
const { test: base, expect } = require('@playwright/test');

const stubSource = fs.readFileSync(path.join(__dirname, 'firebase-stub.js'), 'utf8');
const helperPath = path.join(__dirname, 'page-helpers.js');

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.dialogs = [];
    page.on('dialog', (d) => { page.dialogs.push(d.message()); d.dismiss(); });

    await page.addInitScript({ content: stubSource });
    // The page auto-runs its own built-in self-test suite 3 s after load; skip it so it cannot
    // mutate state while a test is running (it has its own runner, test.html).
    await page.addInitScript(() => {
      const realSetTimeout = window.setTimeout;
      window.setTimeout = function (fn, ms, ...rest) {
        if (ms === 3000 && typeof fn === 'function' && String(fn).includes('Starting Math Quest Test Suite')) return 0;
        return realSetTimeout.call(this, fn, ms, ...rest);
      };
    });

    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
      if (url.href.includes('/firebasejs/')) return route.fulfill({ contentType: 'application/javascript', body: '' });
      return route.abort(); // fonts etc: never hit the network
    });

    await page.goto('/index.html');
    await page.waitForFunction(() => window.__fb && typeof mqProfile !== 'undefined' && typeof raidG !== 'undefined');
    await page.addScriptTag({ path: helperPath });

    await use(page);

    expect(errors, 'uncaught errors in the page').toEqual([]);
  }
});

module.exports = { test, expect };
