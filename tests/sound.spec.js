// Spec section 8.6: sound effects. Everything is synthesized with Web Audio, so the tests render each
// sound offline and check the real samples, then drive the game and check which sounds it asks for
// (MQ_SFX.recording logs every play request, whether or not audio is unlocked or muted).
const { test, expect } = require('./support/fixtures');

const BOSSES = ['grinmaw', 'warden', 'wyrm', 'glutton', 'bramblehide', 'colossus', 'griffon'];

// The sounds the game must have, by group (a missing one is a missing sound).
const COMBAT = ['swing_training', 'swing_moss', 'swing_frost', 'swing_void', 'swing_dawn', 'hit_boss', 'hit_boss_heavy', 'hit_blocked', 'parry', 'pogo', 'hurt',
  'shield_on', 'shield_off', 'ward_block', 'minion_shot', 'boss_stunned', 'dash', 'jump', 'double_jump', 'land', 'phase_change', 'boss_defeated', 'victory', 'game_over',
  'countdown_tick', 'countdown_go'];
const BOSS_ATTACK = ['windup_growl', 'windup_screech', 'windup_charge', 'windup_snort', 'boss_slam', 'boss_swoosh', 'boss_roar', 'boss_vanish', 'boss_appear', 'boss_swim',
  'boss_splash', 'boss_bite', 'boss_inflate', 'boss_deflate', 'boss_charge', 'shot_candy', 'shot_fang', 'shot_ember', 'shot_bubble', 'shot_pod', 'shot_bolt', 'shot_plume',
  'shot_feather', 'shot_void', 'shot_boulder', 'hz_warn', 'hz_shockwave', 'hz_thorn_erupt', 'hz_pillar', 'hz_quake', 'hz_tremor', 'hz_feather_strike', 'hz_chain',
  'hz_orb_charge', 'hz_orb_burst', 'hz_imp'];
const UI = ['ui_click', 'ui_equip', 'ui_unequip', 'ui_error', 'ui_buy', 'coins', 'crate_shake', 'crate_open', 'reveal_common', 'reveal_uncommon', 'reveal_rare', 'reveal_epic',
  'reveal_legendary', 'dup_coins', 'answer_correct', 'answer_wrong'];

