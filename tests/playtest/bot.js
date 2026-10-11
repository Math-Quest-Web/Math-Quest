// Headless "play mode" harness: unlike the Playwright suite (which steps frames by hand via
// window.T and never touches the real UI), this drives the REAL requestAnimationFrame loop and
// sends REAL keydown/keyup events, through the actual lobby -> boss pick -> start raid -> fight
// flow, the way a player would. It is a bug-finding tool, not a pass/fail test: it exits non-zero
// and writes a JSON + screenshots when it notices something that looks broken.
//
// Usage: node tests/playtest/bot.js --boss=grinmaw --difficulty=normal --seconds=50 [--players=2] [--out=dir]
//
// Firebase is replaced by the same in-memory stub the test suite uses (tests/support/firebase-stub.js),
// so this never touches the live project or creates a real lobby.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');
const stubSource = fs.readFileSync(path.join(ROOT, 'tests/support/firebase-stub.js'), 'utf8');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp' };

function parseArgs(argv) {
  const out = {};
  argv.forEach((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Disable the page's own 3s self-test auto-run, same trick tests/support/fixtures.js uses.
function disableSelfTestAutorun() {
  const real = window.setTimeout;
  window.setTimeout = function (fn, ms, ...rest) {
    if (ms === 3000 && typeof fn === 'function' && String(fn).includes('Starting Math Quest Test Suite')) return 0;
    return real.call(this, fn, ms, ...rest);
  };
}

// Each Playwright page is a separate JS realm, so tests/support/firebase-stub.js's in-memory
// database (window.__fb.db) is private per page - fine for the existing single-page suite, but a
// 2nd simulated player in a 2nd page would never see the host's lobby. Rather than touch the
// committed stub (other tests depend on its exact behaviour), bridge every db.write() across same-
// origin pages with BroadcastChannel so several independently-played pages share one logical
// "Firebase", the same way real tabs would sync through the real Realtime Database.
function installMultiplayerBridge(channelName) {
  const bc = new BroadcastChannel(channelName);
  const db = window.__fb.db;
  const origWrite = db.write.bind(db);
  db.write = function (path, value) {
    origWrite(path, value);
    bc.postMessage({ path, value });
  };
  bc.onmessage = (ev) => origWrite(ev.data.path, ev.data.value);
}

async function newPlayer(context, label, { uid, channelName } = {}) {
  // All simulated players must share one browser context (not browser.newPage(), which opens a
  // fresh isolated context per call, like separate incognito windows) - BroadcastChannel is
  // partitioned per context/profile, so the multiplayer bridge above only reaches pages that
  // share one. Viewport is set on the shared context itself, not per page.
  const page = await context.newPage();
  const events = [];
  page.on('pageerror', (e) => events.push({ type: 'pageerror', message: e.message, stack: e.stack, player: label }));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Blocked/aborted network requests (route.abort() below) log as console errors too; that's
    // the harness's own doing, not a game bug, so only real uncaught-looking errors count.
    if (/Failed to load resource/i.test(text)) return;
    events.push({ type: 'console-error', message: text, player: label });
  });
  page.on('dialog', (d) => { events.push({ type: 'dialog', message: d.message(), player: label }); d.dismiss(); });

  // Must run before the stub's signInAnonymously() reads window.__fbUid, so each page gets its
  // own player identity instead of every page colliding on the stub's 'test-uid' default.
  if (uid) await page.addInitScript((u) => { window.__fbUid = u; }, uid);
  await page.addInitScript({ content: stubSource });
  if (channelName) await page.addInitScript(installMultiplayerBridge, channelName);
  await page.addInitScript(disableSelfTestAutorun);

  // The stub replaces Firebase's JS, but index.html still requests the real SDK scripts, fonts,
  // etc; same as tests/support/fixtures.js, never let those actually hit the network.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    if (url.href.includes('/firebasejs/')) return route.fulfill({ contentType: 'application/javascript', body: '' });
    return route.abort();
  });

  return { page, events, label };
}

