# Twitch Drop Auto-Claimer

A Firefox extension that automatically claims Twitch Drops. It watches for
"Claim" buttons anywhere on twitch.tv and clicks them, keeps the Drops
inventory page fresh so newly-available claims show up, and can optionally
drive its own background tabs to a live channel for games you list so their
watch-time drops accrue without you having to sit and watch.

## What it does

**Claiming.** A content script scans every twitch.tv page every 15 seconds
for known claim-button selectors (inventory page, stream-corner drop
notification, chat callout) plus a generic text-match fallback ("Claim",
"Claim Reward", Thai equivalents, etc.), and clicks whatever it finds
(debounced to one click per 5s). Every claim is recorded to
`browser.storage.local` so the popup can show the most recent one.

**Inventory upkeep.** Twitch's inventory page doesn't always reflect newly
completed drops without a reload. The background script keeps one pinned,
inactive inventory tab open and reloads it every 15 minutes, plus shortly
after any drop is claimed elsewhere.

**Auto-watch.** Given a priority-ordered list of games (set in the popup),
the background script opens one muted, inactive, lowest-quality tab per
eligible game — up to a configurable quota (default 3) — each pointed at
that game's live channel with the fewest viewers. Games beyond the quota
queue up. A game's tab closes itself the moment that game is fully claimed,
its campaign expires, or the game is invalid/removed, without touching the
other tabs.

