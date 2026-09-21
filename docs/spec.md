# Math Quest - Product Spec

The single source of truth for what Math Quest is supposed to do. Every requirement has an ID
(e.g. `RAI-12`) so code, PRs and conversations can point at it. **Keep this file current** - see
`CLAUDE.md` for the rule.

- Status legend: **Done** = implemented and deployed, **Off** = implemented but switched off,
  **Known issue** = intentionally not solved yet (see section 12).
- Numbers below are the current values in code. Frame counts assume 60 frames per second.

## 1. Overview

Math Quest is an educational math game played in the browser. It has three parts:

1. **Practice** - single-player multiple-choice math questions.
2. **Community** - players create and share their own question sets.
3. **Boss Raid** - a cartoon multiplayer boss battle (up to 6 players) with a coin economy, a shop
   with loot crates, and cosmetic player and gun skins.

Target audience: kids and students. Tone: friendly, cartoon, no scary content.

## 2. Architecture and hosting

| ID | Requirement | Status |
|----|-------------|--------|
| GEN-01 | The app is **one HTML file**, `index.html` (HTML, CSS and JS), plus **one image asset**: the boss sprite sheet `assets/boss-sheet.webp` (BOS-30). No build step, no framework, no local scripts or stylesheets. All other art (players, guns, crates, backgrounds) is drawn with canvas paths and CSS. | Done |
| GEN-02 | Hosted on Firebase Hosting, project `mathquest-f54b5`, hosting target `mathquest`, live at `https://math-quest-site.web.app`. | Done |
| GEN-03 | Every push to `main` deploys automatically via GitHub Actions (`.github/workflows/firebase-hosting-merge.yml`). The workflow deploys **hosting only** - not Firestore or Realtime Database rules. | Done |
| GEN-04 | `index.html` must be served with `Cache-Control: no-cache, max-age=0, must-revalidate` (set in `firebase.json`) so players never run stale JS after a deploy. | Done |
| GEN-05 | Backends: Firebase Anonymous Auth (identity), Firestore (community sets), Realtime Database (lobbies and raid sync). | Done |
| GEN-06 | Player progress (coins, owned items, equipped items) is stored in the browser's `localStorage`, not on a server. | Done |
| GEN-07 | Changes reach `main` through pull requests. Nothing is merged or deployed until the user says so. | Process |
| GEN-08 | Dev-only files (`tests/`, `docs/`, `node_modules/`, package files, Playwright config, `CLAUDE.md`, `sprites/`) are listed in `firebase.json` `hosting.ignore` so they are never published to the live site. `assets/` is **not** ignored: it is deployed. | Done |

## 3. App shell and navigation

| ID | Requirement | Status |
|----|-------------|--------|
| NAV-01 | Left sidebar with these buttons in order: Home, Play, **Raid**, **Shop**, Design, Community, Create. (The raid button is labelled "Raid", not "Lobby".) | Done |
| NAV-02 | The sidebar bottom shows the player's coin balance. | Done |
| NAV-03 | One section is visible at a time; the active nav button is highlighted. | Done |
| NAV-04 | Home shows Questions Correct and Best Streak and a "Play now" button. | Done |

## 4. Practice (Play)

| ID | Requirement | Status |
|----|-------------|--------|
| PRA-01 | A practice round is 20 questions. Each question is multiple choice with 4 options. | Done |
| PRA-02 | Built-in sets: addition and subtraction. The Play button starts addition. | Done |
| PRA-03 | Score and current streak are shown during a round; best streak is tracked. | Done |
| PRA-04 | Community sets (section 6) can be played in the same practice UI. | Done |

## 5. Design Studio

| ID | Requirement | Status |
|----|-------------|--------|
| DES-01 | Players can change background colors, sidebar color, primary color, corner roundness and shadow strength live. | Done |
| DES-02 | Built-in theme presets: purple (default), ocean, forest, sunset, candy. | Done |

## 6. Community and Create