async function gotoReady(page, port) {
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.__fb && typeof mqProfile !== 'undefined' && typeof raidG !== 'undefined');
}

async function clickRaidNav(page) {
  await page.evaluate(() => document.querySelector('button[onclick*="showSection(\'lobby\'"]').click());
}

async function joinLobbyByCode(page, code) {
  await page.evaluate((id) => { if (typeof joinLobby === 'function') joinLobby(id); }, code);
}

function screenshotter(page, outDir) {
  let n = 0;
  return async (name) => {
    n++;
    const file = path.join(outDir, String(n).padStart(2, '0') + '-' + name + '.png');
    try { await page.screenshot({ path: file }); } catch (e) { /* page may have navigated away */ }
    return file;
  };
}

// --- Bot "play": real keydown/keyup against the real listener, not internal function calls. ---
class Pilot {
  constructor(page) {
    this.page = page;
    this.heldLeft = false;
    this.heldRight = false;
    this.lastSwing = 0;
    this.lastDash = 0;
    this.lastShield = 0;
  }

  async setDir(dir) { // -1 left, 1 right, 0 none
    const wantLeft = dir < 0, wantRight = dir > 0;
    if (wantLeft !== this.heldLeft) { await this.page.keyboard[wantLeft ? 'down' : 'up']('ArrowLeft'); this.heldLeft = wantLeft; }
    if (wantRight !== this.heldRight) { await this.page.keyboard[wantRight ? 'down' : 'up']('ArrowRight'); this.heldRight = wantRight; }
  }

  async tapJump(holdMs) {
    await this.page.keyboard.down('z');
    await this.page.waitForTimeout(holdMs);
    await this.page.keyboard.up('z');
  }

  async swing() { await this.page.keyboard.press('x'); }
  async shield() { await this.page.keyboard.press('Shift'); }
  async dash() { await this.page.keyboard.press('c'); }

  async releaseAll() {
    await this.setDir(0);
    try { await this.page.keyboard.up('z'); } catch (e) {}
  }
}

// One decision tick: look at the synced state and act like a reasonably competent player -
// approach the boss, back off from obvious ground/air danger, swing when close, dash/shield
// now and then. It does not need to be optimal; it needs to exercise real input handling.
async function readState(page) {
  return page.evaluate(() => {
    const me = raidG.players && raidG.players[raidMyId];
    const b = raidG.boss;
    const dangers = [];
    (raidG.hazards || []).forEach((h) => { if (typeof h.x === 'number') dangers.push(h.x); });
    (raidG.projectiles || []).forEach((p) => { if (p && p.isBossProjectile && p.life > 0 && typeof p.x === 'number') dangers.push(p.x); });
    return {
      frame: raidG.frame,
      gameOver: !!raidG.gameOver,
      victory: !!raidG.victory,
      meX: me ? me.x : null,
      meY: me ? me.y : null,
      meHealth: me ? me.health : null,
      meMaxHealth: me ? (me.maxHealth || 5) : null,
      bossX: b ? b.x : null,
      bossHp: b ? b.hp : null,
      bossMaxHp: b ? b.maxHp : null,
      bossState: b && b.anim ? b.anim.state : null,
      bossPhase: b ? b.phase : null,
      dangers,
      hazardCount: (raidG.hazards || []).length,
      projectileCount: (raidG.projectiles || []).length,
      playerCount: raidG.players ? Object.keys(raidG.players).length : 0
    };
  });
}