A list line starting with `@` (e.g. `@somestreamer`) pins that exact
channel instead of a game - its tab goes straight to that channel (never
the directory's auto-pick), waits for it to go live rather than rotating to
another channel if it's offline, and is never rotated/blocklisted for
stalled drop progress the way an auto-picked channel would be. It shares
the same priority-ordered list and tab quota as game entries. Once the
channel is live, the background script binds it to whatever game it's
actually playing (read from the channel page's own category link) and
tracks/claims progress for it exactly like a typed game entry from then on;
switching games later re-binds automatically.

Two priority modes decide which queued games get a tab first
when the list is longer than the quota: list order, or soonest-campaign-
expiry-first (using Twitch's own campaign end date, known for every game
that has an open campaign; falls closed to list order otherwise). Once
every listed game is done, all watch tabs close and the toolbar badge
shows a checkmark.

**Matching a game to Twitch.** When you type a game name, the background
script checks Twitch's "All Campaigns" page (`ViewerDropsDashboard`
GraphQL, captured from a transient background tab) and:

- resolves the typed name to Twitch's own game name and directory-category
  slug (via an alias table, an id→slug map learned passively from the
  sidebar, or — as a last resort for a renamed game — Twitch's search
  results, which is then cached so it's a one-time cost);
- tells you in the popup whether that game has an **open drop campaign**
  right now, when it ends, and whether your account is linked;
- skips a game with no open campaign from auto-watch (with a badge saying
  so) instead of parking a dead tab on it — you can also set a manual
  "start watching from &lt;date&gt;" for a campaign that's announced but
  not open yet.

The snapshot refreshes on every save, on enable, and roughly every 45
minutes; a "check now" button forces it.

**Drop-status verification (fake-category detection).** A directory can
list a channel that isn't actually broadcasting with the target game's
drop campaign attached, so watching it never accrues progress. Shortly
after a watch tab picks a channel, the background script cross-checks the
game's campaign progress scraped from the always-open inventory tab and
rotates the tab to a different channel if the numbers haven't moved.
Separately, the watch tab's own content script re-checks every 60s whether
the channel is still live (against selectors verified against Twitch's real
channel-page markup) and bounces itself back to the directory the moment
it looks offline or was raided away.

**Master on/off switch.** A single `enabled` flag in
`browser.storage.local`, toggled from the popup, gates everything above —
when off, no timer fires, no tab opens or reloads, no click happens. The
toolbar badge reflects the current state (`OFF`, running, or `✓` when all
drops are collected). An optional auto-off toggle flips the master switch
off automatically once every game in the list is done (fully claimed /
expired / no open campaign) — nothing left for it to do until you change
the list.

**Popup language.** The popup has a language picker (top of the panel)
with nine languages — Thai, English, Simplified Chinese, Japanese, Korean,
Russian, French, Portuguese, Traditional Chinese (Taiwan). The choice is
stored in `browser.storage.local` (`uiLang`); when unset it follows the
browser's own language, falling back to English. The toolbar tooltip is
localized too.

## Known limitation: sleep prevention

Firefox extensions have no working way to keep the machine awake while
auto-watch tabs run: `browser.power` doesn't exist in Firefox, and the
Screen Wake Lock API rejects (`NotAllowedError`) on a tab that was created
inactive, which is how every auto-watch tab is created. There is no
programmatic workaround for this. Instead, whenever auto-watch has a tab
open, the popup shows a collapsible warning with the manual Windows
power-settings steps (and a `powercfg` one-liner) to disable sleep so
watch-time keeps accruing.

## Known limitation: screen turns off, drop progress stops (even with the PC not asleep)

Turning the monitor off via Windows' own idle timer (Settings → "Turn off
screen after") is not the same as the PC sleeping - the CPU keeps running -
but it can still stall Twitch's own video playback in a background tab,
which stops drop watch-time from accruing. Two separate causes were
confirmed live (2026-09-04):

1. Firefox's window-occlusion tracking listens to the real display power
   state directly (not just "is this tab visible"). When the monitor turns
   off, Firefox can mark every window as occluded even though nothing
   actually slept, which can suspend already-playing background video
   after a short delay.
2. Independently of that, Twitch's own player sometimes never starts video
   at all in a tab that was created in the background and never once
   became the active tab of its window - on some channels, not others,
   with no console error.

What this extension does about both, as of the version that added this
section: every watch tab now opens in its own dedicated Firefox window
(never the window you're actually using, so this never interrupts YouTube
or anything else you have open) and is briefly made the active tab of
*that* window for a few seconds right after a channel is picked, which is
what reliably gets Twitch's player to actually start. Separately, if every
currently-watched channel stalls in the same check (a system-wide cause
like this, rather than one bad channel), the extension no longer rotates
any of them away - only a channel that's stalled while others are
progressing normally gets treated as actually dead.

That fixes the "never starts at all" cause. It does **not** and cannot fix
cause 1 (the occlusion-tracking/background-video-suspend behavior) -
that's inside Firefox itself, and WebExtensions have no permission to
change `about:config`. If drop progress still stalls specifically while the
screen is off, try, in this order, in `about:config` in the Firefox profile
you actually browse with (restart Firefox after changing any of these):

1. `widget.windows.window_occlusion_tracking.enabled` → `false` (main
   suspect - stops Firefox from treating an off display as every window
   being occluded)
2. `media.suspend-bkgnd-video.enabled` → `false` (the background-video-
   suspend behavior itself, in case #1 alone isn't enough - its delay is
   `media.suspend-bkgnd-video.delay-ms`, a few seconds by default)
3. `network.http.throttle.enable` → `false` (background-tab network
   throttling, if 1-2 still aren't enough)
4. `dom.ipc.processPriorityManager.backgroundUsesEcoQoS` → `false`
   (Windows 11's per-process "Efficiency Mode" throttling for background
   content processes, Firefox 108+ - confirmed live over three separate
   13-minute runs to prevent the freeze on its own even without 1-3)

Or skip prefs entirely: `powercfg /change monitor-timeout-ac 0` (disables
Windows' own idle-driven display-off) and turn the monitor off yourself via
its own physical power button/input-source switch instead - Windows still
reports the display "on" internally that way, so nothing (Firefox's
occlusion tracker included) ever sees a display-off event.

## Install (development)

1. Install dependencies: `npm install`
2. In Firefox, go to `about:debugging` → "This Firefox" → "Load Temporary
   Add-on…" and select `manifest.json`, or run it through `web-ext`:
   `npx web-ext run`

## Development rule: no live tests with real cookies

**Never run live tests with a copy of a real user's cookies or profile** - not
through `web-ext run`, not over the Firefox remote-debugging protocol, not with
a copied `cookies.sqlite`. Automated/debugged Firefox sessions may carry
signals Twitch can use to flag a session (suspected, not proven), and a flagged
session loses Drops for the account (seen 2026-09-30: `failed integrity check`
on every Drops-only operation until the twitch.tv cookies were cleared and the
user logged in again). If live testing is needed, use a **separate Twitch test account** in a
fresh profile - never someone's real one. Everything the extension does can be
checked with the fake-DOM / fake-clock tests below.

## Permissions

`alarms`, `tabs`, `storage`, `downloads`, and host access to
`*://*.twitch.tv/*` — used respectively for the periodic reload / auto-watch
timers, opening and managing background tabs (watch tabs plus a transient
`/search` tab it opens and closes on its own),
persisting settings/state, writing the local debug log file below, and
running the content script plus reading tab URLs on Twitch only.

There's also host access to the bug-report relay's address (see "Sending it
to the developer" below) - used only for the explicit "Send bug report"
button, never anything else.

## Debug log — what it stores, and where it goes

A ring buffer (last 1000 lines) of this extension's own internal log lines:
Twitch channel/streamer names and game slugs it watched or rejected,
timestamps, drop-campaign progress numbers (claimed/total, minutes
remaining), and its own decisions (e.g. `channel X unusable (offline)`,
`rejected`, `re-picked`). It never contains your Twitch username/email,
password, session cookie, or any OAuth/auth token — nothing in the code
that builds these lines reads that data in the first place.

**The automatic local copy never leaves your computer.** It's written to
`twitch-drop-claimer-debug.log`, via Firefox's own downloads API to
whatever folder Firefox is configured to save downloads to, automatically
and throttled to at most once every 5 minutes right after auto-watch drops
a channel (offline, switched game, or failed drop-progress verification) -
so a diagnosis has something to look at without needing anything exported
at exactly the right moment. Nothing is uploaded, and Claude/Anthropic/any
other party never receives it.

**Sending it to the developer.** A button in the popup ("Send bug report")
sends this same log text to a small relay the developer runs, which files
it as a GitHub issue on this project and reports back the issue's link -
one click, nothing saved locally, no GitHub account needed. This is the one
case where this extension does talk to a server: only when you press this specific
button, carrying only the log text above (same content, same guarantees -
never your Twitch login/session/tokens) plus the extension version and UI
language. The relay holds no data about you beyond that one request; it
exists solely to create the GitHub issue without shipping a GitHub write
token inside this extension's own public source.

## Testing

The `test/*.test.js` files are Node-based tests that exercise the real
`background.js` / `content.js` / `inject.js` / `shared.js` logic against a
stubbed `browser.*` API (tabs registry, storage, alarms) or a jsdom DOM —
no browser required. Run one with `node test/<file>.js`.

They cover: no timer/tab/click activity of any kind once `enabled` is
switched off (and no leaked activity from callbacks already in flight);
the auto-watch scheduler's tab-per-game accounting / quota / priority
ordering; completion-based auto-off; the fake-category verification and the
tab-etiquette audit for every `tabs.create` / `tabs.update` call
(`active: false` always, never `windows.update(focused: true)`); the
open-campaign extractor and game-name matcher; skipping games with no open
campaign and the manual wait-until date; wrong-slug resolution via search;
the inventory campaign-progress parser against a real captured DOM; the
channel-page live/offline and unknown-category detection against real
captured DOM; and the popup i18n string tables (key parity across all
languages, locale resolution, and that every key referenced in
`popup.html` / `popup.js` / `background.js` exists).

## AMO submission workflow

`scripts/submit-amo.js` runs a bump → lint → build → sign pipeline against
[addons.mozilla.org](https://addons.mozilla.org) using `web-ext`.

```
npm run submit:dry       # dry run, no upload
npm run submit           # submit to the unlisted (self-distribution) channel
npm run submit:listed    # submit to the public listed channel
```

Credentials are read from the environment only, never hardcoded:
`AMO_JWT_ISSUER` / `AMO_JWT_SECRET` (preferred), or `WEB_EXT_API_KEY` /
`WEB_EXT_API_SECRET` as a fallback matching `web-ext`'s own flag names. All
script output is redacted for any env var named `*SECRET*`/`*KEY*`/`*TOKEN*`.
Listed submissions also read license/category metadata from
`scripts/amo-metadata.json`. Each successful submission is appended to
`.amo-submitted-versions.json` (untracked, local-only) as a ledger.

## Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V2, Firefox) |
| `background.js` | Alarms, inventory reload, auto-watch tab orchestration, open-campaign snapshot + name/slug resolution, drop-status verification, completion-based auto-off, badge |
| `content.js` | Claim-button scanning/clicking, directory/channel picking for watch tabs, channel live/offline check, unknown-category detection, `/search` slug scrape, inventory progress parsing |
| `gql-bridge.js` | `document_start` content script that injects `inject.js` and relays its signals to `background.js` |
| `inject.js` | Page-world script that passively observes Twitch's GraphQL traffic — game id↔name↔slug, campaign progress, and the full open-campaign list (`ViewerDropsDashboard`) |
| `shared.js` | Helpers shared between background and content scripts (slugs + aliases, channel/directory/search URL parsing, game-name → open-campaign matching) |
| `i18n.js` | Popup UI string tables (9 languages) + lookup/resolve/apply helpers; loaded in the popup and as a background script |
| `popup.html` / `popup.js` | Settings UI: language picker, on/off switch, watch list with per-game campaign status and a "watch from" picker (inline month calendar for the date, shown DD/MM/YYYY, plus a typed HH:MM field), auto-watch / tab quota / priority mode, completion-based auto-off, "check All Campaigns now", sleep warning |
| `scripts/submit-amo.js` | AMO submission pipeline |
| `test/` | Node-based tests against a stubbed `browser.*` API / jsdom |

## Changelog

### 0.6.5

- **"Watch from" picker: a real calendar for the date, a typed field for
  the time.** The five `<select>` dropdowns from 0.6.3 became an inline
  month-grid calendar (click a day; it's ordinary in-flow popup DOM, so it
  can't render behind the popup the way the native `<input type="date">`
  panel did) shown as `DD/MM/YYYY`, plus a free-text time field that
  accepts 24-hour (`14:30`, `1430`) or 12-hour (`2:30pm`, `2pm`) and
  echoes back the parsed 24-hour form. Blank time = midnight; an
  unparseable time turns the field red and isn't saved.
- **Fix: a lone finished/expired campaign was never detected as done.**
  Once every other tracked game's drops were claimed or expired, the
  `/drops/inventory` page shows a single "In Progress" card, and
  `findCampaignCardBoundary` (which delimits a card by finding a sibling
  card) then returned a too-small element with no progress bars on
  Twitch's real deep DOM — so the last game read as `total: 0` and could
  never be marked complete. Its watch tab, and the whole run
  (`watchPhase` → `all-done` → auto-off, and the inventory/campaigns
  helper tabs), never ended. Added a fallback boundary (first ancestor
  that also encloses a reward-tier progress bar) and a guard so a
  no-signal parse can't overwrite a good earlier reading with zeros.

### 0.6.3

- **Per-game "watch from" picker is popup-safe and takes a time of day.**
  Firefox mispositions / hides the native `<input type="date">` calendar
  panel inside a `browser_action` popup (it opened behind the popup), so
  the picker is now built from plain `<select>` dropdowns, which work in a
  popup. It also carries an hour:minute now, so auto-watch can start a game
  right when a drop is released rather than at local midnight. The stored
  value is a full timestamp; `background.js` already compared it as a
  number, so no scheduler change.

### 0.6.2

- **Popup language switcher.** A language picker at the top of the popup
  with nine languages (Thai, English, Simplified Chinese, Japanese,
  Korean, Russian, French, Portuguese, Traditional Chinese / Taiwan). The
  choice is stored as `uiLang`; unset follows the browser language and
  falls back to English. All popup text and the toolbar tooltip are
  localized. New `i18n.js` string tables + helpers, new `test/i18n.test.js`.

### 0.6.1

- Removed the GQL/DOM debug instrumentation that shipped in 0.6.0: the
  "Debug: log GQL operations" popup toggle and its `debugGql` flag, the
  `[gql-debug]` / `[dom-debug]` logging in `background.js`, and the
  unconditional per-operation `opSeen` / `install` / `rawOp` messages
  `inject.js` posted on every Twitch page. The functional GraphQL
  extractors (game id↔name↔slug, open-campaign snapshot) and the
  unconditional `BUILD_MARKER` / `[verify]` operational logging are
  unchanged.

### 0.6.0

- **Open-campaign check.** Typing a game now resolves to Twitch's own game
  name + directory slug, shows whether it has an open drop campaign (and
  when it ends / whether your account is linked), and skips games with no
  open campaign from auto-watch. A per-game "start watching from &lt;date&gt;"
  picker gates a game until an announced-but-not-open campaign begins.
- **Permanent slug fix.** A game whose Twitch display name no longer
  matches its category slug (e.g. "Rainbow Six Siege" →
  `tom-clancys-rainbow-six-siege`) is now resolved from an alias table, an
  id→slug map learned from sidebar GraphQL, or — failing both — Twitch's
  search results, then cached so it's a one-time cost. A slug that renders
  a blank category page is detected and resolved instead of sitting in a
  "nobody's live" cooldown forever.
- **`looksLive()` / `looksOffline()` verified.** The channel-page
  live/offline check now uses `.channel-root` state selectors verified
  against Twitch's real markup; the stale `.channel-status-info--offline`
  selector is gone.
- **Auto-off is completion-based**, not a timer: with the toggle on, the
  master switch flips off the moment every listed game is done. The hours
  input is removed.
- **Priority "soonest expiry first"** now orders on Twitch's own campaign
  end date (known for every game with an open campaign), not just the
  subset whose inventory card had a parseable date.
- Inventory parser re-verified against current markup; `extractExpiresAt()`
  learned the real "End Date: …" format.