test.describe('Sound engine (SND-01, SND-02)', () => {
  test('SND-01 every sound is synthesized (no audio files) and renders audible, bounded audio', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const out = { names: MQ_SFX.names(), stats: {} };
      for (const name of out.names) {
        const { data, rate } = await MQ_SFX.render(name);
        let peak = 0, sumSq = 0, last = 0, nan = false;
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          if (!isFinite(v)) nan = true;
          peak = Math.max(peak, Math.abs(v)); sumSq += v * v;
          if (Math.abs(v) > 0.01) last = i;
        }
        out.stats[name] = { peak, rms: Math.sqrt(sumSq / data.length), lastAudible: last / rate, dur: MQ_SFX_DEFS[name].dur, nan };
      }
      return out;
    });
    const required = [...COMBAT, ...BOSS_ATTACK, ...UI];
    for (const n of required) expect(r.names, 'sound ' + n + ' exists').toContain(n);
    expect(r.names.length, 'no stray sounds nobody asked for').toBe(required.length);
    for (const n of r.names) {
      const s = r.stats[n];
      expect.soft(s.nan, n + ' has no NaN samples').toBe(false);
      expect.soft(s.peak, n + ' is audible').toBeGreaterThan(0.04);
      expect.soft(s.peak, n + ' does not clip').toBeLessThanOrEqual(1.3);
      expect.soft(s.rms, n + ' has real energy').toBeGreaterThan(0.004);
      expect.soft(s.lastAudible, n + ' ends within its stated length').toBeLessThanOrEqual(s.dur + 0.12);
      expect.soft(s.lastAudible, n + ' is not silent for most of its stated length').toBeGreaterThan(s.dur * 0.25);
    }
    // the source holds no audio files or data URIs
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
    expect(src).not.toMatch(/\.(mp3|ogg|wav|m4a)\b/i);
    expect(src).not.toMatch(/data:audio/i);
  });

  test('SND-01 sounds that must differ do: the five sword swings, the five crate reveals, and heavy hits are bigger', async ({ page }) => {
    const r = await page.evaluate(async () => {
      // a coarse fingerprint: loudness over time (12 slices) and how fast the waveform wiggles (brightness)
      const feat = async (name) => {
        const { data } = await MQ_SFX.render(name);
        const n = 12, slice = Math.floor(data.length / n), env = [];
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
        for (let k = 0; k < n; k++) { let s = 0; for (let i = k * slice; i < (k + 1) * slice; i++) s += data[i] * data[i]; env.push(Math.sqrt(s / slice) / (peak || 1)); }
        let zc = 0; for (let i = 1; i < data.length; i++) if ((data[i] >= 0) !== (data[i - 1] >= 0)) zc++;
        let energy = 0; for (let i = 0; i < data.length; i++) energy += data[i] * data[i];
        return { env, zcr: zc / data.length, energy, len: MQ_SFX_DEFS[name].dur };
      };
      const dist = (a, b) => Math.sqrt(a.env.reduce((s, v, i) => s + (v - b.env[i]) ** 2, 0) + (((a.zcr - b.zcr) * 6) ** 2));
      const swings = ['swing_training', 'swing_moss', 'swing_frost', 'swing_void', 'swing_dawn'];
      const sf = {}; for (const n of swings) sf[n] = await feat(n);
      const pairs = [];
      for (let i = 0; i < swings.length; i++) for (let j = i + 1; j < swings.length; j++) pairs.push([swings[i], swings[j], dist(sf[swings[i]], sf[swings[j]])]);
      const reveals = ['reveal_common', 'reveal_uncommon', 'reveal_rare', 'reveal_epic', 'reveal_legendary'];
      const rf = []; for (const n of reveals) rf.push(await feat(n));
      const normal = await feat('hit_boss'), heavy = await feat('hit_boss_heavy');
      return { pairs, revealLens: rf.map((f) => f.len), revealEnergy: rf.map((f) => f.energy), normalEnergy: normal.energy, heavyEnergy: heavy.energy, normalLen: normal.len, heavyLen: heavy.len };
    });
    for (const [a, b, d] of r.pairs) expect(d, a + ' and ' + b + ' sound different').toBeGreaterThan(0.12);
    for (let i = 1; i < 5; i++) {
      expect(r.revealLens[i], 'a rarer reveal lasts longer').toBeGreaterThan(r.revealLens[i - 1]);
      expect(r.revealEnergy[i], 'and has more in it').toBeGreaterThan(r.revealEnergy[i - 1]);
    }
    expect(r.heavyEnergy, 'a heavy hit is bigger than a normal one').toBeGreaterThan(r.normalEnergy * 1.5);
    expect(r.heavyLen).toBeGreaterThan(r.normalLen);
  });

  test('SND-02 audio waits for the first click or key press, then plays; muted, unknown and too-quick requests do not', async ({ page }) => {
    const before = await page.evaluate(() => ({ ctx: MQ_SFX.ctx, played: MQ_SFX.play('jump') }));
    expect(before.ctx, 'no audio context before a user gesture').toBeNull();
    expect(before.played, 'nothing plays while audio is locked').toBe(false);
    await page.keyboard.press('Shift');
    const r = await page.evaluate(() => {
      const out = {};
      out.unlocked = !!MQ_SFX.ctx;
      out.first = MQ_SFX.play('jump');
      out.tooQuick = MQ_SFX.play('jump'); // inside the sound's own minimum gap
      out.unknown = MQ_SFX.play('no_such_sound');
      MQ_SFX.setMuted(true);
      out.muted = MQ_SFX.play('land');
      MQ_SFX.recording = true; MQ_SFX.log.length = 0;
      MQ_SFX.play('dash'); MQ_SFX.play('no_such_sound');
      out.logWhileMuted = MQ_SFX.log.slice();
      MQ_SFX.setMuted(false); MQ_SFX.setVolume(0);
      out.silentVolume = MQ_SFX.play('hurt');
      MQ_SFX.setVolume(0.6);
      out.afterUnmute = MQ_SFX.play('hurt');
      out.pan = MQ_SFX.play('minion_shot', { pan: -0.5, vol: 0.5, pitch: 1.2 });
      return out;
    });
    expect(r.unlocked).toBe(true);
    expect(r.first).toBe(true);
    expect(r.tooQuick).toBe(false);
    expect(r.unknown).toBe(false);
    expect(r.muted).toBe(false);
    expect(r.logWhileMuted, 'requests are still logged for the tests, but unknown names are not').toEqual(['dash']);
    expect(r.silentVolume).toBe(false);
    expect(r.afterUnmute).toBe(true);
    expect(r.pan, 'pan, volume and pitch options are accepted').toBe(true);
  });

  test('SND-02 the sound button mutes and sets the volume, and the choice is remembered', async ({ page }) => {
    await expect(page.locator('#mqSoundBtn')).toBeVisible();
    expect(await page.evaluate(() => [MQ_SFX.muted, MQ_SFX.volume])).toEqual([false, 0.6]);
    await page.locator('#mqSoundBtn').click();
    await expect(page.locator('#mqSoundPanel')).toBeVisible();
    await page.locator('#mqSoundMute').check();
    await expect(page.locator('#mqSoundBtn')).toHaveText('🔇');
    await page.locator('#mqSoundVol').fill('30');
    expect(await page.evaluate(() => [MQ_SFX.muted, MQ_SFX.volume])).toEqual([true, 0.3]);
    // it survives a reload
    await page.reload();
    await page.waitForFunction(() => typeof MQ_SFX !== 'undefined');
    expect(await page.evaluate(() => [MQ_SFX.muted, MQ_SFX.volume])).toEqual([true, 0.3]);
    await expect(page.locator('#mqSoundBtn')).toHaveText('🔇');
    // clamped and tamper-proof
    const r = await page.evaluate(() => {
      MQ_SFX.setVolume(5); const hi = MQ_SFX.volume; MQ_SFX.setVolume(-2); const lo = MQ_SFX.volume; MQ_SFX.setVolume('x'); const bad = MQ_SFX.volume;
      localStorage.setItem('mathquest_sound_v1', '{nonsense'); MQ_SFX.load();
      return { hi, lo, bad, afterCorrupt: [MQ_SFX.muted, MQ_SFX.volume] };
    });
    expect(r.hi).toBe(1); expect(r.lo).toBe(0); expect(r.bad).toBe(0);
    expect(r.afterCorrupt, 'a corrupt saved setting leaves the settings as they were').toEqual([true, 0]);
  });
});