async function botTick(pilot, state, now) {
  if (state.meX === null || state.bossX === null) return;
  const myCenter = state.meX + 18;
  const nearDanger = state.dangers.some((d) => Math.abs(d - myCenter) < 70);
  let dir = 0;
  if (nearDanger) {
    // Step away from the nearest danger.
    const nearest = state.dangers.reduce((a, b) => (Math.abs(b - myCenter) < Math.abs(a - myCenter) ? b : a), state.dangers[0]);
    dir = myCenter < nearest ? -1 : 1;
  } else if (Math.abs(state.bossX - myCenter) > 130) {
    dir = myCenter < state.bossX ? 1 : -1;
  } else if (Math.abs(state.bossX - myCenter) < 60) {
    dir = myCenter < state.bossX ? -1 : 1; // don't stand right under it
  }
  await pilot.setDir(dir);

  if (nearDanger && now - pilot.lastDash > 1200) { pilot.lastDash = now; await pilot.dash(); }
  else if (!nearDanger && Math.random() < 0.03 && now - pilot.lastDash > 2500) { pilot.lastDash = now; await pilot.dash(); }

  if (nearDanger && Math.random() < 0.4) await pilot.tapJump(90);

  if (!nearDanger && Math.abs(state.bossX - myCenter) < 150 && now - pilot.lastSwing > 420) {
    pilot.lastSwing = now;
    await pilot.swing();
  }

  if (state.meHealth !== null && state.meHealth <= 2 && now - pilot.lastShield > 1500) {
    pilot.lastShield = now;
    await pilot.shield();
  }
}