| ID | Requirement | Status |
|----|-------------|--------|
| COM-01 | Community lists public sets from Firestore collection `publicSets`, with search (name, creator, description) and refresh. | Done |
| COM-02 | Create form: set name (max 80), creator nickname (max 30), description (max 240), and 1 to 100 questions. | Done |
| COM-03 | Publishing writes to `publicSets` with `ownerId` = the anonymous auth uid. Firestore rules allow public read, owner-only write, and reject empty or oversized sets. | Done |

## 7. Boss Raid - lobby flow

The nav button is **Raid**. It opens the lobby list (internal section id `lobby`); the game itself
lives in section `raid`.

| ID | Requirement | Status |
|----|-------------|--------|
| LOB-01 | The lobby list shows each lobby's name, boss, difficulty, code, host, status (Waiting / In Raid) and player count `n/6`, with Join and Refresh. | Done |
| LOB-02 | Creating a lobby takes a name and generates a 4-digit code. Creation is a transaction so two hosts can never get the same code. | Done |
| LOB-03 | After creating, the **host** sees the boss selection page (4 bosses) and a **difficulty** picker (Easy / Normal / Hard, default Normal). Picking a boss commits both. Non-hosts see "waiting for the host". | Done |
| LOB-04 | The waiting room shows the boss, difficulty and the player list. Only the host sees Start Raid. Everyone sees Leave Lobby. | Done |
| LOB-05 | Start Raid writes a start signal; **every** client (host and non-host) switches to the game and runs the 3-2-1 countdown. | Done |
| LOB-06 | A collapsible "How to Play" tutorial is on the raid page (controls, wind-ups/markers, shield, dash, HP bar goal). It must not mention math while math is off (RAI-40) and must not tell players when a boss is vulnerable (BOS-12). | Done |
| LOB-07 | Max 6 players per lobby; a full or in-progress lobby cannot be joined. | Done |
| LOB-08 | Start Raid must work repeatedly in one page session (the Start button is re-enabled for each new lobby). Regression: it once worked only once per page load. | Done |
| LOB-09 | When the last player leaves, the lobby is deleted **together with its raid data**. Empty lobbies (5 s) and lobbies whose players timed out are deleted the same way. | Done |
| LOB-10 | Raid state lives at `bossRaid/<lobbyId>`. It is deleted together with the lobby, cleared when a lobby is created with a reused code, and orphans (4-digit ids with no lobby) are swept once per page load. | Done |
| LOB-11 | Leaving a lobby cleans up all listeners, intervals and timers so the next lobby starts clean (no leaks, no duplicate handlers). | Done |

## 8. Boss Raid - gameplay

### 8.1 Multiplayer model

| ID | Requirement | Status |
|----|-------------|--------|
| RAI-01 | **Host-authoritative.** The raid host (lowest sorted player id) simulates the boss, bullets, hazards and damage, and publishes them to `bossRaid/<id>/gameState`. Clients render that state. If the host leaves, host status moves to the next player. | Done |
| RAI-02 | Each player writes their own position, health, shield, facing, reload progress, skin and gun to `bossRaid/<id>/players/<raidId>` (about every 2 frames). | Done |
| RAI-03 | **Shot relay.** Non-host players' bullets are pushed to `bossRaid/<id>/shots`; the host consumes and deletes them and spawns the bullet. (Without this, only the host could damage the boss.) Shots older than 4 s are dropped. | Done |
| RAI-04 | Nothing written to Firebase may contain `undefined` (Firebase rejects it); use `''`, `0`, `false` or `null`. | Rule |
| RAI-05 | Players are stored by their top-left corner; hit checks use the player's centre (`x + 18`, `y + 24`). Remote players are drawn at their true position. | Done |

### 8.2 Player controls and stats

