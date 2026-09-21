// Spec sections 2, 11, 13: hosting/deploy config, database rules and the test setup itself.
// These read files directly; no browser needed.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const json = (f) => JSON.parse(read(f));

test.describe('Architecture and hosting (spec section 2)', () => {
  test('GEN-01 the app is one HTML file plus one image asset (the boss sheet), with no local scripts or stylesheets', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/<img\b/i);
    const imageRefs = [...new Set([...html.matchAll(/assets\/[\w.-]+\.(?:png|jpe?g|gif|webp|svg)/g)].map((m) => m[0]))];
    expect(imageRefs).toEqual(['assets/boss-sheet.webp']);
    const localScripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
    expect(localScripts).toEqual([]);
    const localCss = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
    expect(localCss).toEqual([]);
  });

  test('GEN-02 hosting targets the mathquest site on project mathquest-f54b5', () => {
    const rc = json('.firebaserc');
    expect(rc.projects.default).toBe('mathquest-f54b5');
    expect(rc.targets['mathquest-f54b5'].hosting.mathquest).toEqual(['math-quest-site']);
    expect(json('firebase.json').hosting.target).toBe('mathquest');
    expect(read('_config.yml')).toContain('math-quest-site.web.app');
  });

  test('GEN-03 pushes to main deploy hosting only, via GitHub Actions', () => {
    const wf = read('.github/workflows/firebase-hosting-merge.yml');
    expect(wf).toMatch(/on:\s*\n\s*push:\s*\n\s*branches:\s*\n\s*- main/);
    expect(wf).toContain('FirebaseExtended/action-hosting-deploy');
    expect(wf).toContain('projectId: mathquest-f54b5');
    expect(wf).toContain('target: mathquest');
    expect(wf).toContain('channelId: live');
    expect(wf).not.toMatch(/firebase deploy|--only (firestore|database)/);
  });

  test('GEN-04 index.html is served with no-cache headers', () => {
    const rule = json('firebase.json').hosting.headers.find((h) => h.source === '**');
    const cc = rule.headers.find((h) => h.key === 'Cache-Control');
    expect(cc.value).toBe('no-cache, max-age=0, must-revalidate');
  });

  test('GEN-05 the app uses anonymous auth, Firestore and the Realtime Database', () => {
    const html = read('index.html');
    expect(html).toContain('signInAnonymously');
    expect(html).toContain('firebase.firestore()');
    expect(html).toContain('firebase.database()');
    expect(html).toContain('firebase-database-compat.js');
  });

  test('GEN-08 dev-only files are not published to hosting', () => {
    const ignore = json('firebase.json').hosting.ignore;
    ['tests/**', 'docs/**', 'node_modules/**', 'package.json', 'package-lock.json', 'playwright.config.js', 'CLAUDE.md', 'sprites/**'].forEach((p) => {
      expect(ignore, 'hosting.ignore should contain ' + p).toContain(p);
    });
  });
});

test.describe('Data model (spec section 11)', () => {
  test('DAT-01 realtime database rules require auth for lobby and raid writes', () => {
    const rules = json('database.rules.json').rules;
    expect(rules.lobbies.$lobbyId['.write']).toContain('auth != null');
    expect(rules.bossRaid.$lobbyId['.write']).toContain('auth != null');
    expect(rules['.write']).toBe(false);
    expect(rules['.read']).toBe(false);
  });
});

test.describe('Testing setup (spec section 13)', () => {
  test('TST-01 index.html contains a self-test suite and test.html runs it', () => {
    expect(read('index.html')).toContain('const TestSuite');
    expect(read('test.html')).toContain('Test Suite');
  });

  test('TST-04 a workflow runs the tests on every pull request', () => {
    const wf = read('.github/workflows/tests.yml');
    expect(wf).toMatch(/on:[\s\S]*pull_request/);
    expect(wf).toContain('npm test');
    expect(wf).toMatch(/playwright install/);
    expect(json('package.json').scripts.test).toBe('playwright test');
  });
});
