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
other tabs. Two priority modes decide which queued games get a tab first
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

## Known limitation: sleep prevention

Firefox extensions have no working way to keep the machine awake while
auto-watch tabs run: `browser.power` doesn't exist in Firefox, and the
Screen Wake Lock API rejects (`NotAllowedError`) on a tab that was created
inactive, which is how every auto-watch tab is created. There is no
programmatic workaround for this. Instead, whenever auto-watch has a tab
open, the popup shows a collapsible warning with the manual Windows
power-settings steps (and a `powercfg` one-liner) to disable sleep so
watch-time keeps accruing.

## Install (development)

1. Install dependencies: `npm install`
2. In Firefox, go to `about:debugging` → "This Firefox" → "Load Temporary
   Add-on…" and select `manifest.json`, or run it through `web-ext`:
   `npx web-ext run`

## Permissions

`alarms`, `tabs`, `storage`, and host access to `*://*.twitch.tv/*` — used
respectively for the periodic reload / auto-watch timers, opening and
managing background tabs (watch tabs plus transient `/drops/campaigns` and
`/search` tabs it opens and closes on its own), persisting settings/state,
and running the content script plus reading tab URLs on Twitch only.

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
the inventory campaign-progress parser against a real captured DOM; and the
channel-page live/offline and unknown-category detection against real
captured DOM.

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
| `popup.html` / `popup.js` | Settings UI: on/off switch, watch list with per-game campaign status and a "start from date" picker, auto-watch / tab quota / priority mode, completion-based auto-off, "check All Campaigns now", sleep warning |
| `scripts/submit-amo.js` | AMO submission pipeline |
| `test/` | Node-based tests against a stubbed `browser.*` API / jsdom |

## Changelog

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