| ID | Requirement | Status |
|----|-------------|--------|
| RAI-10 | Controls: Left/Right move, Up jump, Space shoot, Shift or E shield, X dash, R reload. | Done |
| RAI-11 | Player has 5 hearts. After a hit the player is invincible for 30 frames. If any player reaches 0 hearts the raid is lost (Defeated). | Done |
| RAI-12 | **Shooting:** 20-round magazine, 7-frame delay between shots, bullets fly straight up from the gun muzzle, 3 damage each, life 120 frames. | Done |
| RAI-13 | **Reloading:** the magazine reloads automatically when it hits 0 (R reloads early). A reload takes 100 frames (about 1.7 s) during which the player cannot shoot. There is no passive ammo regeneration. | Done |
| RAI-14 | **Reload animation:** the gun tilts out, the old magazine drops, a new one slides in, the gun snaps back with a spark; a progress ring above the head shows reload progress to everyone. The HUD shows `n/20` or `RELOADING`. | Done |
| RAI-15 | **Shield:** blocks damage for 90 frames. Starts with 2 charges, max 3, and recharges +1 every 420 frames (7 s). | Done |
| RAI-16 | **Dash:** X gives a burst of speed and 14 frames of invincibility, 180-frame (3 s) cooldown. | Done |
| RAI-17 | Movement: acceleration, friction, max speed 7; jump velocity -13 with gravity 0.4 (a jump clears low ground hazards). | Done |

### 8.3 Difficulty

| ID | Requirement | Status |
|----|-------------|--------|
| DIF-01 | The lobby host chooses Easy, Normal or Hard when creating the lobby; it is stored on the lobby and shown in the waiting room and lobby list. | Done |
| DIF-02 | Multipliers: **Easy** boss HP x0.7, attack gap x1.4; **Normal** x1, x1; **Hard** HP x1.35, gap x0.7. | Done |
| DIF-03 | Difficulty also sets the coin reward (RWD-01). | Done |

### 8.4 Math (currently off)

| ID | Requirement | Status |
|----|-------------|--------|
| RAI-40 | Math prompts (shield-recharge math, weak-point strike, ultimate interrupt) are **removed from gameplay for now**. They are gated behind `RAID_MATH_ENABLED = false` so they can be turned back on. While off, shields recharge on a timer (RAI-15) and the tutorial does not mention math. | Off |

## 9. Boss design rules and bosses

### 9.1 Rules every boss must follow

| ID | Requirement | Status |
|----|-------------|--------|
| BOS-01 | **Sourced attacks.** Every projectile or hazard visibly comes from the boss (mouth, hands, heads) or from a marked spot the boss is heading to. Nothing spawns from nowhere. | Done |
| BOS-02 | **Readable wind-up.** Every attack has an animated telegraph (body pose, glow, growing floor marker or shadow) long enough to react to. | Done |
| BOS-03 | **Dodgeable.** Every attack can be avoided by walking, dashing or jumping. Ground hazards can be jumped; markers show where damage will land. No screen-wide unavoidable sweeps. | Done |
| BOS-04 | **No overlap.** A boss starts its next attack only after the previous animation has finished. The gap between attacks is measured in idle time only. | Done |
| BOS-05 | Attack gap = `(190 - 20 x phase)` frames x difficulty multiplier (Normal: 170 / 150 / 130). Each fight starts with about 3 s of quiet. | Done |
| BOS-06 | Attacks never repeat back-to-back. In phase 3 the boss follows a move, 30% of the time, with a second different one after 60 idle frames. | Done |
| BOS-07 | **Aimed** projectiles (candy, fangs, void shots) are slow, at most 3 px/frame. **Lobbed** shots (fireballs, bubbles) fly a short, visible arc of at most about 1.6 s to a landing spot; fireballs erupt into a flame pillar there and bubbles pop. All use fair hitboxes centred on the player (see RAI-05). | Done |
| BOS-08 | **Phases:** phase 2 below 60% HP, phase 3 below 30%. Each change is a 100-frame beat: the boss pulses, is invulnerable (dashed ring), the arena is cleared, and a PHASE banner plays with screen shake. New attacks unlock in phase 2. | Done |
| BOS-09 | Bosses are untargetable (shots pass through) while faded out or submerged. | Done |
| BOS-10 | Each boss has its own animations and arena background; all boss animations run on the host and sync through boss state. | Done |
| BOS-11 | **Stun:** after its big moves a boss is stunned for **120 frames (2 s)** and takes **double damage**. | Done |
| BOS-12 | **Vulnerability is shown, not told.** A stunned boss tilts, sags and has dizzy stars circling its head. There is no text or icon saying "weak/exposed". | Done |
| BOS-13 | Feedback: screen shake on hits and phase changes, floating damage numbers, red flash when the local player is hit, phase notches at 60% and 30% on the boss HP bar. | Done |
| BOS-14 | The boss HP bar is large, fixed at the top of the screen (not attached to the boss). | Done |