async function runOnePlayer({ page, events, label }, { boss, difficulty, seconds, outDir, isJoiner, hostCode }) {
  const shot = screenshotter(page, outDir);
  const violations = [];
  const note = (kind, detail) => violations.push({ kind, detail, t: Date.now(), player: label });

  await clickRaidNav(page);
  await shot('lobby-list-' + label);

  if (!isJoiner) {
    await page.fill('#lobbyNameInput', 'Bot Lobby ' + Date.now());
    await page.evaluate(() => document.querySelector('button[onclick="createLobby()"]').click());
    await page.waitForSelector('.boss-pick-card', { timeout: 15000 });
    if (difficulty !== 'normal') {
      await page.click(`.difficulty-btn[data-difficulty="${difficulty}"]`);
    }
    await page.click(`.boss-pick-card[data-boss="${boss}"]`);
    await shot('boss-picked-' + label);
    await page.waitForSelector('#startRaidBtn', { state: 'visible', timeout: 15000 });
  } else {
    await joinLobbyByCode(page, hostCode);
    await page.waitForSelector('#raidWaitingRoom', { timeout: 15000 });
  }

  return { shot, violations, note };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const boss = args.boss || 'grinmaw';
  const difficulty = args.difficulty || 'normal';
  const seconds = Number(args.seconds || 45);
  const numPlayers = Number(args.players || 1);
  const port = Number(args.port || (4300 + Math.floor(Math.random() * 900)));
  const outDir = path.resolve(args.out || path.join(ROOT, 'tests/playtest/runs', `${boss}-${difficulty}-${Date.now()}`));
  fs.mkdirSync(outDir, { recursive: true });

  const server = await startServer(port);
  // This environment pre-installs Chromium at a fixed path rather than the version Playwright's
  // own installer would fetch; point at it directly instead of trying to download a new one.
  const prebuilt = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch(fs.existsSync(prebuilt) ? { executablePath: prebuilt } : {});
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });

  const report = { boss, difficulty, seconds, numPlayers, startedAt: new Date().toISOString(), violations: [], pageErrors: [], outDir };

  try {
    // BroadcastChannel has no replay/history - every page must be loaded and bridged *before* the
    // host writes anything, or a joiner opened later would simply never have seen the lobby exist.
    const channelName = 'mq-playtest-' + port;
    const host = await newPlayer(context, 'host', { uid: 'bot-host', channelName });
    await gotoReady(host.page, port);

    const joinerShells = [];
    for (let i = 1; i < numPlayers; i++) {
      const j = await newPlayer(context, 'p' + i, { uid: 'bot-p' + i, channelName });
      await gotoReady(j.page, port);
      joinerShells.push(j);
    }

    const { shot: hostShot, violations: hostViolations, note: hostNote } = await runOnePlayer(host, { boss, difficulty, seconds, outDir, isJoiner: false });

    const joiners = [];
    if (numPlayers > 1) {
      const code = await host.page.evaluate(() => currentLobbyId);
      for (const j of joinerShells) {
        const r = await runOnePlayer(j, { boss, difficulty, seconds, outDir, isJoiner: true, hostCode: code });
        joiners.push({ ...j, ...r });
      }
    }

    await host.page.click('#startRaidBtn');
    await host.page.waitForFunction(() => document.getElementById('countdownOverlay').style.display === 'none', { timeout: 15000 });
    for (const j of joiners) {
      await j.page.waitForFunction(() => document.getElementById('countdownOverlay').style.display === 'none', { timeout: 15000 }).catch(() => {});
    }
    await hostShot('fight-start');

    const allPilots = [{ page: host.page, pilot: new Pilot(host.page), note: hostNote, label: 'host', shot: hostShot }]
      .concat(joiners.map((j) => ({ page: j.page, pilot: new Pilot(j.page), note: j.note, label: j.label, shot: j.shot })));

    const endAt = Date.now() + seconds * 1000;
    const lastFrame = {};
    const stallSince = {};
    let finished = false;

    while (Date.now() < endAt && !finished) {
      for (const p of allPilots) {
        let state;
        try { state = await readState(p.page); } catch (e) { continue; }

        if (state.meHealth !== null && (state.meHealth < 0 || state.meHealth > state.meMaxHealth || Number.isNaN(state.meHealth))) {
          p.note('health-out-of-range', state);
          await p.shot('bug-health-' + p.label + '-' + state.frame);
        }
        if (state.bossHp !== null && (state.bossHp < 0 || Number.isNaN(state.bossHp) || state.bossHp > state.bossMaxHp)) {
          p.note('boss-hp-out-of-range', state);
          await p.shot('bug-bosshp-' + p.label + '-' + state.frame);
        }
        if (state.bossState === undefined || state.bossState === null) {
          p.note('boss-anim-state-missing', state);
          await p.shot('bug-animstate-' + p.label + '-' + state.frame);
        }

        const key = p.label;
        if (lastFrame[key] === state.frame) {
          stallSince[key] = stallSince[key] || Date.now();
          if (Date.now() - stallSince[key] > 4000) {
            p.note('frame-stalled', state);
            await p.shot('bug-stall-' + p.label + '-' + state.frame);
            stallSince[key] = Date.now();
          }
        } else {
          stallSince[key] = 0;
        }
        lastFrame[key] = state.frame;

        if (state.gameOver || state.victory) {
          await p.shot(state.victory ? 'victory-' + p.label : 'defeat-' + p.label);
          finished = true;
          continue;
        }

        await botTick(p.pilot, state, Date.now());
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    for (const p of allPilots) { try { await p.pilot.releaseAll(); } catch (e) {} }
    await hostShot('end-state');

    report.violations = allPilots.flatMap((p) => []).concat(hostViolations).concat(joiners.flatMap((j) => j.violations));
    report.pageErrors = [].concat(host.events, ...joiners.map((j) => j.events));
    report.outcome = finished ? (allPilots.some(() => true) ? 'ended' : 'timeout') : 'timeout';

    await host.page.close();
    for (const j of joiners) await j.page.close();
  } finally {
    await browser.close();
    server.close();
  }

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  const bugCount = report.violations.length + report.pageErrors.length;
  console.log(`\n=== Playtest: ${boss} / ${difficulty} / ${numPlayers}p / ${seconds}s ===`);
  console.log(`Violations: ${report.violations.length}, page errors: ${report.pageErrors.length}`);
  if (bugCount) {
    console.log('Details:');
    report.violations.forEach((v) => console.log(`  [violation] ${v.kind} @ frame ${v.detail && v.detail.frame} (${v.player})`, JSON.stringify(v.detail)));
    report.pageErrors.forEach((e) => console.log(`  [${e.type}] (${e.player}) ${e.message}`));
  }
  console.log(`Report + screenshots: ${outDir}`);
  process.exit(bugCount ? 1 : 0);
}

main().catch((e) => { console.error('playtest harness crashed:', e); process.exit(2); });
