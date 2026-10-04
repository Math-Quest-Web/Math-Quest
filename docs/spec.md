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
   with loot crates, and cosmetic player skins and swords.

Target audience: kids and students. Tone: friendly, cartoon, no scary content.

## 2. Architecture and hosting

| ID | Requirement | Status |
|----|-------------|--------|
| GEN-01 | The app is **one HTML file**, `index.html` (HTML, CSS and JS), plus **one image asset**: the boss sprite sheet `assets/boss-sheet.webp` (BOS-30). No build step, no framework, no local scripts or stylesheets. All other art (players, swords, crates, backgrounds) is drawn with canvas paths and CSS. | Done |
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
| LOB-03 | After creating, the **host** sees the boss selection page (7 bosses) and a **difficulty** picker (Easy / Normal / Hard, default Normal). Picking a boss commits both. Non-hosts see "waiting for the host". | Done |
| LOB-04 | The waiting room shows the boss, difficulty and the player list. Only the host sees Start Raid. Everyone sees Leave Lobby. | Done |
| LOB-05 | Start Raid writes a start signal; **every** client (host and non-host) switches to the game and runs the 3-2-1 countdown. | Done |
| LOB-06 | A collapsible "How to Play" tutorial is on the raid page (controls, wind-ups/markers, shield, dash, HP bar goal). It must not mention math while math is off (RAI-40) and must not tell players when a boss is vulnerable (BOS-12). | Done |
| LOB-07 | Max 6 players per lobby; a full or in-progress lobby cannot be joined. | Done |
| LOB-08 | Start Raid must work repeatedly in one page session (the Start button is re-enabled for each new lobby). Regression: it once worked only once per page load. | Done |
| LOB-09 | When the last player leaves, the lobby is deleted **together with its raid data**. Empty lobbies (5 s) and lobbies whose players timed out are deleted the same way. | Done |
| LOB-10 | Raid state lives at `bossRaid/<lobbyId>`. It is deleted together with the lobby, cleared when a lobby is created with a reused code, and orphans (4-digit ids with no lobby) are swept once per page load. | Done |
| LOB-12 | **Leaving on exit.** Clicking **any** sidebar button (including Raid and Play) while in a lobby leaves it and goes where the click pointed; closing the tab (`pagehide`) leaves it too. Leaving removes the player; if they were the last player the lobby and its raid data are deleted (LOB-09), otherwise the player count drops and, if the leaver was the lobby host, host moves to another player. | Done |
| LOB-11 | Leaving a lobby cleans up all listeners, intervals and timers so the next lobby starts clean (no leaks, no duplicate handlers). | Done |

## 8. Boss Raid - gameplay

### 8.1 Multiplayer model