### 9.2 The four bosses

| Boss | Max HP | Theme | Attacks (phase) | Stun after |
|------|--------|-------|-----------------|------------|
| **Grinmaw the Enthroned** | 150 | Red/gold throne demon | Candy spit (1): inhales, then spits slow candy at players. Throne slam (1): rises, slams, sends two jumpable shockwaves along the floor. Minion summon (2+): hurls two imps from his hands; they land and scurry along the floor. | Slam |
| **The Chained Warden** | 165 | Purple wraith | Chain lash (1): chain flung from its hands to a floor marker (two chains in 2+). Vanish strike (1): slowly fades, materialises on a floor marker, crashes down. Void orb (2+): orb grows in its hands, is thrown, hovers with growing spikes, bursts into 8 slow shots. | Vanish strike |
| **Trio, the Three-Headed Wyrm** | 180 | Teal sky serpent | Triple volley (1): each head spits a slow fang. Fire spit (1): 2 arcing fireballs (3 in 2+) land on a marker and erupt as flame pillars. Dive bomb (2+): flies over a target, floor shadow grows, dives and crashes. | Dive bomb |
| **The Glutton** | 160 | Green swamp beast | Belch (1): inflates, lobs slow bubbles at each player. Chomp (1): sinks and fades, swims as a shadow, slowly surfaces on a rippling floor marker, bites. Bubble fan (2+): a spread of bubbles with gaps. Feast: periodically clamps shut and is invulnerable for a telegraphed window. | Chomp |

### 9.3 Per-boss attack requirements

Frame counts are the durations of each animation state (60 frames = 1 second).

| ID | Requirement | Status |
|----|-------------|--------|
| BOS-20 | **Grinmaw.** Candy spit: inhale 26 frames (body swells), then one shot per player from the mouth. Throne slam: rise 60 frames, slam 5, then two floor shockwaves (one each way, speed 2.4 + 0.3 x phase) and a stun; a jumping player is not hit. Minion summon (phase 2+): after 30 frames two imps are thrown from the hands, land on the floor and scurry at 1.5 px/frame; jumping clears them. | Done |
| BOS-21 | **Warden.** Chain lash: a marker on the floor, the chain lands about 62 frames later and only hurts standing players; one chain, two (30 frames apart) from phase 2. Vanish strike: fade 50, unseen 40, materialise 45 on a floor marker, strike (hurts within 62 px, grounded), stun, return 40. Void orb (phase 2+): grows 40 frames in the hands, thrown, hovers until frame 135, then 8 evenly spaced slow shots from the orb. | Done |
| BOS-22 | **Wyrm.** Triple volley: coil, then one fang per head at frames 24, 44 and 64. Fire spit: fireballs at frames 26 and 60 (plus 94 from phase 2) that land on a spot and erupt into a pillar that hurts only after a 32-frame marker and only grounded players within 38 px (a high jump clears it). Dive bomb (phase 2+): fly over the target 45 frames, dive 26 frames, crash (hurts within 78 px, grounded), stun, climb back 50. | Done |
| BOS-23 | **Glutton.** Belch: inflate 24 frames, then one slow bubble per player that lands on the floor and pops. Chomp: sink and fade 48, swim as a shadow 52, surface on a floor marker 40, bite (hurts within 62 px, grounded), stun, retreat 48. Bubble fan (phase 2+): five bubbles landing more than 100 px apart. Feast: after a warning it clamps shut and is invulnerable for 80 frames; any attack ends the clamp early. | Done |

### 9.4 Boss sprite sheet