test.describe('Combat sounds (SND-03)', () => {
  test('SND-03 every sword has its own swing sound, for your swing and for teammates (panned)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      MQ_SFX.recording = true;
      const out = { mine: {}, theirs: {} };
      for (const sword of ['sword_training', 'sword_moss', 'sword_frost', 'sword_void', 'sword_dawn']) {
        MQ_SFX.log.length = 0;
        raidLocal.gun = sword; raidLocal.swordCooldown = 0; raidSwordSwing();
        out.mine[sword] = MQ_SFX.log.slice();
      }
      // a teammate's swing, seen as their synced swing timer jumping up
      raidSfxReset();
      raidG.players.mate = { x: 150, y: 452, facing: 1, health: 5, maxHealth: 5, skin: 'skin_classic', gun: 'sword_frost', swingTimer: 0, swingDir: 'right', onGround: true };
      raidSfxTick();
      MQ_SFX.log.length = 0;
      raidG.players.mate.swingTimer = 13; raidSfxTick();
      out.theirs.log = MQ_SFX.log.slice(); out.theirs.pan = MQ_SFX.lastOpts && MQ_SFX.lastOpts.pan;
      raidG.players.mate.swingTimer = 8; MQ_SFX.log.length = 0; raidSfxTick();
      out.theirs.sameSwingAgain = MQ_SFX.log.slice();
      raidG.players.mate.swingTimer = 0; raidSfxTick(); raidG.players.mate.swingTimer = 13; MQ_SFX.log.length = 0; raidSfxTick();
      out.theirs.nextSwing = MQ_SFX.log.slice();
      return out;
    });
    expect(r.mine).toEqual({
      sword_training: ['swing_training'], sword_moss: ['swing_moss'], sword_frost: ['swing_frost'], sword_void: ['swing_void'], sword_dawn: ['swing_dawn']
    });
    expect(r.theirs.log).toEqual(['swing_frost']);
    expect(r.theirs.pan, 'a teammate on the left is heard on the left').toBeLessThan(-0.2);
    expect(r.theirs.sameSwingAgain, 'one sound per swing, not one per update').toEqual([]);
    expect(r.theirs.nextSwing).toEqual(['swing_frost']);
  });

  test('SND-03 hitting the boss: a normal hit, a heavy hit (big damage or a stunned boss), a blocked hit, a parry and a pogo', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      raidSfxReset(); raidSfxTick();
      MQ_SFX.recording = true;
      const out = {};
      const drop = (n) => { MQ_SFX.log.length = 0; raidG.boss.hp -= n; raidSfxTick(); return MQ_SFX.log.slice(); };
      out.normal = drop(4);
      out.heavy = drop(8);
      raidG.boss.hp += 20; raidSfxTick(); // healing is silent
      MQ_SFX.log.length = 0; raidSfxTick(); out.quiet = MQ_SFX.log.slice();
      MQ_SFX.log.length = 0;
      raidG.slamAnimations = [{ x: 500, y: 300, life: 10, phase: 'blocked', timer: 0 }]; raidSfxTick(); out.blocked = MQ_SFX.log.slice();
      MQ_SFX.log.length = 0; raidSfxTick(); out.blockedAgain = MQ_SFX.log.slice(); // the same spark is not heard twice
      MQ_SFX.log.length = 0;
      raidG.slamAnimations = [{ x: 600, y: 330, life: 10, phase: 'parry', timer: 0, dir: 'right' }]; raidSfxTick(); out.parry = MQ_SFX.log.slice();
      // pogo: an airborne down swing that touches the boss
      T.place(500, 200); raidLocal.onGround = false; raidLocal.vy = 4; raidLocal.swordCooldown = 0;
      raidLocal.input = { left: false, right: false, up: false, down: true, space: false };
      raidSwordSwing(); raidLocal.input.down = false;
      const spot = T.slashPoint(raidLocal, 8);
      raidG.boss.x = spot.x; raidG.boss.y = spot.y;
      raidPogoState = { lastSwingTimer: 0, bounced: false };
      MQ_SFX.log.length = 0;
      for (let i = 0; i < RAID_SWORD_SWING_FRAMES; i++) { if (raidLocal.swingTimer > 0) raidLocal.swingTimer--; raidCheckLocalPogo(); }
      out.pogo = MQ_SFX.log.slice();
      return out;
    });
    expect(r.normal).toEqual(['hit_boss']);
    expect(r.heavy).toEqual(['hit_boss_heavy']);
    expect(r.quiet).toEqual([]);
    expect(r.blocked).toEqual(['hit_blocked']);
    expect(r.blockedAgain).toEqual([]);
    expect(r.parry).toEqual(['parry']);
    expect(r.pogo).toEqual(['pogo']);
  });

  test('SND-03 taking damage, the Warding Sigil, dashing, jumping, landing and the shield each have a sound', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1); T.place(500);
      raidSfxReset(); raidSfxTick();
      MQ_SFX.recording = true;
      const out = {};
      MQ_SFX.log.length = 0; raidLocal.health -= 1; raidSfxTick(); out.hurt = MQ_SFX.log.slice();
      MQ_SFX.log.length = 0; raidG.players[raidMyId].wardUsed = true; raidSfxTick(); out.ward = MQ_SFX.log.slice();
      MQ_SFX.log.length = 0; raidLocal.dashCooldown = 0; raidTryDash(); out.dash = MQ_SFX.log.slice();
      // a ground jump
      T.place(500); raidLocal.onGround = true; raidLocal.vy = 0; raidLocal.dashTimer = 0; raidLocal.wasJumpPressed = false;
      raidLocal.input = { left: false, right: false, up: false, down: false, jump: true, space: false };
      MQ_SFX.log.length = 0; raidUpdateLocal(); out.jump = MQ_SFX.log.slice();
      // then it falls back down and lands
      raidLocal.input.jump = false;
      MQ_SFX.log.length = 0;
      for (let i = 0; i < 120; i++) raidUpdateLocal();
      out.land = MQ_SFX.log.slice();
      // a double jump with Second Wind
      raidLocal.utility = 'util_double';
      T.place(500, 300); raidLocal.onGround = false; raidLocal.vy = 0; raidLocal.airJumpsUsed = 0; raidLocal.wasJumpPressed = false; raidLocal.dashTimer = 0;
      raidLocal.input.jump = true; MQ_SFX.log.length = 0; raidUpdateLocal(); out.double = MQ_SFX.log.slice();
      raidLocal.utility = ''; raidLocal.input.jump = false;
      // the shield goes up, then times out
      raidLocal.shield = false; raidMathShieldCharges = 1;
      MQ_SFX.log.length = 0; raidTryShield(); out.shieldOn = MQ_SFX.log.slice();
      raidLocal.shieldTimer = 1; MQ_SFX.log.length = 0; raidUpdateLocal(); out.shieldOff = MQ_SFX.log.slice();
      return out;
    });
    expect(r.hurt).toEqual(['hurt']);
    expect(r.ward).toEqual(['ward_block']);
    expect(r.dash).toEqual(['dash']);
    expect(r.jump).toEqual(['jump']);
    expect(r.land, 'a landing from a jump is heard once').toEqual(['land']);
    expect(r.double).toEqual(['double_jump']);
    expect(r.shieldOn).toEqual(['shield_on']);
    expect(r.shieldOff).toEqual(['shield_off']);
  });

  test('SND-03 the Familiar firing, a stunned boss, a phase change, victory and defeat each have a sound, once', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('grinmaw', 1);
      raidSfxReset(); raidSfxTick();
      MQ_SFX.recording = true;
      const out = {};
      raidG.playerProjectiles = [{ x: 100, y: 100, vx: 3, vy: 0, life: 50, damage: 1, r: 4 }]; MQ_SFX.log.length = 0; raidSfxTick(); out.minion = MQ_SFX.log.slice();
      MQ_SFX.log.length = 0; raidG.boss.exposed = 120; raidSfxTick(); out.stun = MQ_SFX.log.slice();
      MQ_SFX.log.length = 0; raidG.boss.exposed = 100; raidSfxTick(); out.stunStays = MQ_SFX.log.slice();
      raidG.boss.exposed = 0; raidSfxTick();
      MQ_SFX.log.length = 0; raidG.boss.transition = 100; raidSfxTick(); out.phase = MQ_SFX.log.slice();
      MQ_SFX.log.length = 0; raidG.boss.transition = 60; raidSfxTick(); out.phaseStays = MQ_SFX.log.slice();
      raidG.boss.transition = 0; raidSfxTick();
      MQ_SFX.log.length = 0; raidG.victory = true; raidSfxTick(); raidSfxTick(); out.victory = MQ_SFX.log.slice();
      raidG.victory = false; raidSfxReset(); raidSfxTick();
      MQ_SFX.log.length = 0; raidG.gameOver = true; raidSfxTick(); raidSfxTick(); out.defeat = MQ_SFX.log.slice();
      return out;
    });
    expect(r.minion).toEqual(['minion_shot']);
    expect(r.stun).toEqual(['boss_stunned']);
    expect(r.stunStays).toEqual([]);
    expect(r.phase).toEqual(['phase_change']);
    expect(r.phaseStays).toEqual([]);
    expect(r.victory, 'victory fanfare plus the boss going down, once').toEqual(['boss_defeated', 'victory']);
    expect(r.defeat).toEqual(['game_over']);
  });
});