| ID | Requirement | Status |
|----|-------------|--------|
| RAI-01 | **Host-authoritative.** The raid host (lowest sorted player id) simulates the boss, Familiar bolts, hazards and damage, and publishes them to `bossRaid/<id>/gameState`. Clients render that state. If the host leaves, host status moves to the next player. | Done |
| RAI-02 | Each player writes their own position, health, shield, facing, skin and weapon (the `gun` field - the name is kept for compatibility, it always holds a sword id now) to `bossRaid/<id>/players/<raidId>` (about every 2 frames). | Done |
| RAI-04 | Nothing written to Firebase may contain `undefined` (Firebase rejects it); use `''`, `0`, `false` or `null`. | Rule |
| RAI-25 | **Hits land on the player who was hit.** A player's own client is the only writer of their health. When the host's simulation hits someone else it pushes an event `{target, amount, inv}` (or `ward: true` for a Warding Sigil absorb) to `bossRaid/<id>/hits`; the target applies it once (health, invincibility, knockback, hit-stop), publishes the new health in its next sync and removes the event. The host never delivers a second hit to a player within their invincibility window. (Before, the host overwrote the teammate's health, their next sync overwrote it back, and only the host ever stayed hurt.) | Done |
| RAI-26 | **Fight on after a teammate falls.** A downed player stays in the raid as a spectator (their client keeps syncing); targeted boss attacks (random target, nearest-player charge, bramble toss, boulder hurl) skip downed players. The remaining players keep fighting; the defeat screen only appears when all players are down. | Done |
| RAI-27 | **Fullscreen battle.** When the battle starts the game covers the whole window (`body.raid-fs`: the sidebar is hidden, the canvas scales to fit with the HUD and Leave button below it) and also asks the browser for real fullscreen where it allows it (it needs a recent click, so it is best-effort). Leaving the lobby restores the normal layout, and so does pressing **Esc** (or the browser leaving real fullscreen): the sidebar comes back and its buttons work, while the raid keeps running. | Done |
| RAI-05 | Players are stored by their top-left corner; hit checks use the player's centre (`x + 18`, `y + 24`). Remote players are drawn at their true position. | Done |

### 8.2 Player controls and stats

| ID | Requirement | Status |
|----|-------------|--------|
| RAI-10 | **Controls (Hollow Knight-style):** Left/Right move, Z jumps (it is the only jump key - Up never jumps, it only aims the sword upward, WPN-05), X or Space swing the sword, Shift or E shield, C dash. | Done |
| RAI-11 | Player has 5 hearts. After a hit the player is invincible for 30 frames. A player at 0 hearts is **down**: they can no longer move, swing, shield or dash, bosses stop targeting them and hits skip them (RAI-26). The raid is lost (Defeated) only when **every** player is down. | Done |
| RAI-15 | **Shield:** blocks damage for 90 frames. Starts with 2 charges, max 3, and recharges +1 every 420 frames (7 s). | Done |
| RAI-16 | **Dash:** C gives a committed 11-frame burst at speed 14 (about 154 px - a little farther than the old 120 px; it bypasses the normal accel/friction/speed-cap handling so the burst isn't immediately clamped back down) plus 14 frames of invincibility. **A dash keeps your height:** gravity and vertical speed are switched off for as long as it lasts (a grounded dash stays grounded, an airborne one holds its exact height) and the jump key does nothing mid-dash; gravity takes over again when it ends. It leaves a short trail of afterimages; 180-frame (3 s) cooldown, shortened by the Swift Boots utility item (WPN-03). | Done |
| RAI-17 | **Movement:** acceleration `RAID_ACCEL` 0.55 with friction 0.85, so running tops out near 3 px/frame (a bit slower than before; Nimble Treads scales the acceleration, so it really speeds you up). **Jump (Hollow Knight-style, variable height, deliberately low because the bosses hover near the ground - BOS-44):** a tap rises about 120px under normal gravity (`RAID_GRAVITY` 0.25 - floaty, not heavy - with initial velocity `RAID_JUMP_VY` -7.7); holding the jump key keeps reduced gravity (`RAID_JUMP_HOLD_GRAVITY` 0.1) applied for up to `RAID_JUMP_HOLD_FRAMES` (12) frames or until the apex, reaching roughly 170px. A jump (of either height) clears low ground hazards. | Done |
| RAI-18 | **Boss hit area:** what a player's swing (or a Familiar bolt) must overlap to damage the boss is the boss's own drawn silhouette (BOS-46), not a box around its middle - so a boss with wide wings or a long body is hit anywhere it is drawn, and a narrow one is not hit in the empty air beside it. An untargetable boss (BOS-09) still can't be hit. | Done |
| RAI-19 | **Impact frame on taking a hit:** a small knockback away from the hit (opposite the player's facing), a bright white flash for the first ~6 of the player's 30 invincibility frames (fading to the ongoing orange flicker after), and a brief hit-stop (full engine freeze, a handful of frames) - felt on whichever client the hit player is on, host or not. | Done |
| RAI-20 | **Movement animation:** while grounded, the player bobs (a small idle sway, a bigger/faster bob while running) and leans slightly into the direction of travel; none of it while airborne. Driven by the shared frame counter and the player's synced `vx`/`onGround`, so it plays the same for every client watching a teammate. | Done |
| RAI-22 | **Attack pose (placeholder animation):** a sword swing animates the whole body, not just the blade, in three phases keyed to the already-synced swing progress - anticipation (first 25%: crouch and pull back away from the swing), strike (25-55%: lunge and stretch along the swing's own absolute direction; the default swing follows facing; downward lunges never sink into the floor), recovery (55-100%: settle to neutral). Teammates see it too, since it needs no extra synced field. Original placeholder motion, not copied from any game's art. | Done |
| RAI-23 | **Hurt pose and hit burst (placeholder animation):** while a hit's impact frames last (`invincible` 30 down to 22) the body flinches - tilts and shoves back away from the facing, squashed - easing out as it counts down; derived from the synced `invincible` counter so teammates see it, and dash i-frames (max 21) never trigger it. The local player also gets a white shockwave ring and shards at their centre the moment their health drops, alongside the existing flash, knockback and hit-stop (RAI-19). | Done |
| RAI-24 | **Smooth motion:** other players' positions are synced every 2nd frame and the boss and its shots every 5th, so they are never drawn straight from the snapshots. Each teammate is drawn easing toward their latest synced position (40% of the gap per frame; a jump over 160 px, such as a respawn, snaps), and their swing counts down locally one frame at a time between syncs (a swinging teammate is drawn exactly where the host resolves their slash, WPN-15). A non-host also draws the boss eased toward its synced position and keeps flying boss shots by their own velocity (and gravity, for lobs) until the next snapshot corrects them. Display-only: the host simulation, hitboxes and everything synced are unchanged. | Done |
| RAI-21 | **Expressive movement animation:** a landing thump squashes the body wide/flat and a jump launch stretches it tall/thin, both decaying back to normal over 10 frames; while airborne the body leans into its own vertical speed (back while rising, forward while falling) instead of just holding still (RAI-20); a sword swing (WPN-02/WPN-05) leans the body toward the swing's own direction as it plays, not just the blade; dash afterimages (RAI-16) replay the exact motion pose (running, airborne, mid-swing) the player had on the frame each ghost was recorded, instead of a forced idle stance. All local-only cosmetic polish - not added to the synced player payload, so a teammate always sees a neutral (but never wrong) pose for these specifically. | Done |

### 8.3 Difficulty

| ID | Requirement | Status |
|----|-------------|--------|
| DIF-01 | The lobby host chooses Easy, Normal or Hard when creating the lobby; it is stored on the lobby and shown in the waiting room and lobby list. | Done |
| DIF-02 | Multipliers: **Easy** boss HP x0.7, attack gap x1.4; **Normal** x1, x1; **Hard** HP x1.35, gap x0.7. | Done |
| DIF-03 | Difficulty also sets the coin reward (RWD-01). | Done |

### 8.3b The Gauntlet

All seven bosses in a row, with a rest in between, optional handicaps and trophies. Multiplayer like any raid (the host picks it, everyone fights).

| ID | Requirement | Status |
|----|-------------|--------|
| GAU-01 | **Choosing it.** On the boss-choice page the host sees **challenge** toggles (GAU-04) and a **The Gauntlet** button beside the seven boss cards. Picking it writes `mode: 'gauntlet'`, `bossType` = the first boss, the difficulty and `challenges` to the lobby; picking a single boss writes `mode: 'boss'` and clears challenges. The lobby list and the waiting room show "The Gauntlet" (with difficulty and challenges). Every client reads mode, difficulty and challenges from the lobby record. | Done |
| GAU-02 | **Bosses in a row.** Order: Grinmaw, Warden, Wyrm, Glutton, Bramblehide, Colossus, Griffon (`BOSS_ORDER`). Beating a boss starts a **rest** of `GAUNTLET_REST_FRAMES` (300 = 5 s) during which the host simulates nothing (arena cleared, boss idle, no attacks); then the next boss appears at full HP (difficulty and challenges applied). Beating the seventh is the victory. After the victory screen the run restarts at boss 1. A HUD line shows the stage (n/7) and active challenges, and the rest shows a "BOSS DOWN" banner with a countdown. The stage and rest are synced in `gameState.gauntlet`. | Done |
| GAU-03 | **Healing between fights depends on difficulty:** **Easy** restores full hearts, **Normal** 3 hearts, **Hard** 1 heart (capped at max hearts). Every player is healed, a downed player is **revived** by it (they come back with the healed hearts, so Hard revives with 1), shield charges are refilled to at least 2 and the Warding Sigil is reset. The host heals itself directly and sends teammates a `hits` event `{target, heal}` (RAI-25) which their own client applies. The difficulty also keeps its normal boss HP and attack-gap effects (DIF-02). | Done |
| GAU-04 | **Challenges** (handicaps the host switches on, any combination, gauntlet only): **Fragile** (max 3 hearts, +25% coins), **No Shield** (+20%), **No Dash** (+20%), **Frenzy** (attack gap x0.6, +25%), **Titan Bosses** (boss HP x1.5, +25%), **No Healing** (the rest heals nothing, +30%). They have no effect outside the gauntlet. | Done |
| GAU-05 | **Coins.** A clear pays `(5 x the single-fight reward of the difficulty + 10 per heart left) x charm coin bonus x (1 + sum of the challenge bonuses)` - e.g. Normal, 5 hearts, no challenges: 650; all six challenges: x2.45. Falling pays `0.5 x the single-fight reward x bosses beaten` (same multipliers), once. Each player is paid separately, exactly once. | Done |
| GAU-06 | **Trophies.** A clear (never a loss) earns the difficulty trophy (Bronze / Silver / Gold Gauntlet for Easy / Normal / Hard), one "<challenge> Conqueror" trophy per active challenge, and **Masochist** when all six were on. They are counted in the saved profile (`trophies`, id to count; unknown ids are dropped on load) and shown in a trophy case on the Raid page. | Done |

### 8.4 Math (currently off)

| ID | Requirement | Status |
|----|-------------|--------|
| RAI-40 | Math prompts (shield-recharge math, weak-point strike, ultimate interrupt) are **removed from gameplay for now**. They are gated behind `RAID_MATH_ENABLED = false` so they can be turned back on. While off, shields recharge on a timer (RAI-15) and the tutorial does not mention math. | Off |

### 8.5 Equipment: weapons and utility

| ID | Requirement | Status |
|----|-------------|--------|
| WPN-01 | **Weapon slot:** the weapon slot always holds a sword - there are no guns, ammo or reloading. A fresh save owns and equips the Training Nail, and X/Space swings whichever sword is equipped (WPN-02). The slot is still stored under the `equipped.gun` profile key and the `raidLocal.gun` / synced `gun` field so existing saves and teammates need no migration; a leftover gun id from an old save or an old client simply draws (and plays) as the default sword. | Done |
| WPN-02 | **Sword combat, hitbox-accurate:** X/Space swings the sword. The sword's hit area is exactly the slash that is drawn (WPN-15): every host frame, each player's visible slash is tested for real overlap against the boss's own drawn silhouette (BOS-46) - a hit only lands on genuine overlap, at most once per swing, 4 damage, 26-frame cooldown between swings. Resolved identically for host and non-host players from each player's synced position/direction (no separate relay path), and triggers the same hurt-pose/flash/hit-stop feedback (BOS-13) as any other hit on the boss. | Done |
| WPN-04 | **Sword slash styles:** every sword's slash has its own colours and its own small effect, so a teammate's sword is easy to tell apart in a fight (`MQ_SLASH_STYLES`). Training Nail: plain white. Moss Blade: green with drifting leaves. Frostbite Edge: icy blue with ice shards and a bright rim. Voidbone Fang: dark violet with swirling wisps. Dawnbreaker: gold with sun rays and a glint. The effects are clipped to the slash, so what is seen is still exactly what hits (WPN-15). The small trail the shop preview draws for a swing stays white. | Done |
| WPN-05 | **8-way directional swings:** whichever movement keys (Up/Down/Left/Right) are held at the moment X/Space is pressed decide the swing's direction - all 8 combinations (4 cardinal, 4 diagonal), plus the default forward "side" swing when no direction is held. Direction is **absolute world-space, not facing-relative**: holding Left always aims left, even if the player is still facing right. Every direction is the same slash turned to face it (WPN-10), so the reach is the same whichever way you swing, and the hit area is that slash (WPN-15). Direction is locked in for the whole swing once it starts (releasing the key mid-swing doesn't change it). | Done |
| WPN-08 | **Pogo bounce (Hollow Knight nail-bounce):** a downward swing (WPN-05) whose slash (WPN-15) connects with the boss - or with a large, parryable boss shot (WPN-11), which the host removes as a parry - while airborne bounces the player upward at a fixed speed (-10, about 200 px, a little more than a jump; Pogo Spring adds 30%), clearing any held jump-boost so it's a clean snap rather than a modulated hold. At most one bounce per swing. Resolved purely client-side against each player's own synced state, so it's instant and identical whether that client is the raid host or not - damage itself is unaffected, still resolved only through the existing host-authoritative melee hit check (WPN-02), never duplicated by the bounce. | Done |
| WPN-09 | **Slash impact (placeholder animation):** a sword hit on the boss adds a short white slash-impact burst at the contact point - streaks fanning out along the swing's own direction (all around for the default side swing) plus a bright core flash - on top of the generic impact spark, visible to every client. Hits with no direction (a Familiar bolt) keep only the generic spark. | Done |
| WPN-10 | **Long, sweeping slash:** every swing direction reaches far: left, right, up and down are one shape turned to face each way, so the player always has the same reach, and diagonals are the same slash turned 45 degrees. The live player draws a large white slash (radius 115 px at the player's drawing scale of 0.85, scaled by Long Reach) from the sword hand: a forward arc of about 160 degrees centred on the swing's own direction - it does not surround the player - compressed to 55% across its direction (so its top and bottom ends sit close together while the forward reach is unchanged), that sweeps from its top end to its bottom end as the swing plays (head runs ahead, tail follows and fades it away). It is fat near the top, narrows through its farthest point and tapers to nothing at the bottom, and is mirrored for a left-facing player. About 125 px out from the body along the swing. This slash is the whole live swing animation: the old sweeping blade and small trail arcs are gone, and the blade just rests at its held angle. Dash afterimages draw no slash; only the shop preview (which has no room for it) keeps the old small swing. The slash is original art. | Done |
| WPN-11 | **Parry (large shots only):** while a player's slash is in view (the same frames and the same shape as a hit on the boss, WPN-15), every **large** boss projectile it touches is destroyed. Large means a radius of at least 11 (`RAID_PARRY_MIN_R`), and every thrown object in the game now is (BOS-07): rubble (15), bile (15), boulders (14), bombs (12), pods (12), feathers (12) and spirits (11). Hazards that are not projectiles (shockwaves, flame pillars, thorn spikes, tremors, feather drops, charges) cannot be parried and must be dodged. Parryable shots are drawn with a pulsing white ring. A parried lob never bursts or leaves terrain where it would have landed. Each parry shows a white-blue ring and glint at the shot and a 2-frame hit-stop, works even while the boss is untargetable, does not damage the boss, and a single swing can parry several shots. Host-resolved from the synced swing state like WPN-02. | Done |
| WPN-12 | **Charm badges (minimal):** every one of the 23 charms (WPN-03, WPN-14) shows as one tiny animated badge on a small dark disc - its own glyph, the same one as in its shop icon - so wearing several does not clutter the screen. The badges stack in a column behind the player (opposite the sword hand), in the order the charms were equipped, each bobbing gently. Glyphs: Swift Boots a winged boot, Lucky Charm a spinning coin, Feather Cloak a swaying feather, Vital Core a beating heart, Warding Sigil a turning rune, Nimble Treads a boot with speed lines, Iron Skin a plate with a sweeping glint, Reinforced Plating a hexagon with a chasing light, Mending Charm a pulsing plus, Long Reach a blade with arrows, Phantom Step a flickering ghost, Second Wind beating wings, Spectral Familiar an orbiting spirit, Quick Hands a fist with motion arcs, Long Stride a streaming arrow, Pogo Spring a coil, Deflector a shot glancing off a bracket, Whetstone a blade with sparks, Light Step a cloud, Opportunist a spinning crosshair, Thick Skin a studded plate, Golden Idol a glinting gold idol, Titan Heart a big beating heart. Visible to teammates and in the loadout preview; not drawn on dash afterimages. Cosmetic only. | Done |
| WPN-13 | **Charm loadout: 3 slots, 5 charm points.** A player can wear up to **3 charms at once**, and every charm costs **1, 2 or 3 charm points** (WPN-03 table); the worn charms' points may add up to at most **5**. Equipping a charm that would need a fourth slot, or more points than are left, is refused with a message saying which limit was hit (so one 3-point charm leaves room for two 1-pointers or one 2-pointer, and two 3-point charms never fit together). Clicking a worn charm takes it off. The loadout is saved as a comma-separated list of charm ids in the profile's `equipped.utility` (a lone id from an older save is still valid) and checked on load: unknown or unowned ids and duplicates are dropped, then charms are kept in order while they still fit. My Items shows the worn charms with the points used (e.g. "Charm points: 4 / 5") and every charm card shows its cost. In a raid every worn charm applies at once; the whole list is synced to teammates in the player's `utility` field, so the effects the host resolves (sword damage, stun bonus, Warding Sigil, Thick Skin, Deflector, the Familiar) read the swinger's or victim's own list. | Done |
| WPN-14 | **Ten more charms**, each with its own effect and animation (WPN-12): Quick Hands (sword cooldown -25%), Long Stride (dash 30% longer), Pogo Spring (pogo bounce +30%), Deflector (parry reach +40%), Whetstone (+25% sword damage), Light Step (falls with 0.7x gravity; rising is unchanged), Opportunist (+50% damage to a stunned boss, so a stunned hit does triple instead of double), Thick Skin (post-hit invincibility 45 frames instead of 30), Golden Idol (+25% coins, added to Lucky Charm's +10%), Titan Heart (+2 max hearts, added to Vital Core's +1). Costs in WPN-03. | Done |
| WPN-15 | **Exact slash hitbox.** The hit area of a swing is the slash polygon that is drawn, nothing more or less (`raidSlashPolyAt`: the same function builds the polygon the screen fills and the polygon the host tests), including the body pose it is drawn with (lunge, crouch, lean, hurt flinch; the idle bob of a few pixels and the local landing squash are cosmetic and not part of it) and Long Reach's scale. It can hit on every frame the slash is in view (swing timer 12 down to 3). A swing's timer is synced only every other frame and updates can arrive late or batched, so the host replays every timer value passed since it last looked at that swinger (`raidSwingSteps`) - a slash that came and went between two updates still lands, once. Parry (WPN-11) and the pogo (WPN-08) use the same polygon (the Deflector grows it about the hand). A player's `vy` is synced so the air lean is the same on every screen. | Done |
| WPN-03 | **Charms:** the optional third equip area (separate from the weapon and skin slots): items with a small persistent effect. 23 charms across all 5 rarities - see the loadout rules in WPN-13. Clicking a worn charm takes it off (the only area that can be empty); the new ten are WPN-14. | Done |

| Item | Rarity | Cost | Effect |
|------|--------|------|--------|
| Swift Boots | Common | 1 | Dash cooldown -25% |
| Lucky Charm | Common | 1 | +10% coins from every win |
| Nimble Treads | Common | 1 | +15% move speed |
| Iron Skin | Common | 1 | Half the knockback when you are hit |
| Quick Hands | Common | 1 | Sword cooldown -25% (26 to 20 frames) |
| Long Stride | Common | 1 | Dash lasts 30% longer (11 to 14 frames) |
| Reinforced Plating | Uncommon | 1 | Shield blocks 30% longer |
| Mending Charm | Uncommon | 1 | Shield recharges 50% faster |
| Pogo Spring | Uncommon | 1 | Pogo bounces 30% higher (WPN-08) |
| Deflector | Uncommon | 1 | Parries reach 40% further (WPN-11) |
| Whetstone | Uncommon | 2 | +25% sword damage (4 to 5) |
| Feather Cloak | Rare | 1 | Hold jump 30% longer for extra height |
| Long Reach | Rare | 2 | +25% sword reach (and a bigger slash) |
| Phantom Step | Rare | 2 | Dash invincibility lasts 50% longer |
| Light Step | Rare | 2 | Fall 30% more gently (gravity x0.7 while falling) |
| Opportunist | Rare | 2 | +50% damage to a stunned boss (triple instead of double) |
| Vital Core | Epic | 2 | +1 max heart |
| Thick Skin | Epic | 2 | Invincible 50% longer after you are hit (30 to 45 frames) |
| Golden Idol | Epic | 2 | +25% coins from every win (adds to Lucky Charm: both together +35%) |
| Warding Sigil | Legendary | 3 | Absorbs the first hit taken each raid |
| Second Wind | Legendary | 3 | Adds one extra jump in the air (WPN-06) |
| Spectral Familiar | Legendary | 3 | A companion that orbits you and fires at the boss for you (WPN-07) |
| Titan Heart | Legendary | 3 | +2 max hearts (adds to Vital Core) |

| ID | Requirement | Status |
|----|-------------|--------|
| WPN-06 | **Second Wind (double jump):** while airborne and holding the charm, one extra jump is available - edge-detected on the key press (not the whole time it's held) so it can't be spammed the instant it becomes eligible. Refills the moment the player lands. The air jump is a smaller hop than the first jump (85% of its launch speed, about 85 px against the first jump's 118) and holding the key does not boost it. | Done |
| WPN-07 | **Spectral Familiar (minion):** while equipped, a small companion orbits its owner and, every 90 frames, fires a weak (1 damage) aimed shot at the boss. Host-simulated and synced like a hazard; the bolt itself is resolved through the same projectile/hit pipeline as everything else - no separate collision code. Despawns the frame the charm is unequipped. | Done |
| WPN-20 | **Character redesign:** the whole player silhouette is drawn about 15% smaller, anchored at the feet so it doesn't sink into or float off the ground (the health bar above the head keeps its original size and position, unaffected by the scale-down). The face is Hollow Knight-styled: big flat black eyes and no visible mouth, with small horns instead of the old red pom-pom (a skin can still cover the horns with its own headwear via `noHorns`). | Done |

### 8.6 Sound effects

Every sound is synthesized in the browser with the Web Audio API (oscillator tones, filtered noise, and a throat-and-mouth voice model for the boss growls) - there are no audio files. `MQ_SFX_DEFS` describes the 83 sounds; the game asks for one with `sfx(name, opts)`. **No charm makes a sound** - nothing for the Warding Sigil, the Familiar, Second Wind, or equipping a charm.

| ID | Requirement | Status |
|----|-------------|--------|
| SND-01 | **The sounds.** 83 synthesized sounds in three groups: combat (5 sword swings, hit, heavy hit, blocked hit, parry, pogo, hurt, shield on/off, boss stunned, dash, jump, land, phase change, boss defeated, victory, game over, countdown tick and go), boss attacks (a **growl** and a **roar** for each of the 7 bosses; slam, swoosh, vanish, appear, swim, splash, bite, inflate, deflate, charge; a launch sound for each of the 10 shot kinds; floor hazards: marker ping, shockwave, thorn eruption, flame pillar, quake, tremor, feather strike, chain, orb charge and burst, imp), and interface (click, equip, error, buy, coins, crate shake, crate open, a reveal for each of the 5 rarities, duplicate coins, practice correct and wrong). Each renders audible, finite, unclipped audio that ends within its stated length. | Done |
| SND-02 | **Playback and settings.** Audio starts on the first click or key press (browsers keep it locked until then) and nothing plays before. A floating sound button (bottom left) opens a volume slider and a Mute box; the choice is saved in `localStorage` (`mathquest_sound_v1`) and survives a reload, volume is clamped to 0-1 and a corrupt save is ignored. A muted or zero-volume game plays nothing. Each sound has a minimum gap between plays and at most 28 sounds play at once, so a busy fight cannot pile up. Sounds can be panned (a little, never hard) by where they happen, and scaled in volume and pitch. | Done |
| SND-03 | **Combat sounds.** Every sword has its own swing sound (Training Nail a plain whoosh, Moss Blade a leafy rustle, Frostbite Edge a whoosh with icy chimes, Voidbone Fang a low wobbling drone, Dawnbreaker a whoosh with a bright shimmer) - for your own swing, and for a teammate's, which is panned to where they stand and heard once per swing at half volume. A boss hit is a normal thump, or a heavier, ringing one when it does 6+ damage (a stunned boss takes double); a hit the boss shrugs off, a parry (the parry spark, so every client hears it) and a pogo bounce each have their own sound. Getting hurt, dashing, jumping, landing (only a hard fall thumps), the shield going up and timing out, the boss being stunned, a phase change (a rumble and that boss's own roar), the boss going down with a victory fanfare, and defeat all have sounds, once each. Charms are silent (see 8.6). | Done |
| SND-04 | **Boss sounds.** Sounds are worked out each frame from the synced state every client has (the boss's animation state, its shots and hazards, the slam sparks and players' swing timers), so everyone hears the same fight, once per event, and a client that joins mid-fight does not hear a burst of old events. Every animation state a boss can enter is listed in `MQ_BOSS_SFX` with its sound or a deliberate silence, so a new move cannot ship without a sound decision (a test checks); every boss shot kind has a launch sound (`MQ_SHOT_SFX`); and every floor hazard sounds when it appears and again when its marked strike goes off (`MQ_HAZARD_SFX`), the void orb bursting when it is gone. **Each boss has its own voice**, heard at the wind-up of its attacks: Grinmaw a deep demonic growl, the Warden an eerie airy wail, the Wyrm a hissing three-throated snarl, the Glutton a wet gurgling rumble with bubbles, Bramblehide a snorting boar grunt, the Colossus a stone-grinding rumble with clanks, the Griffon a rising eagle's cry - each built from a buzzing throat tone with its own pitch, roughness and mouth shape, so no two sound alike (a test checks). A boss's own sounds are panned to where it is. | Done |
| SND-05 | **Interface sounds.** Every button click ticks. Equipping a skin or sword has its own sound (equipping a charm is silent); a refused equip (no free slot or points), a purchase you cannot afford and a crate you cannot afford sound like errors; buying an item, and the coins from a raid win, chime. Opening a crate shakes, then pops, then plays a reveal that grows with the rarity (Common one note up to Legendary five notes and a shimmer), with a coin jingle if the item was a duplicate. A practice answer dings when right and buzzes when wrong, and the raid countdown ticks twice then goes. | Done |
| SND-06 | **A calmer mix.** Frequent sounds are turned down, spaced out and given way: each sound has a level (shots 60%, markers 50%, jump and land 60%, dash 70%, clicks 60%; hits, parries and roars at full) and a minimum gap (a swing 120 ms, hurt 250 ms, a boss growl 500 ms, a marker ping 700 ms). Each has a priority - **3** hits, damage, swings, roars, victory and the interface, which always play; **2** ordinary boss moves, dropped while 4 or more sounds started in the last 300 ms; **1** background shots, markers, jumps, landings, dashes and the shield, dropped while 2 or more did - and at most 10 (14 for priority 3) sounds play at once, so a hectic fight stays readable. Landing is only heard after a fall hard enough to thump. The default volume is 40%. | Done |

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
| BOS-07 | **Every boss projectile is a lob.** Bosses throw nothing in a straight line any more: each thrown object (rubble, fire bombs, bile, seed-pods, boulders, spirits, feathers) is launched on a rise-then-fall arc of at most about 1.6 s to a landing spot, is large (radius 11 or more, so it can be parried, WPN-11) and has a marker where it will land (TER-04). Where it lands it bursts and leaves terrain behind (TER-04). All use fair hitboxes centred on the player (see RAI-05). | Done |
| BOS-08 | **Phases:** phase 2 below 60% HP, phase 3 below 30%. Each change is a 100-frame beat: the boss pulses, is invulnerable (dashed ring), the arena is cleared, and a PHASE banner plays with screen shake. New attacks unlock in phase 2. | Done |
| BOS-09 | Bosses are untargetable (swings and bolts pass through) while faded out or submerged. | Done |
| BOS-10 | Each boss has its own animations and its own arena backdrop (BKG-01); all boss animations run on the host and sync through boss state. | Done |
| BOS-11 | **Stun:** after its big moves a boss is stunned for **120 frames (2 s)** and takes **double damage**. | Done |
| BOS-12 | **Vulnerability is shown, not told.** A stunned boss tilts, sags and has dizzy stars circling its head. There is no text or icon saying "weak/exposed". | Done |
| BOS-13 | Feedback: screen shake on hits and phase changes, floating damage numbers, red flash when the local player is hit, phase notches at 60% and 30% on the boss HP bar. **Every hit on the boss** (not just the big stun) briefly shows its hurt pose and a white flash, and triggers a short hit-stop felt by every client (see RAI-19 for the player's own impact frame). | Done |
| BOS-14 | The boss HP bar is large, fixed at the top of the screen (not attached to the boss). | Done |
| BOS-43 | **Ground-anchored bosses** (Bramblehide, Colossus) sit at floor height (the bottom of their drawn silhouette, `BOSS_HURT.<boss>.bounds.y1`, rests on `raidGROUND_Y`) with only a small idle bob - no floating drift like the other bosses. A grounded player can melee them without needing to jump first. | Done |
| BOS-44 | **Bosses hover near the ground.** The five floating bosses idle low, with the BOTTOM of their drawn body at y 336 (`BOSS_FLOAT_BOTTOM_Y`; `BOSS_HOVER_Y` is derived from each silhouette, so Grinmaw's centre is 212, Warden 228, Wyrm 208, Glutton 268, Griffon 284 px from the top of the arena) instead of up near the top of the screen. With the low jump (RAI-17) a swing from the top of a small hop reaches every one of them, the top of a held jump puts a down swing (pogo, WPN-08) on them, and none of the five can be hit while standing on the floor in any direction (the highest a floor swing reaches is about y 364; the idle bob never lowers a body below ~354). The ground-anchored two (BOS-43) are unchanged. Lobbed boss shots (BOS-07) are launched on a rise-then-fall arc that peaks about 70 px above the launch point (`RAID_LOB_RISE`), so a low boss does not fling them flat through the body of the player - they only threaten near where they come down. | Done |
| BOS-45 | **Better warnings.** Every floor strike - thorn spikes, flame pillars, tremors, feather drops, the Griffon's dive spot and strafing lane, Bramblehide's charge lane - is marked by the same warning: a hatched strip exactly as wide as the hit zone with chevrons rising out of it and a faint danger column above, that brightens as the strike nears and flashes faster in its last stretch (`raidDrawGroundWarning`). Long attacks are marked from their start rather than at the last moment, and a marker never overstates the danger (nothing is drawn outside the real hit width). | Done |
| BOS-46 | **Exact boss hurt areas, and a smaller Wyrm.** Every boss's hit area is its drawn silhouette: stored as 4 px-tall bands of rectangles (`BOSS_HURT`, measured from the art at alpha >= 50% over the idle and enraged frames; rebuild with `MEASURE_HURT=<file> npx playwright test hitboxes -g measure`), placed at the boss's position and scaled with its animation scale. Gaps between parts (Colossus's arms) are not hits. A hit anywhere on the drawn body counts and nothing outside it does - the old fixed boxes missed a lot of the art (Grinmaw's lower body, the Wyrm's wings and tail, the Warden's robe). The Wyrm is drawn at 0.75x (`BOSS_BODY_SCALE`) with its heads pulled in to +-52.5 px to match. | Done |
| BOS-47 | **Bosses keep moving.** No boss stands still while it is idle (the gap between attacks): Grinmaw, the Warden, Bramblehide and the Colossus stride after the nearest player, weaving about 170 px to either side of them (1 px/frame; the Warden 0.9, Bramblehide 1.1) so they are never parked on top of anyone; the Wyrm, the Glutton and the Griffon patrol wide loops across the whole arena (out to 380, 330 and 380 px from the middle) with the floating ones always at or above their resting height (BOS-44). Several attacks also move the boss: Grinmaw withdraws into the background and comes forward again (BOS-20), the Wyrm sweeps the whole map (BOS-22), Bramblehide and the Griffon charge across it (BOS-40, BOS-42). | Done |

### 9.2 The seven bosses

| Boss | Max HP | Theme | Attacks (phase) | Stun after |
|------|--------|-------|-----------------|------------|
| **Grinmaw the Enthroned** | 150 | Red/gold throne demon | Bombardment (1): withdraws into the background (small, hazy, out of reach) and hurls rubble at every player in waves, each piece leaving a pool of lava where it lands; then strides forward and slams. Throne slam (1): rises, slams, sends two jumpable shockwaves along the floor and cracks it into two lava pits with a stone slab to hop onto over each. Minion summon (2+): hurls two imps from his hands; they land and scurry along the floor. | Slam |
| **The Chained Warden** | 165 | Purple wraith | Chain lash (1): chain flung from its hands to a floor marker (two chains in 2+); each leaves an iron post standing. Vanish strike (1): slowly fades, materialises on a floor marker, crashes down. Void orb (2+): orb grows in its hands, is thrown, hovers with growing spikes, then four spirits fall from it and leave ghost-fire. | Vanish strike |
| **Trio, the Three-Headed Wyrm** | 180 | Teal sky serpent | Fire bombs (1): the heads take turns spitting bombs that land on markers and leave burning ground. Sweep (1): flies to one edge and crosses the whole map in a diving arc, dropping bombs ahead of itself and at the players. Dive bomb (2+): flies over a target, floor shadow grows, dives and crashes, setting the floor alight. Fights over three permanent cloud platforms. | Dive bomb |
| **The Glutton** | 160 | Green swamp beast | Belch (1): inflates, lobs a glob of bile at each player that leaves a pool of mud. Chomp (1): sinks and fades, swims as a shadow, slowly surfaces on a rippling floor marker, bites, leaving mud. Flood (2+): the swamp rises in three places as slowing water, with a lily pad over two of them. Feast: periodically clamps shut and is invulnerable for a telegraphed window. | Chomp |
| **Bramblehide the Ravenous** (ground) | 170 | Orange thorned boar | Root spikes (1): a floor marker for a thicket of wide, tall thorn clumps (three, five in 2+) around every player, then they erupt. Ram charge (1): leans toward the nearest player, then its own body dashes across the arena and hits on contact; a thorn hedge shoots up where it stops. Bramble toss (2+): lobbed seed-pods that mark a thorn clump and leave a patch of thorns. | Ram charge |
| **Ironclad Colossus** (ground) | 180 | Cyan mechanical golem | Earthquake stomp (1): rises, cracks erupt from directly under its own feet, and three stone pillars shake up out of the floor. Boulder hurl (1): boulders lobbed at the players; each lands as a pillar. Seismic march (1): three tremors step toward the nearest player. Overload pulse (2+): a ground shockwave in both directions (a pillar is cover from it). | Earthquake stomp |
| **Skybound Griffon** | 165 | Gold-feathered diver | Feather toss (1): wing pull-back, then a big feather lobbed at each player that lands as an updraft. Wind dive (1): swoops over a target, plunges, crashes. Strafing run (1). Gale storm (2+): a gapped spread of five lobbed feathers, each an updraft. Feather rain (2+). Fights over two permanent cloud platforms. | Wind dive |

### 9.3 Per-boss attack requirements

Frame counts are the durations of each animation state (60 frames = 1 second).

| ID | Requirement | Status |
|----|-------------|--------|
| BOS-20 | **Grinmaw.** Bombardment: he **withdraws** into the background over 40 frames (drawn at 0.6 scale, hazy and 70 px higher, and untargetable while he is small), paces the back of the hall and **hurls rubble** in waves (at frames 20 and 100 of the hurl, three waves from phase 2: 20, 90, 160): one piece per player, thrown at where they stand (a little ahead of how they are moving), plus one at a random spot from phase 2 - each a radius-15 lob in flight for 64 frames with a landing marker (BOS-07, TER-04); it bursts (80 px) and leaves a **pool of lava** (130 px wide, 7 s). 50 frames after the last wave he **advances** over 45 frames (growing back to full size, the floor under the slam marked) and slams. Throne slam: rise 60 frames, slam 5, then two floor shockwaves (one each way, speed 2.4 + 0.3 x phase) and a stun; a jumping player is not hit; **the slam breaks the floor** into two lava pits (130 px wide, 6 s), one each side of him, with a **stone slab** (120 px wide, 100 px up) over each to hop onto (TER-02, TER-03). Minion summon (phase 2+): after 30 frames two imps are thrown from the hands, land on the floor and scurry at 1.5 px/frame; jumping clears them. | Done |
| BOS-21 | **Warden.** Chain lash: a marker on the floor, the chain lands about 62 frames later and only hurts standing players, and **an iron post** (a pillar, TER-02: 80 px wide, 100 px tall, 12 s) is left standing where it landed; one chain, two (30 frames apart) from phase 2. Vanish strike: fade 50, unseen 40, materialise 45 on a floor marker, strike (hurts within 62 px, grounded), stun, return 40. Void orb (phase 2+): grows 40 frames in the hands, thrown to a spot in the middle of the arena, hovers until frame 135, then **four spirits** (radius 11, lobbed, BOS-07) fall from the orb to floor spots 70 and 210 px either side of the spot beneath it; each bursts and leaves a patch of **ghost-fire** (90 px wide, 5 s, TER-03). | Done |
| BOS-22 | **Wyrm.** Fire bombs: the body coils, then each head in turn spits a bomb (frames 26 and 60, plus 94 from phase 2) - a radius-12 lob in flight for 60 frames to a spot within 70 px of a player; it bursts (60 px) and leaves **burning ground** (100 px wide, 5 s, TER-03). Sweep: it flies to one edge over 50 frames (its whole path is dotted across the sky), then crosses the whole map in 110 frames in a diving arc (120 px up at the edges, 270 px at the middle), dropping a bomb every 16 frames (12 from phase 2) alternately ahead of itself and at a player, then returns over 45 frames. Dive bomb (phase 2+): fly over the target 45 frames, dive 26 frames, crash (hurts within 78 px, grounded) and **set the floor alight** on both sides of the crash, stun, climb back 50. The arena has three permanent cloud platforms (TER-02). | Done |
| BOS-23 | **Glutton.** Belch: inflate 24 frames, then a glob of bile (radius 15, in flight 85 frames) at each player - plus one at a random spot from phase 2 - that bursts and leaves a pool of **mud** (170 px wide, 9 s, TER-03). Chomp: sink and fade 48, swim as a shadow 52, surface on a floor marker 40, bite (hurts within 62 px, grounded, and churns the floor into mud 150 px wide for 8 s), stun, retreat 48. Flood (phase 2+): inflate 24 frames, then the swamp rises in three of five spots (x 100, 300, 500, 700, 900): **water** 180 px wide for 8 s that slows anyone wading in it, with a **lily pad** (a platform, 110 px wide, 95 px up) over two of them. Feast: after a warning it clamps shut and is invulnerable for 80 frames; any attack ends the clamp early. | Done |
| BOS-40 | **Bramblehide.** Root spikes: 26-frame windup during which a ring closes in under every player (the lock-on), then a floor-marker `thornSpike` hazard - its own root-brown kind, not flame - for **a thicket of clumps centred on every player: three, five from phase 2**, spaced 170 px apart with a gap between them to stand in (`RAID_THORN_GAP`). Each clump is **wide and tall** (hits within 52 px, `RAID_THORN_HALF`; 110 px high, `RAID_THORN_HEIGHT` - a jump still clears it; it used to be 38 px and 68 px). The marker is shown for a full **60 frames** (`RAID_THORN_WARN`) and root tips poke up through it for the last 16 before the thorns strike for 28 frames (`RAID_THORN_ACTIVE`). Ram charge: a **45-frame** lean and paw (the whole lane it will run is marked on the floor from the first frame), then its own body dashes across the arena in **36 frames** (about 12 px/frame at most), one-hit-per-player contact damage, skids to a stop stunned - and **a thorn hedge** (a pillar, TER-02, 12 s) shoots up 150 px beside it (behind it if it has run into the wall) - then trots back toward the middle. Bramble toss (phase 2+): 24-frame windup, then a lobbed pod at each player plus one at a random spot (radius 12, BOS-07); where each lands it marks a `thornSpike` with the same 60-frame warning and leaves a **patch of thorns** (104 px wide, 6 s) that keeps hurting grounded players (TER-03). | Done |
| BOS-41 | **Colossus.** Earthquake stomp: 40-frame rise, 8-frame slam, then a dust/impact burst and a `quake` hazard erupting from directly under its own feet (not a marked spot under a distant player), then stun - and **three stone pillars** (TER-02: 80 px wide, 100 px tall, 12 s) shake up out of the floor, always at least 150 px from the golem and in different places, as cover from its shockwaves and high ground. **Boulder hurl:** 36-frame windup (a boulder is torn from the shoulder and held overhead, growing), then one big `boulder` per player (plus one at a random spot from phase 2) lobbed to where they stood (radius 14, flight 76 frames) - large, so a swing can parry or pogo it (WPN-11); where it lands it bursts and **a pillar rises** (10 s); never more than six pillars stand at once, the oldest crumbles first. **Seismic march:** 40-frame stomping windup, then three `tremor` hazards stepping 130 px apart away from the golem toward the nearest player. All three are marked at once; each erupts `RAID_TREMOR_WARN` (44) frames after its start, the three 20 frames apart, for 20 frames, hurting grounded players within 46 px (a jump or a step aside avoids it). Overload pulse (phase 2+): 34-frame windup, then a ground shockwave in both directions (reuses Grinmaw's exactly); **a pillar stops a shockwave**, so standing behind one is safe. The blue arc-discharge bolts are gone. | Done |
| BOS-42 | **Griffon.** Feather toss: 26-frame wind pull-back, then one big feather per player (plus one at a random spot from phase 2) **lobbed** to where they stood (radius 12, in flight 60 frames, BOS-07); where it lands it bursts and leaves an **updraft** (170 px wide, 5 s) - a column of rising air that lifts a held jump (TER-03) so a player can fly up to the Griffon. **Wind dive:** swoop over the target 40 frames, then **hover high with its head tipped straight down and track the target for 150 frames (2.5 s)**, following their position at up to 3.5 px/frame while a marker as wide as the crash (80 px) and a dashed sight line follow along the floor; for the last 30 frames it **locks on** (stops following, the marker flashes red, the bird shakes), then plunges 24 frames, crashes (hurts within 80 px, grounded), is stunned, soars back 50. Gale storm (phase 2+): 26-frame windup, then five lobbed feathers landing more than 100 px apart, each leaving an updraft. **Strafing run:** it flies to one edge over 60 frames (the whole floor lane is marked from the start), then sweeps the arena low (70 frames, about 13 px/frame, 85 px above the floor) hurting grounded players it touches once each - a jump clears it - then returns over 50 frames. **Feather rain (phase 2+):** 40-frame windup (it rises and flaps), then five `featherFall` columns spaced more than 100 px apart are marked; each strikes 50 frames after its start (staggered by up to 48 frames) for 14 frames as a full-height streak of feathers that hurts anyone under it, in the air or not. The arena has two permanent cloud platforms (TER-02). | Done |

### 9.4 Boss sprite sheet

| ID | Requirement | Status |
|----|-------------|--------|
| BOS-30 | Bosses are drawn from `assets/boss-sheet.webp`: 2048 x 2048, 256 px cells, 8 columns, two rows per boss (Devil King, Wyrm, Warden, Glutton in that row order), under 1.5 MB. It is built from `sprites/boss-spritesheet-v2.png` by `sprites/build-game-sheet.js` and loaded from JS (`bossSheetLoad`, called when a raid starts). | Done |
| BOS-31 | Sixteen frames per boss: idle 1-4, windup, telegraph, attack, recover, hurt, hurt recover, enraged 1-2, special, death 1-3 (death frames are in the sheet but not used yet). `bossSpriteFrame(boss)` picks the frame from synced boss state only (stun, glutton feast, phase change, `anim.state` and `anim.timer`, `raidG.frame`), so every client shows the same frame. Idle changes every 15 frames; phase 3 idle uses the enraged frames. | Done |
| BOS-32 | Attack timelines use the sheet's poses: windup, then telegraph, then attack, then recover, per the state table `BOSS_SPRITE_STATES`. Grinmaw's summon and the Glutton's clamped-shut feast use the `special` frame. Fading, hidden and submerged states keep the idle art because the game already fades or sinks the boss. | Done |
| BOS-33 | The sprite is placed so the boss position (`boss.x`, `boss.y`, the hitbox centre and projectile origin) sits on the boss's face or body, at a per-boss scale (`BOSS_SPRITE.bosses`). Hitboxes, speeds and attack timings are **not** changed by the art. | Done |
| BOS-34 | The old canvas-path boss art stays in the code as a **fallback**: it is used until the sheet has loaded, if it fails to load, or when `RAID_BOSS_SPRITES_ENABLED` is false. | Done |
| BOS-35 | Vulnerability is still shown by animation only (BOS-12): a stunned sprite boss uses the hurt frames, wobbles, sags and has circling stars. No text or icon. | Done |

### 9.5 Terrain and arena backdrops

Bosses change the arena as they fight, and every boss fights somewhere different. Terrain is a list of pieces the host builds and every client simulates (it is published with the boss state).

| ID | Requirement | Status |
|----|-------------|--------|
| TER-01 | **Terrain data.** `raidG.terrain` is a list of pieces `{id, kind, x, w, top, life, age, theme}` (`raidTerrainAdd`). The host ages them every frame and removes them when `life` runs out (`life: -1` is permanent). The list is published with the boss state and a client replaces its own copy from each snapshot. It is cleared at every phase change and when a boss arrives or the fight restarts, and the boss's **permanent** pieces come back (the Wyrm's three cloud platforms, the Griffon's two). So the floor never fills up, at most 4 lava, 4 fire, 4 thorn, 3 mud, 3 water and 6 updraft zones, and 6 pillars, stand at once - the oldest goes first. | Done |
| TER-02 | **Platforms and pillars are solid.** A *platform* (a stone slab, cloud or lily pad) can be landed on from above, jumped up through from below and walked off; a *pillar* (80 px wide, 100 px tall) is solid on every side - it blocks walking, can be stood on top of, and **stops a shockwave**. Neither is solid until it has finished rising (24 frames). A player standing on one is safe from floor hazards. | Done |
| TER-03 | **Floor zones change how you move.** *Lava*, *fire* (and the Warden's ghost-fire) and *thorns* hurt a player standing in them once they have formed (24 frames after they appear; lava and fire hurt feet on the floor, thorns feet within 36 px of it) - jumping or standing on a platform is safe. *Mud* slows a player on the floor to 45% speed and *water* to 60%. An *updraft* lifts a held jump (it never slows a rise) so you can fly. Effects stop at the zone's edge. | Done |
| TER-04 | **Thrown objects change the ground where they land.** A boss throws things with `raidThrow`: a large, parryable lob that shows a **landing marker** on the floor and, where it comes down, bursts (hurting anyone on the floor within its radius, not one in the air) and leaves terrain: rubble -> lava, bombs and spirits -> fire/ghost-fire, bile -> mud, pods -> a thorn clump and a thorn patch, boulders -> a pillar, feathers -> an updraft. An object that hits a player still bursts and leaves its terrain. Every kind of terrain is drawn, solid pieces fill their shape and zones blink before they vanish. | Done |
| BKG-01 | **Each boss has its own arena backdrop** (`raidDrawBackdrop`), drawn procedurally behind the fight: Grinmaw a candy-red throne hall (arches, banners, torches, a stained-glass window, flagstones), the Warden a chained dungeon (a rune-ringed gate, hanging chains, mist, an iron grate), the Wyrm a dusk sky above the clouds (a low sun, ridges, floating rocks, cloud banks), the Glutton a swamp (moon and fog, dead trees draped in moss, fireflies, reeds), Bramblehide a deep forest (trunks, canopy, light shafts, leaves, thorn bushes), the Colossus an iron foundry (turning gears, pipes, steam, a furnace glow, a riveted floor) and the Griffon a sunset above snowy peaks (ridges, clouds, birds, wind streaks). They are animated, are a pure function of the boss, the frame and the phase (no randomness, so a frame always looks the same) and later phases stir the scenery up (more embers, steam, leaves, wind). | Done |

## 10. Rewards, shop and cosmetics

### 10.1 Coins

| ID | Requirement | Status |
|----|-------------|--------|
| RWD-01 | Beating a boss pays coins: **Easy 60, Normal 120, Hard 250, plus 10 per heart the player has left** (max 5). | Done |
| RWD-02 | Every player in the raid is paid separately, exactly once per victory. Defeat pays nothing (except in the gauntlet, GAU-05). | Done |
| RWD-03 | The victory screen shows the coins earned, how they were calculated and the new balance. | Done |

### 10.2 Shop

| ID | Requirement | Status |
|----|-------------|--------|
| SHP-01 | The Shop has two tabs: **Crates** and **My Items**, and always shows the coin balance. | Done |
| SHP-02 | Crates, prices and loot pools (odds are the rarity weight split equally among that rarity's items in the pool): see table below. | Done |
| SHP-03 | Each crate has an **Odds** button showing every item's exact percentage, grouped by rarity with rarity totals; each crate's odds sum to 100%. | Done |
| SHP-04 | Opening a crate deducts the price, plays an animation (shake, lid pops, flash), then reveals the item with a rarity banner and confetti that scales with rarity. Insufficient coins shows a message and does nothing. | Done |
| SHP-05 | **Duplicates convert to coins:** Common 10, Uncommon 25, Rare 60, Epic 150, Legendary 350. | Done |
| SHP-06 | **My Items** shows a 3-row loadout (Player skin, Slot 1: Weapon, Slot 2: Charms (3 slots, 5 charm points)) with a still preview of the player and the equipped charms (it does not swing, and has no caption), filters (All / Player Skins / Weapons / Charms), a "hide locked" toggle, a collected counter, owned counts, locked items dimmed with their coin price on a Buy button (SHP-10), each card's blurb, and an Equip button per owned item. | Done |
| SHP-07 | One player skin and one weapon (a sword) are always equipped; the charm area is optional - up to three charms within 5 charm points (WPN-13), each taken off by clicking it again. Only owned items can be equipped; the default skin and sword are always owned. | Done |
| SHP-08 | Equipped items are used in every raid and shown to all players (skin, sword look, charm effects). | Done |
| SHP-09 | Skins are cosmetic only - no stat effects. Charms are the exception (WPN-03): they have a small real effect, but which one is purely a player choice, not tied to a skin or weapon. | Done |
| SHP-10 | **Buy a specific item.** Any skin, sword or charm you do not own can be bought outright from its card in My Items for a fixed price by rarity - **Common 400, Uncommon 900, Rare 2,200, Epic 5,000, Legendary 12,000** coins (`MQ_BUY_PRICES`), always well above the cost of a crate that can drop it (a crate is a gamble; this is a sure thing). Buying deducts the coins, adds one copy, saves the profile and refreshes the coin display; it is refused with a message when you cannot afford it, and for items you already own, the default skin and sword, and unknown ids. A purchase is not a crate and does not count towards the crates-opened stat. Bought items can be equipped like any other. | Done |

Crates:

| Crate | Price | Pool | Rarity weights |
|-------|-------|------|----------------|
| Starter Crate | 100 | Skins, swords and charms (33) | Common 64, Uncommon 27, Rare 8, Epic 1 |
| Hero Crate | 250 | Player skins only (10) | Uncommon 38, Rare 40, Epic 17, Legendary 5 |
| Arsenal Crate | 250 | Swords and charms (21) | Uncommon 38, Rare 40, Epic 17, Legendary 5 |
| Cosmic Crate | 400 | Items tagged "cosmic" (4): Astronaut, Galaxy Walker, Voidbone Fang, Dawnbreaker | Rare 60, Epic 32, Legendary 8 |
| Legend Crate | 700 | Skins, swords and charms (22) | Rare 46, Epic 39, Legendary 15 |

### 10.3 Items

Rarities: Common, Uncommon, Rare, Epic, Legendary (rarer items are drawn with more animation and glow).

| Rarity | Player skins | Swords |
|--------|--------------|--------|
| Common | Classic Cup (default), Sprout, Bubblegum, Bumblebee | Training Nail (default) |
| Uncommon | Buccaneer, Frost Sprite, Shadow Ninja | Moss Blade |
| Rare | Astronaut, Star Wizard, Robo-Bot | Frostbite Edge |
| Epic | Inferno, Galaxy Walker | Voidbone Fang (cosmic) |
| Legendary | Golden Champion, Prism Phantom | Dawnbreaker (cosmic) |

Utility items (WPN-03) aren't cosmetic and are listed in that table instead of here.

| ID | Requirement | Status |
|----|-------------|--------|
| ITM-01 | All skins and swords are drawn with canvas paths and must look polished: outlines, gradients, and animation on higher rarities (flames, sparkles, rainbow, twinkling stars). The same drawing code renders the raid, shop previews and the loadout. | Done |
| ITM-03 | Tall hats/hair must not overlap the health bar (bars are lifted per skin). | Done |
| ITM-04 | Sword skins change the blade's colors and share one swing shape (out-and-back arc with a fading crescent slash trail) - see WPN-02. | Done |

## 11. Data model (Firebase)

| Path | Purpose |
|------|---------|
| Firestore `publicSets/<id>` | Community question sets (`ownerId`, `name`, `questions`, ...). |
| RTDB `lobbies/<code>` | `name`, `hostId`, `status`, `playerCount`, `createdAt`, `bossType`, `difficulty`, `mode` (`boss` or `gauntlet`), `challenges` (gauntlet handicap ids), `raidStart`, `players`. |
| RTDB `bossRaid/<code>/gameState` | Host-published boss, projectiles, hazards, slam effects, `gameOver`, `victory`. |
| RTDB `bossRaid/<code>/players/<raidId>` | Per-player live state (position, velocity, `onGround`, health, `maxHealth`, shield, facing, `swing`/`swingTimer`/`swingDir`, skin, weapon (`gun` field - a sword id), utility (comma-separated worn charm ids), `wardUsed`). |
| RTDB `bossRaid/<code>/presence`, `mathHits` | Heartbeats and math answers (math off). Melee hits resolve straight from synced player state (WPN-02), so there is no shot relay. |
| `localStorage` `mathquest_raid_profile_v1` | `coins`, `owned` (id to count), `equipped` (skin, gun (weapon slot), utility = comma-separated worn charm ids), `stats`, `trophies` (GAU-06). |

| ID | Requirement | Status |
|----|-------------|--------|
| DAT-01 | `database.rules.json` allows public reads of `lobbies` and `bossRaid/<id>` but requires an authenticated user for writes, and denies everything else. (The rules file exists but is not deployed - see section 12.) | Done |

## 12. Known issues and decisions

- **Sword hits are judged on the host from synced state.** A teammate's slash is resolved against their synced position, direction and pose (updated roughly every 2 frames), so it can differ from their own screen by a few pixels (the idle bob, the landing squash, and a frame or two of lag). Late or batched updates no longer lose a hit (WPN-15).
- **Realtime Database rules are not deployed.** `database.rules.json` requires auth for writes, but the deploy workflow only deploys hosting, so the live database is effectively open. Deploying the rules is a separate decision.
- **Coins and items live in the browser** and can be edited by a determined player. Acceptable for cosmetics; move server-side if coins ever gain real value.
- **One pre-existing self-test fails:** "Attack timer resets after attack" (`testBossAttack`). It is unrelated to current gameplay and shows up in every console.
- Four legacy `bossRaid` nodes from an old version (`global` and three long ids) remain; current code never uses them.
- `sprites/` in the working folder is untracked dev tooling and is never deployed. It holds the v1 boss sheet, the v2 boss, player-skin sheets (and the old gun sheets, no longer relevant) (only the boss sheet is used by the game, via `assets/boss-sheet.webp`), `build-sheets.js` / `build-game-sheet.js` to regenerate them and `verify-sheets.js` to check them.
- **Sprite bosses:** drawn bigger and more detailed than the old art; their hit areas follow the drawn silhouette (BOS-46). Telegraph glows that used to be drawn inside the old boss art (throat glow, raised chain, orb) are now only in the sheet frames; floor markers and hazards are unchanged.
- The sheet's death frames are not shown on victory yet, and the player sheets are not used by the game (skins and swords are still drawn with canvas paths).
- Lobby host (creator) and raid host (simulation owner) are different concepts and can differ.
- **Old shot kinds remain in the code.** Since the boss rework (BOS-07) nothing fires candy, fangs, bolts, plumes, void shots or bubbles, but their drawing and launch sounds are still there (and the 83-sound count in SND-01 includes them). Remove them in a later clean-up.
- **Boss rework balance** is untuned: how long pools and pillars last, how many a phase raises and how fast the bosses stride were set by feel and checked against a scripted dodging player (BOS-03), not by playtesting.
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
| 2026-09 | Hollow Knight-style controls (Z jump, X attack, C dash; RAI-10, RAI-16); variable-height jump (RAI-17); impact frames on every hit - knockback, flash and hit-stop for the player (RAI-19) and hurt pose/flash/hit-stop for the boss (BOS-13); per-boss hit area, fixing the Wyrm's undersized one (RAI-18). |
| 2026-09 | Fixed the dash burst being clamped away almost immediately (RAI-16); added a weapon slot (guns or swords, WPN-01/WPN-02) and a utility slot with 6 effects (WPN-03), 5 new swords and 6 new utility items, obtainable from the Starter/Arsenal/Legend crates (SHP-02/06/07); character redesign - ~15% smaller, Hollow Knight-style face and horns (WPN-20) - plus idle/run movement animation (RAI-20). |
| 2026-09 | Fixed player invincibility (RAI-11) not being enforced synchronously: `raidDamagePlayer` now mutates the player object immediately instead of only firing an async Firebase write, closing a same-frame/round-trip window where two hazards or projectiles overlapping the same player could both land. |
| 2026-09 | Reworked sword combat to be hitbox-accurate (WPN-02): swings now damage the boss only on real per-frame overlap between a direction-aware hitbox and the boss's actual hit area, instead of a one-time reach check snapped onto the boss's coordinates. Added Up/Down directional swings (WPN-05) and a white slash trail regardless of the sword's own color (WPN-04), matching Hollow Knight's nail slash. |
| 2026-09 | Added 3 bosses (BOS-40 to BOS-43): Bramblehide the Ravenous and Ironclad Colossus, the first two ground-anchored bosses (meleeable/shootable without jumping), and the airborne Skybound Griffon - seven bosses total. |
| 2026-09 | Added 10 charms (WPN-03), 16 total: move speed, knockback resistance, longer/faster-recharging shields, longer sword reach and bullet range, longer dash invincibility, a bigger magazine, a faster reload, a double jump (WPN-06) and a Spectral Familiar minion companion (WPN-07). Arsenal Crate now also drops utility items. |
| 2026-09 | Reworked Bramblehide's charge (BOS-40) into a real body dash - the boar's own x now crosses the arena and hits on contact, instead of standing still and spawning a stationary shockwave hazard (which played identically to Grinmaw's slam and Colossus's Overload Pulse). Reworked Colossus's Piston Slam into an Earthquake Stomp (BOS-41): the ground now cracks from directly under its own feet instead of a flame pillar erupting at a distant marked spot with no visible source. Bramblehide's Root Spikes and Bramble Toss now erupt their own `thornSpike` hazard (root-brown) instead of reusing the Wyrm's flame `pillar`. Visual polish pass on all 3 new bosses (secondary silhouette detail, shading, environment props) to match the original four. |
| 2026-09 | Extended directional swings (WPN-05) from 3-way (up/down/side) to full 8-way, aimed in absolute world-space from whichever movement keys are held (not facing-relative). Added a Hollow Knight-style pogo bounce (WPN-08): a connecting airborne down-swing bounces the player upward, resolved purely client-side so it's instant and host/non-host identical, without duplicating boss damage. Added expressive movement animation (RAI-21): landing/launch squash-stretch, an air-pose lean driven by vertical speed, a swing follow-through body lean, and dash afterimages that replay the player's real motion pose instead of a forced idle stance. |
| 2026-10 | Placeholder attack and damage/impact animations, all original (the game cannot ship Hollow Knight's own frames - that art is Team Cherry's): an attack pose with anticipation, strike lunge and recovery (RAI-22), a hurt pose that flinches and eases out plus a hit burst on the local player (RAI-23), and a directional white slash-impact on the boss for sword hits (WPN-09). |
| 2026-10 | Made the sword swing reach far (WPN-10): every swing hitbox is about 1.6x larger, and the live player now draws a big white crescent slash, sized to that reach, instead of only a small arc around the blade. |
| 2026-10 | Made the slash crescent very curved (about 300 degrees round the player) and removed the old sweeping-blade and small-trail swing animation from the live game (WPN-10); only the shop preview keeps its small swing. |
| 2026-10 | Reshaped the slash (WPN-10): a forward arc that no longer surrounds the player, sweeping top to bottom and narrowing at its farthest point. |
| 2026-10 | Compressed the slash vertically (WPN-10): its top and bottom ends are closer together, and the side swing hitbox is shorter to match what is drawn. |
| 2026-10 | Gave the up and down slashes the same vertical compression as the side slash (WPN-10): a wide, low arc over/under the player, with the up/down hitbox reshaped to match (90 px reach, 140 px half-wide). |
| 2026-10 | Reverted the up/down slash to the side slash rotated a quarter turn (WPN-10): left, right, up and down now all have the same shape and the same reach (130 px out, 85 px either side), so the player always has the same reach whichever way they swing. |
| 2026-10 | Made every slash smaller (WPN-10): the swing reach is now 100 px (62 px either side), diagonals 80 px, and the drawn slash radius 115 px. Split jump from aiming (RAI-10): Z is the only jump key; Up only aims the sword upward and never makes the player jump. |
| 2026-10 | Movement retune (RAI-16, RAI-17, WPN-06): a much lower jump (tap ~100 px, hold ~150 px), slower running, a dash that goes a little farther (154 px) and keeps your height (no gravity while it lasts), and a double jump that hops less far than the first jump. Nimble Treads now genuinely speeds up running (it used to only raise a speed cap that running never reached). |
| 2026-10 | Moved the five floating bosses down near the ground (BOS-44) so a small hop reaches them and a held jump lets you pogo them, and gave lobbed boss shots a proper rise-then-fall arc so a low boss does not fling them flat at body height. |
| 2026-10 | **Removed all guns and everything related to them** (RAI-03, RAI-12, RAI-13, RAI-14, ITM-02 are gone, WPN-01 rewritten): no shooting, ammo, reloading, reload HUD/ring, bullets, non-host shot relay (`shots` node), the 14 gun skins and the three gun-only charms (Quick Hands, Extended Mag, Overclock Coil - 13 charms remain). The sword is the only weapon, a fresh save equips the Training Nail, and old saves drop their guns and fall back to it. Item total 49 to 32; crate pools are now Starter 24, Hero 10, Arsenal 13, Cosmic 4 (Dawnbreaker took over as the cosmic legendary), Legend 17. The Spectral Familiar keeps its own bolt, now drawn by a small dedicated orb. |
| 2026-10 | **Every boss projectile can now be parried** (WPN-11): a swing's blade destroys any shot it touches, lobbed ones included (no pillar or thorn spike afterwards), with a ring-and-glint spark and a short hit-stop. |
| 2026-10 | **Every charm now has its own animation** (WPN-12): an aura on the wearer and an animated glyph in its shop icon. |
| 2026-10 | **Smoother animation** (RAI-24): teammates, their swings, and (for non-hosts) the boss and its shots now glide between network updates instead of stepping. |
| 2026-10 | Lighter gravity (RAI-17): the lowered jump had kept the old fall speed, so falling felt far too heavy. Gravity is now 0.25 (was 0.4) with the launch speed and hold scaled to match, so jump heights are unchanged (tap ~100 px, hold ~145 px) but the hop hangs longer and falls gently. The pogo bounce was retuned to match (WPN-08). |


| 2026-10 | A little more jump height (RAI-17): launch speed -7.7 (was -7), so a tap rises about 120 px (was 100) and a held jump about 170 px (was 145). Gravity unchanged. |
| 2026-10 | Parry and pogo now only work on the **large** boss shots (WPN-11, WPN-08): candy, embers and bubbles, which are drawn with a white ring; small shots and shockwaves must be dodged. A downward air-swing can also bounce off a large shot. |
| 2026-10 | **Better boss warnings and new moves** (BOS-40, BOS-41, BOS-42, BOS-45): every floor strike now uses one clear, flashing hit-width marker; Bramblehide's thorns warn for 60 frames (was 32) with a lock-on ring and rumbling tips, and its charge is marked, has a longer windup and runs about half as fast; the Griffon's wind dive now hovers high looking straight down and tracks its target for 2.5 s before locking on and diving. New moves: Colossus boulder hurl (large, parryable) and seismic march (phase 2+); Griffon strafing run and feather rain (phase 2+). |
| 2026-10 | **Ten new charms and a charm loadout** (WPN-03, WPN-13, WPN-14): charms now cost 1-3 charm points; wear up to three at once as long as their points add up to 5 or less. New charms: Quick Hands, Long Stride, Pogo Spring, Deflector, Whetstone, Light Step, Opportunist, Thick Skin, Golden Idol and Titan Heart, each with its own animation (23 charms in all; crate pools grew to Starter 33, Arsenal 21, Legend 22). |
| 2026-10 | **Co-op fixes and a fullscreen battle** (RAI-11, RAI-25, RAI-26, RAI-27, LOB-12): hits on a non-host player now stick (the host used to overwrite their health, so only the host got hurt and teammates healed straight back), a player going down no longer defeats the whole lobby (only everyone down does) and survivors keep fighting, leaving a lobby by any sidebar button or by closing the tab removes you and deletes an emptied lobby, and the battle fills the whole window. |
| 2026-10 | **The Gauntlet, challenges and trophies** (GAU-01 to GAU-06): a mode where all seven bosses come in a row with a 5 s rest between them that heals by difficulty (Easy full, Normal 3 hearts, Hard 1) and revives downed players; six optional challenges (Fragile, No Shield, No Dash, Frenzy, Titan Bosses, No Healing) that raise the coin payout; difficulty trophies and challenge trophies for a clear, shown in a trophy case on the Raid page. |
| 2026-10 | **Exact hitboxes, a higher Second Wind and a smaller Wyrm** (WPN-15, BOS-46, WPN-06): the slash now hits exactly where it is drawn (before, the hit box was about 25 px shorter than the drawn crescent and only checked for 5 frames, so a slash could visibly touch the boss and do nothing; late updates could skip the window entirely), bosses are hit anywhere their art is drawn (the old fixed boxes covered only part of it), floating bosses were re-hung by their silhouette bottoms so they still need a jump, the Second Wind hop is 85% of a first jump (was 70%), and the Wyrm is 0.75x its old size. |
| 2026-10 | **Minimal charm badges, sword slash styles, no swinging preview, buying items** (WPN-12, WPN-04, SHP-06, SHP-10): each charm is now one tiny badge in a column behind the player instead of a full aura, so three charms stay tidy; every sword has its own slash colours and effect (Moss leaves, Frostbite shards, Voidbone wisps, Dawnbreaker rays); the My Items preview stands still; and any skin, sword or charm can be bought outright for coins (Common 400 up to Legendary 12,000). |
| 2026-10 | **Sound effects for everything** (SND-01 to SND-05): 78 sounds synthesized with the Web Audio API (no audio files), led by combat - a different swing sound for each sword, hits, heavy hits, parries, pogo, getting hurt, dash, jump and land - plus every boss windup, move, shot and floor hazard, the shop and crate reveals, practice answers and the countdown. A floating button sets volume and mute and remembers it. |
| 2026-10 | **Calmer sounds, boss growls, silent charms** (SND-01 to SND-06): charms no longer make any sound; each boss now has its own growl at its wind-ups and a roar at a phase change (deep demonic, eerie wail, hissing snarl, gurgle, boar grunt, stone rumble, eagle cry); and the mix is calmer - quieter and spaced-out frequent sounds, a priority system that thins out background sounds when it is busy, teammates' swings at half volume, only hard landings thump, default volume 40%. |
| 2026-10 | **Boss rework: bosses move, attacks reshape the arena, new backdrops** (BOS-07, BOS-20 to BOS-23, BOS-40 to BOS-42, BOS-47, TER-01 to TER-04, BKG-01, WPN-11): the bosses no longer stand still while you hit them or spit random projectiles. Grinmaw withdraws into the background to hurl rubble (leaving lava) and then comes forward to slam (breaking the floor into lava pits with slabs); the Wyrm swoops across the whole map dropping fire bombs; the Colossus's stomp raises stone pillars (its blue bolts are gone) and its boulders land as pillars; Bramblehide's thorns are bigger and come in thickets (3, 5 in phase 2) and its charge leaves a thorn hedge; the Glutton's bubbles are bile that leaves mud and its bubble fan is a flood (water and lily pads); the Warden's chains leave iron posts and its void orb drops spirits that leave ghost-fire; the Griffon's feathers land as updrafts and it fights over cloud platforms. Every aimed shot is gone: bosses only lob big, parryable objects. A terrain system (platforms, pillars, lava, fire, thorns, mud, water, updrafts) is synced from the host, and each boss has its own animated arena backdrop. Idle bosses patrol or stride after the nearest player. |