| ID | Requirement | Status |
|----|-------------|--------|
| BOS-30 | Bosses are drawn from `assets/boss-sheet.webp`: 2048 x 2048, 256 px cells, 8 columns, two rows per boss (Devil King, Wyrm, Warden, Glutton in that row order), under 1.5 MB. It is built from `sprites/boss-spritesheet-v2.png` by `sprites/build-game-sheet.js` and loaded from JS (`bossSheetLoad`, called when a raid starts). | Done |
| BOS-31 | Sixteen frames per boss: idle 1-4, windup, telegraph, attack, recover, hurt, hurt recover, enraged 1-2, special, death 1-3 (death frames are in the sheet but not used yet). `bossSpriteFrame(boss)` picks the frame from synced boss state only (stun, glutton feast, phase change, `anim.state` and `anim.timer`, `raidG.frame`), so every client shows the same frame. Idle changes every 15 frames; phase 3 idle uses the enraged frames. | Done |
| BOS-32 | Attack timelines use the sheet's poses: windup, then telegraph, then attack, then recover, per the state table `BOSS_SPRITE_STATES`. Grinmaw's summon and the Glutton's clamped-shut feast use the `special` frame. Fading, hidden and submerged states keep the idle art because the game already fades or sinks the boss. | Done |
| BOS-33 | The sprite is placed so the boss position (`boss.x`, `boss.y`, the hitbox centre and projectile origin) sits on the boss's face or body, at a per-boss scale (`BOSS_SPRITE.bosses`). Hitboxes, speeds and attack timings are **not** changed by the art. | Done |
| BOS-34 | The old canvas-path boss art stays in the code as a **fallback**: it is used until the sheet has loaded, if it fails to load, or when `RAID_BOSS_SPRITES_ENABLED` is false. | Done |
| BOS-35 | Vulnerability is still shown by animation only (BOS-12): a stunned sprite boss uses the hurt frames, wobbles, sags and has circling stars. No text or icon. | Done |

## 10. Rewards, shop and cosmetics

### 10.1 Coins

| ID | Requirement | Status |
|----|-------------|--------|
| RWD-01 | Beating a boss pays coins: **Easy 60, Normal 120, Hard 250, plus 10 per heart the player has left** (max 5). | Done |
| RWD-02 | Every player in the raid is paid separately, exactly once per victory. Defeat pays nothing. | Done |
| RWD-03 | The victory screen shows the coins earned, how they were calculated and the new balance. | Done |

### 10.2 Shop