test.describe('Boss sounds (SND-04)', () => {
  test('SND-04 every boss animation state has a sound (or a deliberate silence), and every move is heard when it happens', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      const out = {};
      for (const boss of BOSS_ORDER) {
        T.seed(5); T.prepBoss(boss, 3); raidG.boss.attackTimer = 30;
        raidSfxReset(); MQ_SFX.recording = true; MQ_SFX.log.length = 0;
        const states = new Set(), kinds = new Set(), hazards = new Set();
        for (let f = 0; f < 3500; f++) {
          T.place(500, undefined, { invincible: 30 });
          T.step(1); raidSfxTick();
          states.add(raidG.boss.anim.state);
          raidG.projectiles.forEach((p) => { if (!p.isWarning) kinds.add(p.kind); });
          raidG.hazards.forEach((h) => hazards.add(h.kind));
          if (T.me().health <= 2) { raidPlayerRef.child(raidMyId).update({ health: 5 }); raidG.gameOver = false; }
        }
        out[boss] = { states: [...states], kinds: [...kinds], hazards: [...hazards], heard: [...new Set(MQ_SFX.log)], table: MQ_BOSS_SFX[boss] };
      }
      out.shots = MQ_SHOT_SFX; out.hz = MQ_HAZARD_SFX;
      return out;
    });
    for (const b of BOSSES) {
      const o = r[b];
      for (const s of o.states) {
        if (s === 'idle') continue;
        expect(Object.keys(o.table), b + ' state "' + s + '" needs a sound decision').toContain(s);
        if (o.table[s]) expect(o.heard, b + ' ' + s + ' -> ' + o.table[s]).toContain(o.table[s]);
      }
      expect(o.states.length, b + ' did attack').toBeGreaterThan(3);
      for (const k of o.kinds) {
        expect(Object.keys(r.shots), b + ' shot ' + k + ' has a launch sound').toContain(k);
        expect(o.heard, b + ' ' + k + ' launch heard').toContain(r.shots[k]);
      }
      for (const h of o.hazards) {
        expect(Object.keys(r.hz), b + ' hazard ' + h + ' has sounds').toContain(h);
        Object.values(r.hz[h]).forEach((name) => expect(o.heard, b + ' ' + h + ' -> ' + name).toContain(name));
      }
    }
    // the decisions are real sounds
    const defs = await page.evaluate(() => MQ_SFX.names());
    for (const b of BOSSES) Object.values(r[b].table).filter(Boolean).forEach((n) => expect(defs).toContain(n));
    Object.values(r.shots).forEach((n) => expect(defs).toContain(n));
    Object.values(r.hz).forEach((h) => Object.values(h).forEach((n) => expect(defs).toContain(n)));
  });

  test('SND-04 a boss move starts one sound, not one per synced update (a non-host sees the same state for several frames)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      await T.setupRaid('grinmaw');
      T.prepBoss('colossus', 1);
      raidSfxReset(); raidSfxTick();
      MQ_SFX.recording = true; MQ_SFX.log.length = 0;
      raidG.boss.anim = { state: 'slamWindup', timer: 1 };
      for (let i = 0; i < 6; i++) { raidG.boss.anim = { state: 'slamWindup', timer: 1 + i }; raidSfxTick(); }
      const first = MQ_SFX.log.slice();
      raidG.boss.anim = { state: 'slamDown', timer: 1 }; raidSfxTick();
      return { first, after: MQ_SFX.log.slice() };
    });
    expect(r.first).toEqual(['windup_charge']);
    expect(r.after).toEqual(['windup_charge', 'boss_slam']);
  });
});

