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
expiry-first (fails closed to list order if an expiry date can't be
parsed). Once every listed game is done, all watch tabs close and the
toolbar badge shows a checkmark.

**Drop-status verification (fake-category detection).** A directory can
list a channel that isn't actually broadcasting with the target game's
drop campaign attached, so watching it never accrues progress. Shortly
after a watch tab picks a channel, the background script cross-checks it
against two signals passively observed from Twitch's own GraphQL traffic
(via `gql-bridge.js`/`inject.js`, never issuing a request of its own): does
this exact channel have the campaign attached at all, and has
account-wide minutes-watched for it moved since the channel was picked. If
neither holds after a short grace period, the tab is rotated back to the
directory and that channel is put on a cooldown so it isn't immediately
re-picked, while the rest of the eligible channels are unaffected.

**Master on/off switch.** A single `enabled` flag in
`browser.storage.local`, toggled from the popup or an optional
auto-off timer (default 3h, configurable 1–72h), gates everything above —
when off, no timer fires, no tab opens or reloads, no click happens. The
toolbar badge reflects the current state (`OFF`, running, or `✓` when all
drops are collected).

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
respectively for the periodic reload/auto-watch/auto-off timers, opening
and managing background tabs, persisting settings/state, and running the
content script plus reading tab URLs on Twitch only.

## Testing

`test/toggle-behavior.test.js`, `test/auto-watch-multi-tab.test.js`, and
`test/drop-verification.test.js` are Node-based tests that exercise the
real `background.js`/`content.js` logic against a stubbed `browser.*` API
(tabs registry, storage, alarms) — no browser required. Run with
`node test/<file>.js`.

They cover: no timer/tab/click activity of any kind once `enabled` is
switched off (and no leaked activity from callbacks already in flight),
the auto-watch scheduler's tab-per-game accounting/quota/priority
ordering, and the fake-category verification's two signal paths plus the
tab-etiquette audit for every `tabs.create`/`tabs.update` call
(`active: false` always, never `windows.update(focused: true)`).

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
| `background.js` | Alarms, inventory reload, auto-watch tab orchestration, drop-status verification, badge |
| `content.js` | Claim-button scanning/clicking, directory/channel picking for watch tabs, inventory progress parsing |
| `gql-bridge.js` | `document_start` content script that injects `inject.js` and relays its signals to `background.js` |
| `inject.js` | Page-world script that passively observes Twitch's GraphQL traffic for drop-campaign/minutes-watched signals |
| `shared.js` | Helpers shared between background and content scripts (slugs, channel/directory URL parsing) |
| `popup.html` / `popup.js` | Settings UI: on/off switch, watch list, auto-watch/tab quota/priority mode, auto-off timer, sleep warning |
| `scripts/submit-amo.js` | AMO submission pipeline |
| `test/` | Node-based tests against a stubbed `browser.*` API |