| ID | Requirement | Status |
|----|-------------|--------|
| SHP-01 | The Shop has two tabs: **Crates** and **My Items**, and always shows the coin balance. | Done |
| SHP-02 | Crates, prices and loot pools (odds are the rarity weight split equally among that rarity's items in the pool): see table below. | Done |
| SHP-03 | Each crate has an **Odds** button showing every item's exact percentage, grouped by rarity with rarity totals; each crate's odds sum to 100%. | Done |
| SHP-04 | Opening a crate deducts the price, plays an animation (shake, lid pops, flash), then reveals the item with a rarity banner and confetti that scales with rarity. Insufficient coins shows a message and does nothing. | Done |
| SHP-05 | **Duplicates convert to coins:** Common 10, Uncommon 25, Rare 60, Epic 150, Legendary 350. | Done |
| SHP-06 | **My Items** shows an animated loadout preview (fires, then reloads), filters (All / Player Skins / Gun Skins), a "hide locked" toggle, a collected counter, owned counts, locked items dimmed, and an Equip button per owned item. | Done |
| SHP-07 | One player skin and one gun skin can be equipped at a time. The default skin and gun are always owned. | Done |
| SHP-08 | Equipped items are used in every raid and shown to all players (skin, gun, bullet style, trail, reload animation). | Done |
| SHP-09 | Skins are cosmetic only - no stat effects. | Done |

Crates:

| Crate | Price | Pool | Rarity weights |
|-------|-------|------|----------------|
| Starter Crate | 100 | All skins and guns (22 items) | Common 64, Uncommon 27, Rare 8, Epic 1 |
| Hero Crate | 250 | Player skins only (10) | Uncommon 38, Rare 40, Epic 17, Legendary 5 |
| Arsenal Crate | 250 | Gun skins only (10) | Uncommon 38, Rare 40, Epic 17, Legendary 5 |
| Cosmic Crate | 400 | Items tagged "cosmic" (6): Astronaut, Galaxy Walker, Stardust Wand, Void Pulse, Solar Flare, Sunbreaker | Rare 60, Epic 32, Legendary 8 |
| Legend Crate | 700 | All skins and guns (14) | Rare 46, Epic 39, Legendary 15 |

### 10.3 Items

Rarities: Common, Uncommon, Rare, Epic, Legendary (rarer items are drawn with more animation and glow).

| Rarity | Player skins | Gun skins |
|--------|--------------|-----------|
| Common | Classic Cup (default), Sprout, Bubblegum, Bumblebee | Standard Blaster (default), Candy Blaster, Bubble Popper, Lime Zapper |
| Uncommon | Buccaneer, Frost Sprite, Shadow Ninja | Rocket Ray, Pixel Pistol, Petal Wand |
| Rare | Astronaut, Star Wizard, Robo-Bot | Frost Cannon, Ember Rifle, Stardust Wand |
| Epic | Inferno, Galaxy Walker | Void Pulse, Solar Flare |
| Legendary | Golden Champion, Prism Phantom | Sunbreaker, Prism Railgun |

| ID | Requirement | Status |
|----|-------------|--------|
| ITM-01 | All skins and guns are drawn with canvas paths and must look polished: outlines, gradients, and animation on higher rarities (flames, sparkles, rainbow, twinkling stars). The same drawing code renders the raid, shop previews and the loadout. | Done |
| ITM-02 | Gun skins change the gun model (blaster, cannon, wand, ray, rail), the **bullet style** and the bullet trail. | Done |
| ITM-03 | Tall hats/hair must not overlap the health bar or reload ring (bars are lifted per skin). | Done |

## 11. Data model (Firebase)

| Path | Purpose |
|------|---------|
| Firestore `publicSets/<id>` | Community question sets (`ownerId`, `name`, `questions`, ...). |
| RTDB `lobbies/<code>` | `name`, `hostId`, `status`, `playerCount`, `createdAt`, `bossType`, `difficulty`, `raidStart`, `players`. |
| RTDB `bossRaid/<code>/gameState` | Host-published boss, projectiles, hazards, slam effects, `gameOver`, `victory`. |
| RTDB `bossRaid/<code>/players/<raidId>` | Per-player live state (position, health, shield, facing, reload, skin, gun). |
| RTDB `bossRaid/<code>/presence`, `shots`, `mathHits` | Heartbeats, relayed shots, math answers (math off). |
| `localStorage` `mathquest_raid_profile_v1` | `coins`, `owned` (id to count), `equipped` (skin, gun), `stats`. |

| ID | Requirement | Status |
|----|-------------|--------|
| DAT-01 | `database.rules.json` allows public reads of `lobbies` and `bossRaid/<id>` but requires an authenticated user for writes, and denies everything else. (The rules file exists but is not deployed - see section 12.) | Done |

## 12. Known issues and decisions

- **Realtime Database rules are not deployed.** `database.rules.json` requires auth for writes, but the deploy workflow only deploys hosting, so the live database is effectively open. Deploying the rules is a separate decision.
- **Coins and items live in the browser** and can be edited by a determined player. Acceptable for cosmetics; move server-side if coins ever gain real value.
- **One pre-existing self-test fails:** "Attack timer resets after attack" (`testBossAttack`). It is unrelated to current gameplay and shows up in every console.
- Four legacy `bossRaid` nodes from an old version (`global` and three long ids) remain; current code never uses them.
- `sprites/` in the working folder is untracked dev tooling and is never deployed. It holds the v1 boss sheet, the v2 boss, player-skin and gun sheets (only the boss sheet is used by the game, via `assets/boss-sheet.webp`), `build-sheets.js` / `build-game-sheet.js` to regenerate them and `verify-sheets.js` to check them.
- **Sprite bosses are drawn bigger and more detailed than the old art but keep the old hitboxes** (120 x 80). Parts of the art outside the hitbox (Wyrm wings and body, Warden robe) cannot be hit. Telegraph glows that used to be drawn inside the old boss art (throat glow, raised chain, orb) are now only in the sheet frames; floor markers and hazards are unchanged.
- The sheet's death frames are not shown on victory yet, and the player and gun sheets are not used by the game (skins and guns are still drawn with canvas paths).
- Lobby host (creator) and raid host (simulation owner) are different concepts and can differ.
- In a hidden headless browser pane `requestAnimationFrame` does not tick, so game-loop tests must drive frames manually.

## 13. Testing

| ID | Requirement | Status |
|----|-------------|--------|
| TST-01 | `index.html` still contains its older in-page self-test suite (`TestSuite`), run by `test.html`. It is legacy; the spec-based suite below is what CI runs. | Done |
| TST-02 | Before writing any new function or code, write a test case for it first and validate the code against it (global project rule). | Process |
| TST-03 | Manual verification for gameplay: run the game locally against the live Firebase project, drive each boss and attack, and check for new console errors. Delete any test lobbies you create. | Process |
| TST-04 | **Automated tests run on every pull request** (and on pushes to `main`) through `.github/workflows/tests.yml`: `npm ci`, install Chromium, `npm test`. A failing test fails the check. | Done |
| TST-05 | **The tests follow the spec.** Test titles start with the requirement IDs they check. `tests/spec-coverage.spec.js` fails if any Done/Off requirement has no test, or a test names an ID that is not in this spec. New or changed requirements therefore need a test in the same PR. | Done |
| TST-06 | Tests load the real `index.html` in a browser with Firebase replaced by an in-memory stub (`tests/support/firebase-stub.js`); no test talks to the live project or needs secrets. The stub mimics Firebase behaviours the game depends on (synchronous local events, `undefined` rejected, empty objects dropped). Locally: `npm ci`, then `PW_CHANNEL=chrome npm test` (or install Chromium and run `npm test`). | Done |

## 14. Change log

| Date | Change |
|------|--------|
| 2026-09 | Initial site, practice, community, design studio; Firebase hosting and auto-deploy. |
| 2026-09 | Boss raid overhaul: waiting-room lobby, 2 bosses, fixed HP bar, dash, cartoon art. |
| 2026-09 | Hosting cache fix, Leave Lobby button, boss picker after lobby creation, hand-drawn art, 2 more bosses. |
| 2026-09 | Per-boss animation state machines. |
| 2026-09 | Raid page tutorial, host-chosen difficulty, nav button renamed "Raid", Start Raid works repeatedly (LOB-08), listener leak fixes. |
| 2026-09 | Boss fight depth: phase transitions, stun window, combos, hit feedback (PR #6). |
| 2026-09 | Attack rework: sourced telegraphed dodgeable attacks, stun shown by animation, math switched off (PR #6). |
| 2026-09 | 20-round reloading, coin rewards, shop with 5 crates, 28 skins, shot relay fix, 2 s stun (PR #7). |
| 2026-09 | Raid data deleted with its lobby and orphans swept (LOB-09, LOB-10). |
| 2026-09 | Added `docs/spec.md` and `CLAUDE.md`. |
| 2026-09 | Added the spec-based Playwright test suite and the "Tests" GitHub Action for every PR (TST-04 to TST-06, GEN-08, DAT-01, BOS-20 to BOS-23); corrected BOS-07 (lobbed shots); fixed skins whose hats/hair overlapped the health bar (ITM-03). |
| 2026-09 | v2 sprite sheets in untracked `sprites/` (boss 4 x 16 frames, 14 player skins, 14 guns). |
| 2026-09 | Bosses are drawn from `assets/boss-sheet.webp` with the old art as fallback (BOS-30 to BOS-35); GEN-01 now allows this one image asset. |