test.describe('Interface sounds (SND-05)', () => {
  test('SND-05 buttons click, equipping and buying have their own sounds, and refusals sound like refusals', async ({ page }) => {
    const r = await page.evaluate(async () => {
      MQ_SFX.recording = true;
      const out = {};
      mqProfile.owned.sword_moss = 1; mqProfile.owned.util_boots = 1; mqProfile.owned.util_coin = 1; mqProfile.owned.util_boots2 = 1; mqProfile.owned.util_iron = 1;
      const run = (fn) => { MQ_SFX.log.length = 0; fn(); return MQ_SFX.log.slice(); };
      out.equip = run(() => mqEquipItem('sword_moss'));
      out.charmOn = run(() => mqEquipItem('util_boots'));
      out.charmOff = run(() => mqEquipItem('util_boots'));
      mqEquipItem('util_boots'); mqEquipItem('util_coin'); mqEquipItem('util_boots2');
      out.refused = run(() => mqEquipItem('util_iron')); // no fourth slot
      mqProfile.coins = 100;
      out.broke = run(() => mqBuyItem('skin_golden'));
      mqProfile.coins = 20000;
      out.bought = run(() => mqBuyItem('util_titan'));
      out.reward = run(() => { currentDifficulty = 'normal'; mqAwardRaidVictory(); });
      return out;
    });
    expect(r.equip).toEqual(['ui_equip']);
    expect(r.charmOn).toEqual(['ui_equip']);
    expect(r.charmOff).toEqual(['ui_unequip']);
    expect(r.refused).toEqual(['ui_error']);
    expect(r.broke).toEqual(['ui_error']);
    expect(r.bought).toEqual(['ui_buy']);
    expect(r.reward).toEqual(['coins']);
    // a real button press ticks too
    await page.evaluate(() => { MQ_SFX.log.length = 0; });
    await page.evaluate(() => { const b = document.createElement('button'); document.body.appendChild(b); b.click(); b.remove(); });
    expect(await page.evaluate(() => MQ_SFX.log)).toContain('ui_click');
  });

  test('SND-05 opening a crate shakes, pops, then plays a reveal that matches the rarity (and a coin jingle for a duplicate)', async ({ page }) => {
    await page.evaluate(() => { MQ_SFX.recording = true; mqProfile.coins = 5000; showSection('shop'); mqOnShopOpen(); });
    const open = async (rarityItem, dup) => {
      await page.evaluate(([item, d]) => {
        window.mqRollCrate = () => MQ_ITEM_MAP[item];
        delete mqProfile.owned[item]; if (d) mqProfile.owned[item] = 1;
        MQ_SFX.log.length = 0; mqOpenCrate('crate_starter');
      }, [rarityItem, dup]);
      const early = await page.evaluate(() => MQ_SFX.log.slice());
      await page.waitForTimeout(2900);
      const later = await page.evaluate(() => MQ_SFX.log.slice());
      await page.evaluate(() => { mqCloseModal(); });
      return { early, later };
    };
    const a = await open('sword_moss', false);
    expect(a.early).toEqual(['crate_shake']);
    expect(a.later).toEqual(['crate_shake', 'crate_open', 'reveal_uncommon']);
    const b = await open('sword_dawn', false);
    expect(b.later).toEqual(['crate_shake', 'crate_open', 'reveal_legendary']);
    const c = await open('skin_ninja', true);
    expect(c.later).toEqual(['crate_shake', 'crate_open', 'reveal_uncommon', 'dup_coins']);
    // too poor: an error, no crate
    await page.evaluate(() => { mqProfile.coins = 0; MQ_SFX.log.length = 0; mqOpenCrate('crate_starter'); });
    expect(await page.evaluate(() => MQ_SFX.log)).toEqual(['ui_error']);
  });

  test('SND-05 practice answers ding or buzz, and the raid countdown ticks then goes', async ({ page }) => {
    const r = await page.evaluate(() => {
      MQ_SFX.recording = true;
      const out = {};
      showSection('practice');
      const btn = document.createElement('button');
      document.body.appendChild(btn);
      currentAnswer = 7;
      MQ_SFX.log.length = 0; handleAnswer(7, btn); out.right = MQ_SFX.log.slice();
      MQ_SFX.log.length = 0; handleAnswer(3, btn); out.wrong = MQ_SFX.log.slice();
      btn.remove();
      MQ_SFX.log.length = 0;
      startCountdown(() => {});
      return out;
    });
    expect(r.right).toEqual(['answer_correct']);
    expect(r.wrong).toEqual(['answer_wrong']);
    await page.waitForTimeout(3400);
    const log = await page.evaluate(() => { clearInterval(countdownInterval); return MQ_SFX.log.filter((n) => n.startsWith('countdown')); });
    expect(log).toEqual(['countdown_tick', 'countdown_tick', 'countdown_go']);
  });
});
