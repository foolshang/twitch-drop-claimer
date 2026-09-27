# History

Chronological log of notable problems found and how they were fixed.

## 2026-08-13 — Initial build

Built the core extension: a master enable/disable toggle (popup + toolbar
badge) that fully stops all timers, observers, and tab activity the moment
it's switched off, plus a first version of auto-watch that followed a
prioritized game list, picked the lowest-viewer live channel with drops
enabled, tracked per-campaign inventory progress, and auto-skipped games
that were already completed, expired, or invalid. Added a Node-based test
harness that runs the real `content.js`/`background.js` logic (via a
stubbed `browser.*` API) to check for toggle-leak and no-activity-after-off
regressions, plus the initial `scripts/submit-amo.js` AMO submit workflow.

## 2026-08-13 — AMO credential leak via npx debug logging

**Problem:** `submit-amo.js` invoked `web-ext` through `npx`, which under
its own debug logging captured the plaintext `--api-secret` argument —
meaning the AMO secret could end up in npm/npx debug logs on disk.

**Fix:** Invoke a locally-installed `web-ext` binary directly instead of
going through `npx`, and add a blanket redaction safeguard over all script
output for any environment variable whose name contains `SECRET`, `KEY`,
or `TOKEN`. Also added `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET` as an
accepted fallback credential pair (matching `web-ext`'s own flag naming),
alongside the original `AMO_JWT_ISSUER`/`AMO_JWT_SECRET`.

## 2026-08-13 — Auto-watch redesigned from single-tab to multi-tab

**Problem:** The original auto-watch scheduler watched one game at a time
("one game at a time" model), but Twitch watch-time actually accrues
independently per tab/channel — so serializing games behind each other was
leaving watch-time on the table for no reason.

**Fix:** Replaced it with a concurrent one-tab-per-eligible-game model, up
to a configurable quota (default 3). Each game's tab closes on its own the
instant that game is fully claimed, expires, or becomes invalid, without
affecting the other open tabs; once every game in the list is done, all
tabs close and the badge shows done. Added a priority mode setting
(list-order default, or soonest-expiry-first with a fail-closed fallback
to list order when an expiry date can't be parsed) to decide which queued
games get a tab first once the list exceeds the quota. Also moved muting
from clicking Twitch's own in-page mute button to the browser-level
`browser.tabs.update({muted: true})`, and added
`test/auto-watch-multi-tab.test.js` plus a grep-audit to verify every
`tabs.create`/`tabs.update` call explicitly passes `active: false` and
that `windows.update({focused: true})` is never called anywhere.

## 2026-08-14 — AMO metadata shape wrong; pending review mistaken for failure

**Problem:** The first real submission to AMO (v0.4.0, listed channel)
surfaced two issues that only showed up by actually submitting:
1. `scripts/amo-metadata.json` had `license` at the top level; AMO expects
   it nested under `version.license`, and listed submissions also require
   `categories`, which weren't being sent at all.
2. The submission passed validation and was correctly awaiting manual
   review (expected/normal for a first listed version), but `web-ext`'s
   CLI was timing out waiting for that approval and `submit-amo.js` was
   treating the timeout as a hard failure.

**Fix:** Corrected `amo-metadata.json` to nest `license` under
`version.license` and added `categories`. Changed `submit-amo.js` to tee
the sign step's output (instead of only inheriting stdio) so it can detect
the specific "Approval: timeout exceeded" message, log the AMO
review-status URL, and record the submission in
`.amo-submitted-versions.json` as `pending` rather than throwing.

## 2026-08-14 — No working way to prevent sleep during auto-watch

**Problem:** Auto-watch's background tabs stop accruing Twitch watch-time
if the machine sleeps. Investigated two potential fixes and confirmed live
that neither works in Firefox:
- `browser.power` — the API doesn't exist in Firefox at all.
- Screen Wake Lock API (`navigator.wakeLock.request()`) — throws
  `NotAllowedError: The requesting document is hidden`, because every
  auto-watch tab is created with `active: false` (by design, to avoid
  stealing focus), and the Wake Lock API refuses to grant a lock to a
  hidden document.

**Fix:** No programmatic mitigation exists, so a manual-workaround path
was added instead: the popup now shows a collapsible warning whenever
auto-watch actually has a tab open, explaining why sleep isn't prevented
automatically and linking the Windows power-settings steps (plus a
`powercfg` one-liner) to disable sleep manually.

## 2026-08-25 — Auto-watch tabs wasted on "fake category" streams

**Problem:** A game's drops directory can list a channel that isn't
actually broadcasting with that game's drop campaign attached (wrong/fake
category), so a watch tab parked there never accrues progress - silently
burning a slot out of the tab quota for as long as that channel stays live.

**Fix:** Added a drop-status verification layer. Two new content scripts,
`gql-bridge.js` (isolated world, `document_start`) and `inject.js` (page
world, injected as an external `<script src>` since twitch.tv's CSP blocks
inline scripts), passively observe Twitch's own GraphQL traffic to
`gql.twitch.tv` - matched by the request array's `operationName` (stable
across deploys, unlike the paired persisted-query hash) rather than by
issuing any request of its own - and relay two signals to background.js:
`DropsHighlightService_AvailableDrops` (which campaigns, if any, are
attached to the channel actually live right now) and `Inventory`
(account-wide minutes-watched per campaign). `verifyDropStatus()` in
background.js combines these with the existing `campaignProgress` data: an
empty campaign list on the channel is an immediate "fake category" verdict
(after a short settle window); otherwise, if minutes-watched hasn't moved
since the channel was picked after a longer verify delay, it's treated the
same way. Either case rotates the same tab back to its directory page via
`rejectChannel()` (same-tab `tabs.update`, `active:false`, matching the
file's existing tab-etiquette rule) and records the channel in a
per-slug `blockedChannels` cooldown so the directory-page picker in
content.js (`pickBestChannel()`) skips it on the re-pick. Added
`test/drop-verification.test.js` covering both signal paths and the
tab-etiquette audit for the new `tabs.update` call; GQL operation names and
field paths are flagged as best-effort, same as the file's existing DOM
selectors, since Twitch's API is private/undocumented and needs
verification against real traffic before relying on it in production.

## 2026-08-26 — Drop-status verification's GQL signal never fired; redesigned around the inventory page instead

**Problem:** The channel-tab GQL signal added the day before (previous
entry) never actually worked. Root-caused with real instrumentation rather
than guessing: added a `debugGql`-gated `[gql-debug]` logging layer plus a
throwaway unconditional "bisect" layer (raw execution-proof pings from
every link in the chain: content script injection, the MAIN-world script,
every message reaching background.js, storage reads) to narrow it down
step by step. Two separate root causes were found along the way, one
red herring and one real:
- First bisect round found *zero* instrumentation output at all, including
  lines that should have been unconditional. Cause: the loaded extension
  in Firefox was a stale `.xpi` built before the debug edits, not the
  live source folder - about:debugging's "Reload" reloads whatever was
  originally selected, not the "correct" copy. Fixed by reloading from
  `manifest.json` directly; also added a `BUILD_MARKER` string
  (`shared.js`) logged unconditionally by `background.js` at startup, so
  "am I running the current code" is a one-glance check going forward
  (see `~/.claude/CLAUDE.md`'s new global rule on this).
- With the correct build actually loaded, real logs from a real pinned
  watch tab (`tab=225`, `slug=marvel-rivals`) showed 195+ real GQL
  operationNames captured over one session - none of them
  `DropsHighlightService_AvailableDrops`, or drops-related at all. Twitch
  apparently only issues that query from a mounted, visible player UI
  component, which a background/pinned `active:false` tab never mounts.
  This data source cannot work for this extension's tab model, full stop.
  (Also found along the way, and initially mis-recorded here as "the
  `Inventory` name was simply wrong": `Inventory` *is* a real operationName -
  it did fire, once, on a real `/drops/inventory` page session (`seq=11` in
  the captured log) - but only once per page load, not on any cadence
  useful for tracking live progress. `DropsInventoryRewardGroupStatus`,
  also real, fires there repeatedly instead, making it the more promising
  candidate if a future extractor is written for it.)

**Fix:** Redesigned `verifyDropStatus()` in `background.js` to stop
depending on any channel-tab GQL signal and read `campaignProgress[slug]`
instead - the same DOM-scraped-from-`/drops/inventory` data
`mergeInventoryProgress()` already maintained for the auto-skip logic
(`content.js`'s `parseInventoryCampaigns()`). It baselines a channel's
`claimed` reward-tier count and `timeRemainingMin` shortly after picking
it, and rotates the tab if neither has moved by a later reading; if
neither number is usable at all (`timeRemainingMin` never parsed and
`claimed` never moved), that's "can't tell" rather than "it's stuck" and
fails closed to keep watching. `VERIFY_DELAY_MS` was bumped from 100s to
`RELOAD_PERIOD_MIN + 2` minutes (~17 min) - short enough was actively
dangerous here, since content.js re-scrapes the DOM every 60s regardless
of whether Twitch's underlying numbers actually changed, so a short delay
would mostly measure "did we happen to re-scan" and false-positive-reject
working channels; the delay needs to span the inventory tab's own 15-minute
hard-reload cycle to have a real chance at a genuinely fresh number.
`gql-bridge.js`/`inject.js` (MAIN-world content script, replacing an
earlier `<script src>` approach - unrelated to this fix, done during the
same debugging session once a stale-CSP theory needed ruling out) are kept
only for `[gql-debug]` exploration of `DropsInventoryRewardGroupStatus`'s
payload shape (a `RAW_DUMP_OPS` raw-body dump), in case a future extractor
for it turns out to be more precise than the DOM scrape. Rewrote
`test/drop-verification.test.js` for the new `campaignProgress`-based
signal (4 cases: stuck → rotates, `timeRemainingMin` decreasing → keeps
watching, `claimed` increasing → keeps watching, no usable signal at all →
fails closed).

## 2026-08-26 — Watch tab stuck on an offline channel; added a fast, DOM-independent detector

**Problem:** A different failure mode from "fake category" (previous
entry): a channel that *was* live and crediting drops stopped broadcasting
while its watch tab was still parked on it, and nothing rotated it away.
content.js's `looksLive()`/`looksOffline()` DOM check already existed
(60s interval) but its selectors were never verified against Twitch's
actual current markup - same unverified-best-effort caveat as the rest of
this file's DOM heuristics.

**Fix, two parts:**
- `handleChannelLeft()` (fires on `channelOffline`/`channelRedirected`,
  content.js's existing DOM-based detection) now also blocklists the
  channel it just left for a short cooldown (`OFFLINE_BLOCK_COOLDOWN_MS`,
  20 min - shorter than the fake-category `CHANNEL_BLOCK_COOLDOWN_MS`,
  since going offline isn't a permanent property of a channel). Without
  this, content.js's directory picker (`pickBestChannel()`, no live-status
  check of its own) could immediately re-pick the same channel again before
  Twitch's own directory listing caught up, producing a tight
  pick→bounce→re-pick loop.
- Added a second, DOM-independent detection layer:
  `verifyPlaybackSweep()` in `background.js` watches for silence on
  `SendEvents` (Spade video-playback telemetry - confirmed firing every
  few seconds on a real watch tab via `[gql-debug] op` capture) relayed
  through the existing gql-bridge.js/inject.js `opSeen` messages, which
  are otherwise unrelated to drops. `ClientSideAdEventHandling_
  RecordAdEvent` (also confirmed firing periodically) is tracked as a
  supplementary "any sign of life" signal only, deliberately never trusted
  alone - it's ad telemetry, so an ad-free account (Turbo, or subscribed to
  the channel) would never fire it even while genuinely watching a live,
  crediting stream. Silence past `PLAYBACK_SILENCE_MS` (3 min, generous
  enough to survive an ad break or buffering stall) triggers the same
  blocklist-and-bounce-to-directory flow, and can catch a stopped stream
  in minutes instead of the fake-category check's 17-minute
  `VERIFY_DELAY_MS`. Beacon timestamps are kept in an in-memory map
  (`beaconHeartbeat`), not `storage.local` - SendEvents fires too often for
  that to be worth persisting.
- Refactored the shared "stop watching this channel" bookkeeping
  (blocklist + clear `watchMeta`/`dropSignals`) out of `rejectChannel()`
  into a plain `clearWatchAndBlocklist()` helper, now used by all three
  triggers (fake-category rejection, offline/raid, playback-beacon
  silence) so they can't drift apart. Deliberately never wraps itself in
  `serialized()` - nesting a second `serialized()` call inside a caller
  that's already the running task at the end of the shared chain would
  deadlock.
- Added `test/playback-beacon.test.js` (4 cases: silence past the
  threshold → rotates, recent SendEvents → keeps watching, a recent
  ad-event alone → also keeps watching, never having seen any beacon at
  all → fails closed).

Left as-is for now: content.js's DOM check and its unverified selectors -
not touched, kept running in parallel as a second, independent signal.

## 2026-08-26 — Playback-beacon silence rotated live channels; reverted to a single decision-maker

**Problem:** The playback-beacon-silence mechanism from the previous entry
rotated channels that were still genuinely live and crediting drops -
worse than the tab-stuck-on-offline problem it was built to fix, since it
actively threw away good progress instead of just being slow to react to
bad channels.

**Fix:** Removed the mechanism entirely - `PLAYBACK_BEACON_OP`/
`AD_BEACON_OP`/`PLAYBACK_SILENCE_MS`/`beaconHeartbeat`/
`recordPlaybackBeacon()`/`verifyPlaybackSweep()`, its wiring into the
1-minute alarm and `handleGqlOpSeen`, and `test/playback-beacon.test.js`,
all gone. Went further than a plain revert, though, per explicit
direction: unified "fake category" and "genuinely went offline" into a
single decision-maker instead of the two-mechanism design both this and
the previous entry had, since they're the same observable symptom
(campaign progress stops moving) with the same fix (rotate) - no reason to
let either DOM state or GQL beacons decide on their own ever again, only
`verifyDropStatus`'s campaign-progress comparison may reject a channel now:
- `handleChannelLeft()` (still fired by content.js's DOM `looksLive()`/
  `looksOffline()` check) no longer touches `watchMeta`/blocklists
  anything - it's now log-only. The DOM check still provides its one real
  benefit (the tab physically leaves a dead channel fast, via content.js's
  own same-tab navigation, which was never something background.js
  controlled anyway) without being able to reject a channel on a possibly-
  wrong read.
- New failure mode that came with removing the DOM-triggered blocklist:
  content.js's directory picker has no live-status check of its own, so it
  can re-select the exact same (possibly dead) channel right after content.js
  bounces away from it, before Twitch's own listing catches up. Fixed by
  making `handleDirectoryPicked()` recognize a same-channel re-pick and
  preserve the existing `watchStartedAt`/baseline instead of resetting -
  otherwise the verify clock would restart every bounce and a genuinely
  dead channel would never accumulate the elapsed time `verifyDropStatus`
  needs to ever judge it, stalling forever instead of eventually rotating.
- `rejectChannel()` reverted back to fully self-contained (undoing the
  `clearWatchAndBlocklist()` extraction from the previous entry) - once
  `handleChannelLeft()`/`verifyPlaybackSweep()` no longer needed it, it had
  exactly one caller, so the shared-helper abstraction wasn't earning its
  keep any more.
- Accepted, explicit tradeoff: an offline channel can now take up to
  `VERIFY_DELAY_MS` (17 min) to rotate away, same as a fake-category
  stream - worse latency, but nothing can ever again wrongly reject a
  channel that's actually fine, which matters more.
- `test/drop-verification.test.js`: replaced the now-wrong "offline
  blocklists the channel" test with three that lock in the corrected
  behavior - a DOM-only offline/redirect report never rejects on its own,
  a same-channel re-pick preserves the verify clock, and a genuinely
  different channel still resets it as before.

Also captured along the way, not yet used for anything: real traffic from
a watch tab showed `DropChannelCampaignsProgress` firing (unlike
`DropsHighlightService_AvailableDrops`, which never fires there at all) -
added to `inject.js`'s `RAW_DUMP_OPS` to read its actual payload via
`[gql-debug] rawOp` before deciding whether it's a viable faster
alternative to the DOM-scraped campaign progress. Investigation only, not
wired into any decision - the point of this entry was to stop letting
anything but campaign progress make that decision.

## 2026-08-27 — Two bugs found from an overnight run: DOM false-positive, and a one-shot verify clock

**Problem, found from a real overnight auto-watch run:** a watch tab sat
on `coachdsr` long after that channel had actually ended its stream -
`[dom-debug]` showed `looksLive=true` on every single check for the rest
of the run. Two separate root causes, not one:

1. `looksLive()`'s second check - a broad, unscoped
   `[class*='live-indicator']` match - was reading some *other* channel's
   "LIVE" badge out of the sidebar (Followed/Live Channels list), not
   anything about the channel actually being watched. Confirmed from the
   same `[dom-debug]` capture: `hasAnimatedViewers` correctly tracked
   live/offline the whole session (`true` for a real live channel later in
   the run, `false` throughout the dead `coachdsr` session), while
   `hasLiveIndicatorClass` stayed stuck `true` through the whole offline
   session, and the `bodyTextSnippet` captured at the same moments showed
   only sidebar content - no player-related text at all. Because
   `!looksLive() && looksOffline()` short-circuits, `looksOffline()`'s own
   selectors were never even evaluated the entire time, so this one check
   alone explains the whole stuck tab.
2. Separately, and worse: `verifyDropStatus()` never re-baselined after a
   channel passed its first progress check. Once `claimed`/`timeRemainingMin`
   showed *any* movement relative to the original baseline, the code just
   returned - leaving that original baseline in `watchMeta` forever. Every
   later sweep then compared the *current* reading against that same
   ever-more-stale original baseline, which will show "moved since then" for
   as long as *any* progress ever happened after the channel was first
   picked - permanently, even if the channel then went completely dead.
   Effectively a one-shot check disguised as a recurring one: it ran every
   minute like it was supposed to, but after the first successful pass a
   channel became permanently exempt from ever being judged again.

**Fix:**
- `looksLive()` (`content.js`) now checks only the animated-viewer-count
  selector - the one confirmed correct in both directions from real
  capture. The broad live-indicator-class check is dropped rather than
  reintroduced scoped to a player container, since there's no real DOM
  captured yet to build that scoped selector from; `hasLiveIndicatorClass`
  stays in `reportChannelDomDebug`'s diagnostic payload in case that's
  useful data for a future scoped version.
- `verifyDropStatus()` (`background.js`) now re-baselines
  (`baselineCapturedAt`/`baselineClaimed`/`baselineTimeRemainingMin`) every
  time it finds real progress, instead of only capturing a baseline once
  and comparing against it forever. The verify-delay gate itself moved from
  "time since `watchStartedAt`" to "time since `baselineCapturedAt`" to
  match - this is what actually makes it a rolling, repeating check: every
  `VERIFY_DELAY_MS` window either shows movement (re-baseline, keep
  watching) or doesn't (reject), and a channel can never again become
  permanently exempt just by passing once.
- Added `[verify]`-tagged logging (unconditional, not gated on `debugGql` -
  this is normal operational visibility, not a diagnostic toggle) at every
  decision point in `verifyDropStatus()`: waiting on a fresh reading,
  baseline captured, waiting out the verify window, re-baselining with the
  before/after numbers, no usable signal (fail closed), and rejecting -
  so what each verify round actually decided is visible from the
  background console without needing to reason about the code.
- `test/drop-verification.test.js`: added
  `testStopsProgressingAfterOneGoodWindowStillRotates`, which locks in the
  fix directly - a channel that re-baselines after one good window must
  still get rejected on the *next* window if it stops progressing, not be
  shielded forever by the earlier good check. The four pre-existing
  progress-comparison tests were updated to backdate `baselineCapturedAt`
  (not just `watchStartedAt`) to match the new gating.

## 2026-08-28 — A genuinely correct category got permanently blacklisted as "invalid"

**Problem:** The popup showed `path-of-exile-2` as "ไม่พบเกมนี้" (category not
found) even though it's a real, correct slug that had been actively
watched with real progress earlier in the same session. `handleDirectoryInvalid()`
- triggered when content.js's directory-page check finds the tab redirected
away from `/directory/category/<slug>` - recorded slugs in a plain array
with no way to ever clear an entry short of removing and re-adding the
game in the popup (which resets `invalidSlugs` via the `watchList` change
listener). Whatever caused the false "redirected away" read here (not yet
diagnosed - a timing/race in the 5s directory-check interval is the likely
suspect, not a wrong slug), the real bug is that a *transient* misread
became a *permanent* one.

**Fix:** `invalidSlugs` changed from an array (permanent) to an object
mapping slug -> retry-after timestamp (`INVALID_SLUG_RETRY_MS`, 45 min -
same pattern `EMPTY_COOLDOWN_MS`/`CHANNEL_BLOCK_COOLDOWN_MS` already use
elsewhere in this file: never permanently give up on a signal that might
be wrong). `isGameDone()` now checks the timestamp instead of array
membership; the existing per-minute `autoWatchTick` sweep picks the game
back up on its own once the cooldown passes - no popup action needed. Old
array-shaped `invalidSlugs` data from before this change is tolerated
(treated as empty) rather than crashing anything, in `background.js` and
`popup.js` both. content.js's redirect-detection message now also carries
the actual `location.pathname`/`location.href` it landed on, logged
unconditionally in `handleDirectoryInvalid()`, so a real recurrence can
actually be root-caused instead of guessed at - the same instrumentation-
first approach used throughout this file's history. popup.js's detail text
for the "invalid" badge now says how long until the automatic retry and
that persistent recurrence against a correct name is probably a detection
bug, not a typo. Added `testInvalidSlugRetriesAfterCooldown` to
`test/auto-watch-multi-tab.test.js`.

Still open: why the false redirect happened in the first place. Watching
for the `location.pathname`/`href` this now logs the next time it recurs.

## 2026-08-28 — Inventory progress selector was completely stale; Twitch also dropped game names from cards entirely

**Problem:** `[verify]` sat on "no fresh inventory reading yet" indefinitely
- `parseInventoryCampaigns()`'s reward-element selector
(`[data-test-selector*="DropsCampaignInProgressRewardPresentation"]`)
matched zero elements on a real, logged-in `/drops/inventory` page,
confirmed live via a browser-console script rather than assumed. Twitch
renamed the whole component family to `DropsCampaignInProgressDescription-*`.
Worse: even fixing the selector name wouldn't have been enough - further
live capture found the current cards don't display the game's name as text
anywhere at all any more (the `h1-h5` heading `closestCampaignCard()` used
to find only ever matched unrelated page-level headings like "Drops &
Rewards"/"Claimed"; a page-wide text search for "Marvel Rivals"/"Path of
Exile 2" only found matches in the unrelated followed/live-channels
sidebar, never inside a drop card). The DOM-only "read a name off the
card" design this whole file was built on no longer has a name to read.

**Fix:**
- Card boundary: found live that each card is only identifiable by its
  boxart `<img data-test-selector="DropsCampaignInProgressDescription-
  game-card-image">`. `findCampaignCardBoundary()` walks up from that img
  counting `querySelectorAll` matches of the same selector, stopping at
  the ancestor that uniquely contains exactly one - robust to the
  surrounding styled-components hash classes (which carry no stable
  meaning across Twitch deploys), confirmed against 7 real cards on one
  page, correctly separated every time.
- Game identification: the boxart `<img>` src encodes a numeric id
  (`.../{id}_IGDB-285x380.jpg`) confirmed live to equal Twitch's own GQL
  `game.id` field exactly (checked against a real, non-tracked Division 2
  campaign - id `504463` matched on both sides). `inject.js` gained a
  `DropChannelCampaignsProgress` extractor whose only job is teaching
  `background.js` that `game.id -> game.name` mapping (`gameIdMap` in
  `storage.local`, merged in `handleGqlDropSignal`'s new `"gameIds"`
  branch, handled before - not through - the per-slug/per-tab gate since
  it's global data, not tied to any one watch tab). `parseInventoryCampaigns()`
  now takes `gameIdMap` and looks a card's boxart id up in it instead of
  reading any name from the page; an id not learned yet is skipped, not
  guessed at - it picks itself up on a later scan once background.js has
  seen that game.id somewhere.
- Reward-tier progress: switched from regex-parsing "N/M min" text (a
  pattern that no longer appears anywhere) to reading each tier's own
  `[role="progressbar"]` `aria-valuenow`/`aria-valuemax` directly - real
  capture confirmed this is already a clean 0-100 percentage. Remaining
  minutes are still estimated (for `timeRemainingMin`, unchanged field
  name/shape for `verifyDropStatus`/popup) from "N% of X hours"/"N% of X
  minutes" text found right next to each tier's own bar, best-effort like
  everything else DOM-based in this file - if that text isn't found for a
  tier, its percentage still counts correctly, only its contribution to
  the minutes estimate is skipped.
- Also found and fixed along the way, from the same live captures: the
  `expired` regex required the literal phrase "this drop...no longer/
  unavailable", but the real text is "This reward is no longer
  available." (confirmed only appearing on cards whose campaign period
  had actually already passed, never on still-active ones) - loosened to
  match "no longer available"/"unavailable" without requiring "drop" or
  "reward" specifically.
- Added `jsdom` as a devDependency (test-only - content.js itself still
  has zero runtime dependencies) and `test/inventory-parse.test.js` (5
  cases, built from real captured card structure): matches by boxart id
  ignoring the visible campaign-period text, an unlearned id is skipped
  rather than guessed, percent/claimed read directly from the progress
  bar, two adjacent cards stay independent, and the corrected expired/
  accountNotConnected text detection.

Still open: whether `DropChannelCampaignsProgress` (the `gameIdMap`
source) ever actually fires with `game.id`/`game.name` for the specific
games being tracked (`marvel-rivals`, `path-of-exile-2`) rather than just
the unrelated Division 2 campaign it's been observed on so far - if it
never does, `gameIdMap` never learns those ids and this whole fix stays
inert (fails closed: no progress reported, same symptom as before, not a
regression). Needs a live run to confirm.

## 2026-08-28 — `DropChannelCampaignsProgress` never fired for tracked games; trying `Inventory` instead

A ~85s real capture (BUILD_MARKER `2026-08-28-r2`) covering all three
tracked watch tabs (`marvel-rivals`, `path-of-exile-2`,
`tom-clancys-the-division-2`, all headless/`active:false` auto-watch
tabs) showed zero `DropChannelCampaignsProgress` operations and
therefore zero `[gameIdMap] learned:` lines - only `SendEvents` (Spade
telemetry) and unrelated named operations
(`BulkAllActiveHypeTrainStatusesQuery`, `WithIsStreamLiveQuery`, etc).
This is consistent with the same "needs a mounted, visible player UI"
gating already confirmed for `DropsHighlightService_AvailableDrops` -
the one earlier `DropChannelCampaignsProgress` sighting was from an
untracked tab, likely one the user had open and visible themselves, not
a headless auto-watch tab.

Rather than keep waiting on a signal that may never fire for headless
tabs, re-added `Inventory` to `inject.js`'s `RAW_DUMP_OPS` (it was
removed earlier as "confirmed real but useless for live progress since
it only fires once per page load" - true, but irrelevant for
`gameIdMap`, which only ever needs one fresh id->name read per inventory
reload cycle anyway, and the inventory page is reloaded every
`RELOAD_PERIOD_MIN` regardless). Its pre-redesign extractor only ever
read `game.displayName`; whether `game.id` sits right next to it in the
same response was never actually checked. If it does, `Inventory` is a
strictly better `gameIdMap` source than `DropChannelCampaignsProgress` -
it's confirmed to fire on the inventory page itself, with no dependency
on any channel tab's player UI being mounted. Not yet wired into
`EXTRACTORS`/`gameIdMap` - this only captures the raw body so the real
schema can be confirmed instead of guessed. BUILD_MARKER bumped to
`2026-08-28-r3`.

Still open: same as above, plus whether `Inventory`'s response actually
carries `game.id` alongside `game.displayName`. Needs a live capture of
its raw body (`[gql-debug] rawOp` for `op=Inventory`) to confirm before
wiring it into `gameIdMap`.

## 2026-08-28 — `Inventory`'s raw body confirmed `game.id`; wired it into `gameIdMap` as the primary source

Live capture (BUILD_MARKER `2026-08-28-r3`, tab=2, the visible
/drops/inventory tab) caught `op=Inventory`'s real response:
`currentUser.inventory.dropCampaignsInProgress[].game` carries `id`,
`slug`, `name`, and `boxArtURL` together - and it fired with entries for
*both* currently-tracked games in the same response
(`{"id":"1264310518","slug":"marvel-rivals","name":"Marvel Rivals",...}`
and `{"id":"504463","slug":"tom-clancys-the-division-2","name":"Tom
Clancy's The Division 2",...}`), not just the previously-seen untracked
Division 2 campaign. Confirms the schema and resolves the "still open"
question from the previous entry.

Added an `Inventory` extractor to `inject.js`'s `EXTRACTORS` (alongside
the existing `DropChannelCampaignsProgress` one, kept as a harmless
bonus in case it ever fires) - both emit the same `{kind: "gameIds",
games}` signal shape already handled by `handleGqlDropSignal` in
background.js, so no change was needed there. `Inventory` is now the
reliable, confirmed-firing-on-the-actual-inventory-page source for
`gameIdMap`; `DropChannelCampaignsProgress` (confirmed, in the previous
entry, to never fire from a headless auto-watch tab) is no longer
depended on for anything. BUILD_MARKER bumped to `2026-08-28-r4`.

Not yet confirmed: whether `parseInventoryCampaigns()` in content.js now
actually matches cards and reports moving percentages end-to-end with a
populated `gameIdMap` - the reload that will exercise this new
`Inventory` extractor for the first time has not happened yet at the
time of this entry. Needs a live run: reload the extension (not just the
page - the extractor change lives in `inject.js`, a content script,
which only re-injects on a full extension reload), then check for
`[gameIdMap] learned:` in the background console and watch the popup's
"เหลือดูอีก ~N นาที" for movement.

## 2026-08-28 — `gameIdMap` confirmed working live; found and fixed a same-slug/multiple-campaign-cards bug it exposed

Reload confirmed the `Inventory` extractor works exactly as expected:
`[gql-debug] signal ... op=Inventory kind=gameIds` fired with both
tracked games' ids resolved (`1264310518` -> Marvel Rivals, `504463` ->
Tom Clancy's The Division 2).

That same reload's log immediately showed a second, previously-invisible
problem: `marvel-rivals expired - closed its tab` followed right away by
`opened watch tab for marvel-rivals tab=46 (3/3)` - a pointless
close-then-reopen that throws away the just-picked channel's verify
baseline/watch clock for no reason. Root cause: the real inventory page
had *two* Marvel Rivals campaign cards showing at once - an old one past
its end date ("Ignite MSF 2026 Day 1", `status:"EXPIRED"` in the GQL
data) alongside a current active one - both sharing the same boxart id
and therefore the same slug. `parseInventoryCampaigns()` was returning
one result *per card*, so a game with two simultaneous campaigns
produced two same-slug entries in the array background.js's
`mergeInventoryProgress` sends to `progress[slug]`; whichever entry
landed last in DOM order silently won. In the order this reload actually
had (expired card first, active card second), the tab got closed
because of the expired entry, then the active entry immediately
overwrote `progress["marvel-rivals"]` back to non-expired, so the very
next `autoWatchTick()` saw the game as still eligible and reopened a
fresh tab - explaining the exact log sequence observed, at the cost of a
wasted channel pick and reset verify clock. Worse, reasoned through (not
observed this time, since DOM order happened to favor recovery): if the
expired card had landed *last* in DOM order instead, the opposite would
happen - a genuinely still-active campaign would get permanently marked
`expired` and the game would be dropped from the watch list for good.

Fixed in `content.js`: added `dedupeBySlugPreferringActive()`, run on
`parseInventoryCampaigns()`'s results before they leave the function -
collapses same-slug entries to one, preferring any non-expired card over
an expired one regardless of DOM order, and only lets a slug end up
`expired` when every one of its cards is. Added two regression tests to
`test/inventory-parse.test.js` covering both DOM orderings (expired
card first / active card first) - both must resolve to the single
active, non-expired result. BUILD_MARKER bumped to `2026-08-28-r5`.

Still open: whether `parseInventoryCampaigns()` now reports correctly
moving percentages end-to-end for `path-of-exile-2` too - no
path-of-exile-2 campaign card appeared in any capture so far (only
marvel-rivals and tom-clancys-the-division-2), so `gameIdMap` has not
yet had a chance to learn that game's id. Not a regression - just not
yet observed live.

## 2026-09-01 — `looksOffline()` selector verified against a real channel-page DOM (was stale)

**Problem:** `content.js`'s `looksOffline()` still led with
`.channel-status-info--offline`, a selector that had never been checked
against Twitch's current channel-page markup - same unverified-best-effort
caveat the earlier entries kept flagging. `[dom-debug]` logs also showed
`liveIndicatorClass=true` sticking on an offline channel, which read as a
recurrence of the 2026-08-27 sidebar-contamination bug even though that
selector had already been demoted to diagnostic-only.

**How it was captured (no more guessing at selectors):** copied the real
logged-in Firefox profile (`Profiles/yr6i5i91.default-release`, the one
whose `cookies.sqlite` was current) to `D:\ff-twitch-profile`, stripped
the permanently-installed `twitch-drop-auto-claimer@foolshang` 0.5.0 .xpi
out of the *copy* so it wouldn't clash with web-ext's temporary install
(without this, `web-ext run` would have been debugging the stale signed
build, not the working tree - exactly the "are you even running the new
code" trap), then `web-ext run --firefox-profile=D:\ff-twitch-profile
--verbose` (no `--keep-profile-changes`). web-ext launches Firefox with
`-start-debugger-server <port>` (port read from the `--verbose`
`Firefox args:` line); a second RDP client (same wire format as
`node_modules/web-ext/lib/firefox/rdp-client.js`) attached to that port,
found the twitch.tv tab's `consoleActor`, and dumped
`document.documentElement.outerHTML` + a targeted selector probe for a
live channel (`warframe`) and an offline one (`ghazzytv`, autohosting).

**What the capture showed:**
- `.channel-root` - the single element wrapping the whole channel page -
  carries React-state-driven, viewed-channel-scoped modifiers:
  `.channel-root--live` when live; `.channel-root__player--offline` +
  `.channel-root__info--offline` when offline. Cleanly mutually exclusive
  (1/0 either way) across 2 live + 2 offline channels. Never in the
  sidebar.
- `.channel-status-info--offline` (the old selector) matched **zero**
  elements in *both* dumps - fully stale. An autohosting-while-offline
  channel now uses `.channel-status-info--autohost`;
  `.channel-root__info--offline` covers that too.
- `[data-a-target="animated-channel-viewers-count"]` (current
  `looksLive()`) still tracked correctly: 1 live / 0 offline. Left as-is.
- The old `[class*='live-indicator']` fragment would have matched *more*
  on the offline page (3) than the live one (2) - a `live-indicator-container`
  in the offline-hero recommendations plus sidebar badges. Confirms it was
  right to drop.

**Fix (`content.js`):** `looksOffline()` now checks
`.channel-root__player--offline, .channel-root__info--offline` (verified
scoped offline signal) instead of the stale `.channel-status-info--offline`;
the content-gate guard and the offline-recommendations-carousel / text
checks are unchanged. `reportChannelDomDebug()` gained `hasChannelRootLive`
/ `hasChannelRootOffline`, logged by `background.js`'s `[dom-debug]` line.
New `test/channel-live-detection.test.js` runs the real `looksLive()`/
`looksOffline()` against jsdom fixtures built from the capture, including
a sidebar full of *other* channels' LIVE badges that must not keep a dead
channel's tab from rotating (the 2026-08-27 regression, locked in). The
new predicate was also re-evaluated live over RDP on all four channels:
live -> stay, offline -> rotate, 4/4. BUILD_MARKER bumped to
`2026-09-01-r1`.

## 2026-09-01 — Inventory parser re-verified live; `extractExpiresAt()` didn't handle the real date format

**Context:** while the RDP session (previous entry) was still up, also
dumped the real `/drops/inventory` and `/drops/campaigns` DOM to answer
"does drop-progress parsing still work" directly rather than by assumption.

**What held up:** `parseInventoryCampaigns()`'s selectors are all still
correct against today's markup - `DropsCampaignInProgressDescription-game-card-image`
(5 image elements found), `[role="progressbar"]` + `aria-valuenow` (22),
`findCampaignCardBoundary()` cleanly separated all 5 cards, and
claimed/total/`timeRemainingMin` computed correctly (e.g. a card with
tiers 53%/100%/100% at "4 hours"/"1 hour"/"30 minutes" -> claimed 2,
total 3, 113 min remaining). The `"N% of X hours"` text
`extractTierDurationMin()` needs is present again in the live element's
text content (it reads via `.innerText`, which concatenates across the
per-word `<span>`s).

**What was broken:** `extractExpiresAt()` only matched `"N days left"` or
`"ends on <Month> <day>"`. The text an actual campaign card shows is
`"End Date: Wed, Aug 26, 7:59 AM GMT+7"` - never matched, so every card's
`expiresAt` came back `null` and the "soonest expiry first" priority mode
had nothing to sort on.

**Fix (`content.js`):** `extractExpiresAt()` now also matches
`"End Date: [<weekday>,] <Month> <day>"`. Because that string is an
absolute date shown on ended cards too, a parsed date in the past is
returned as-is (it really did end then) rather than rolled forward a year
- only the relative `"ends on ..."` phrasing, which is used on in-progress
campaigns only, still rolls a past-looking date to next year. Added
`testExpiresAtParsedFromEndDateFormat` to `test/inventory-parse.test.js`.
BUILD_MARKER bumped to `2026-09-01-r2`.

**Not a bug, just the current state:** every campaign in the account's
inventory right now (`"3rd Drop 8/12-8/26"` + `"Ignite MSF 2026 Day 1-4"`)
already ended Aug 26-29 and is flagged `expired: true` correctly - there
is no active campaign in progress to watch numbers move on. `/drops/campaigns`
does list ~70 games with currently-open drops (Marvel Rivals -> Sep 4,
The Division 2 -> Sep 3, WoW, Don't Starve Together, League of Legends,
ARC Raiders, ...), so an end-to-end "progress actually increments" check
is possible against one of those but needs a real ~15-20 min watch.

## 2026-09-01 — Open-campaign check: resolve typed game names + skip games with no live drop

**Feature (requested):** when a game is added to the watch list, check
Twitch's "All Campaigns" page for it - only auto-watch games that actually
have an open drop campaign right now, and rewrite the typed name to
Twitch's own spelling.

**Data source, found by RDP capture:** `/drops/campaigns` fires a
`ViewerDropsDashboard` GQL op carrying `currentUser.dropCampaigns[]` -
every campaign Twitch knows about, each with `game.id`/`game.displayName`
(no slug), `status` (`ACTIVE`/`EXPIRED`), `endAt`, and
`self.isAccountConnected`. `/drops/inventory` does *not* fire it, so it
can't ride the existing always-open inventory tab.

**How it works:**
- `inject.js`: new `ViewerDropsDashboard` extractor emits a full-snapshot
  `openCampaigns` signal.
- `background.js`: `refreshOpenCampaigns()` opens `/drops/campaigns` in a
  transient background tab, waits for that one signal, closes the tab.
  Triggered on watch-list change, on enable, on the 15-min inventory-reload
  alarm (only if the snapshot is >45 min old), and by a popup button.
  `handleGqlDropSignal` stores the snapshot as `openCampaigns.bySlug`
  (`toSlug(displayName)` -> `{gameId, displayName, active, endAt,
  accountConnected}`, one row per game, aggregated across a game's
  multiple campaigns) and seeds `gameIdMap` from it.
- `annotateWatchListFromCampaigns()` (shared matcher `matchOpenCampaign` in
  `shared.js`: slug/alias, exact normalized name, or unambiguous
  containment - never a wrong bind) binds each watch-list entry to the
  matched campaign's `displayName`/`slug`/`gameId` and a
  `campaign: {open, endAt, accountConnected}` annotation.
- `autoWatchTick`'s eligibility gains `lacksOpenCampaign()` - excludes a
  game only when a fresh, non-empty snapshot positively has no active
  campaign for it (fails open on missing/stale/empty data). "Everything is
  merely waiting" now tears down to `idle`, not `all-done`.
- `popup`: per-game badges ("ดรอปเปิดอยู่" / "ไม่มีดรอปเปิดตอนนี้" /
  "ยังไม่เชื่อมบัญชีเกม"), the resolved canonical name in the row and the
  textarea (original kept as "พิมพ์ไว้:"), a "เช็ค All Campaigns ตอนนี้"
  button, and a per-game `<input type="date">` writing `gameWaitUntil`
  (manual "don't start before this date" - for a campaign that's announced
  but not yet listed; also gates `autoWatchTick`, released automatically
  once the date passes).

**Bug found and fixed during live testing (RDP-driven, real logged-in
profile):** `annotateWatchListFromCampaigns` ended with
`await serialized(autoWatchTick)` while itself being called from inside the
`serialized()` block in `handleGqlDropSignal` - the inner `serialized` wait
deadlocked the task chain, so the post-snapshot `autoWatchTick` never ran
and a no-campaign game's tab stayed open. Fixed by making
`annotateWatchListFromCampaigns` own its serialization (its watchList
read-modify-write is a `serialized` unit, then a separate
`serialized(autoWatchTick)`) and never calling it from inside another
`serialized` block. Also added a `gameWaitUntil` storage-change reaction so
the date picker takes effect immediately.

**Verified live over RDP** (web-ext against a copy of the logged-in
profile): snapshot captured 88 games / 74 active; `"the division 2"` ->
`"Tom Clancy's The Division 2"`, `campaign.open:true`, watched;
`poe2` -> no match, `campaign.open:false`, **not** watched, phase `idle`
not `all-done`; setting a future date on a watched game closed its tab,
clearing it reopened one; the popup date picker persisted `gameWaitUntil`
and the textarea auto-corrected to the canonical name.

New tests: `test/open-campaigns.test.js` (real `inject.js` extractor +
`matchOpenCampaign`), plus `testSkipsGameWithNoOpenCampaign` and
`testWaitUntilDateGatesAutoWatch` in `test/auto-watch-multi-tab.test.js`.
BUILD_MARKER bumped to `2026-09-01-r3`.

## 2026-09-01 — Follow-ups on the open-campaign check: wrong slug for renamed games, date-picker clipped, stale account-link warning

Three issues found while the user tested the previous entry's feature live
with a real watch list (Call of Duty: Modern Warfare 4 / Rainbow Six Siege
/ HITMAN World of Assassination):

**1. "Rainbow Six Siege" never found a channel.** `ViewerDropsDashboard`
carries only `game.displayName`, no slug, so the resolver derived the slug
as `toSlug("Rainbow Six Siege")` = `rainbow-six-siege`. Confirmed live:
`/directory/category/rainbow-six-siege` renders blank (no `<h1>`, 0 cards,
title just "Twitch"), while `/directory/category/tom-clancys-rainbow-six-siege`
is the real one ("Rainbow Six Siege - Twitch", 30 cards) — Twitch renamed
the *display* but kept the legacy slug. Fixes:
- `shared.js` ALIASES: `r6` / `r6s` / `rainbow six` / `rainbow six siege`
  / `rainbow 6 siege` -> `tom-clancys-rainbow-six-siege` (was a single
  `r6` entry). `toSlug()` is alias-aware, and the open-campaign snapshot
  builder goes through it, so this alone fixes the resolution.
- General safety net: new `SideNav` extractor in `inject.js` (that query
  fires on every twitch page and its stream nodes carry `game.id` +
  `game.slug` + `game.displayName` together) -> `gameSlugs` signal ->
  `gameSlugMap` (id -> real slug) in `background.js`.
  `buildOpenCampaignsSnapshot()` now prefers `gameSlugMap[id]` over
  `toSlug(displayName)`. Only covers games that appear in the user's
  sidebar, so the alias table is still the reliable path for a game like
  R6 that the user doesn't follow.

**2. The per-game date picker was unreachable.** `.game-status-list` had
`max-height: 180px; overflow-y: auto`; with 3 games the 3rd row's
`<input type="date">` rendered below the clip region, visually under the
tab-quota / priority settings controls. Bumped to `max-height: 300px` (fits
~3 rows without scrolling; Firefox's native date popup isn't clipped by the
container anyway).

**3. False "connect your account" warning.** `ViewerDropsDashboard`'s
`self.isAccountConnected` was `false` for HITMAN even though its
`/drops/inventory` progress was actively moving (`timeRemainingMin`
59 -> 41 -> 31 over ~30 min of real watching). The popup now suppresses the
"ยังไม่เชื่อมบัญชีเกม" badge whenever `campaignProgress` has an in-progress
card for that game (`total > 0`) — an inventory card is proof the account
is linked, and it's fresher than the cached dashboard flag.

**Also verified this round (live, RDP-driven, real logged-in profile):**
the full watch pipeline end to end — HITMAN watch tab -> real channel
(`domhak24`) -> Twitch watch-time -> `/drops/inventory` "N% of X hours" DOM
-> `parseInventoryCampaigns` -> `campaignProgress.timeRemainingMin`
decreasing -> `verifyDropStatus` sees movement and keeps the channel. Call
of Duty's numbers did NOT move and its channel got rotated — consistent
with that campaign's account genuinely not being linked (correctly
surfaced, not silently farmed). BUILD_MARKER -> `2026-09-01-r5`.

## 2026-09-01 — Permanent slug fix: resolve a wrong guessed slug via Twitch search

The previous entry fixed Rainbow Six Siege with an alias and a SideNav
id->slug learner, but a game that (a) is renamed on Twitch's display while
keeping its old category slug, (b) isn't in the user's sidebar (so SideNav
never learns it), and (c) has no alias, would still guess wrong forever.
Now it self-corrects, once, permanently.

**How, without clicking anything:** `/search?term=<game name>` renders the
category result as `<a data-a-target="search-result-category"
href="/directory/category/<REAL SLUG>">` - a *stable* selector (not a
styled-components hash), and its href carries the canonical slug even when
the display name no longer matches it. Confirmed live: searching
"Rainbow Six Siege" yields `/directory/category/tom-clancys-rainbow-six-siege`.
(The `/drops/campaigns` "How to Earn the Drop" section also has this, but
only after clicking each campaign row open - rejected as too fragile.)

**Flow:**
- `content.js`: when a watch tab's directory page trips
  `looksLikeUnknownCategory()`, it now posts `directoryUnknownCategory`
  (with the game name) instead of going straight to `directoryInvalid`.
  A new `/search` branch scrapes `a[data-a-target="search-result-category"]`
  and posts `searchCategoryResult { term, slug }`.
- `background.js`: `handleDirectoryUnknownCategory()` parks the bad slug,
  opens a transient `/search?term=` tab, waits (25s) for
  `searchCategoryResult` matching the term (normalized), then
  `applyResolvedSlug()` - rewrites the watch-list entry's slug, re-keys
  every per-slug map (`invalidSlugs` / `emptyUntil` / `gameWaitUntil` /
  `campaignProgress`), caches `gameSlugMap[gameId] = realSlug` so
  `buildOpenCampaignsSnapshot` never guesses that game wrong again, closes
  the stale tab, and re-runs the scheduler. If search resolves nothing, it
  falls back to the normal `handleDirectoryInvalid` cooldown.
- `shared.js`: `searchUrl(term)` helper.

**Verified live (RDP-driven):** with the R6 aliases temporarily removed,
seeding "Rainbow Six Siege" (guessed slug `rainbow-six-siege`) ->
directory rendered blank -> search tab opened -> slug corrected to
`tom-clancys-rainbow-six-siege` in `watchList` **and** cached in
`gameSlugMap["460630"]` -> directory reopened with the real slug ->
watching `pascal0_4`. Total ~25s, one time. The aliases were restored
afterwards (an instant shortcut; search is the fallback).

New tests: `testUnknownCategorySlugResolvedViaSearch` and
`testUnknownCategoryFallsBackToInvalidWhenSearchFails` in
`test/auto-watch-multi-tab.test.js`. BUILD_MARKER -> `2026-09-01-r7`.

## 2026-09-01 — Auto-off is now completion-based; expiry priority uses the GQL campaign end date

**Auto-off, redesigned (user request):** the "turn off if idle for N hours"
toggle was time-based and needed an hours input. It's now
completion-based: with the toggle on, the master switch flips off the
moment every tracked game is done (fully claimed / expired / no open
campaign). Driven by `finishAllDone()` calling `checkAutoOff()` the instant
that state is reached; the `AUTO_OFF_ALARM` run is kept only as a backstop.
A 3-minute grace window after a manual re-enable stops flipping the switch
back on (to add games / wait for new campaigns) from being instantly
undone. `completedAllAt` is recorded so the popup's off-note can say
"🎉 collected everything - turned off automatically" instead of the
generic message. Removed `autoOffHours` / `DEFAULT_AUTO_OFF_HOURS` and the
hours `<input>`.

**Expiry priority improvement:** "soonest expiry first" ordered only on the
inventory card's parsed "End Date" (`campaignProgress.expiresAt`), which
exists for a minority of games. It now prefers Twitch's own campaign
`endAt` from the open-campaigns snapshot - known for *every* game that has
an open campaign - and falls back to the inventory date. The popup's
per-game detail and the mode hint were updated to match.

**Verified live (RDP-driven):**
- auto-off: one game marked fully claimed -> `enabled` went `false`,
  `completedAllAt` set, popup showed the 🎉 note.
- looksLive/looksOffline in a real watch tab: injecting
  `.channel-root__player--offline` + removing the animated-viewer-count
  element into a live R6 watch tab (`ruoling_`) -> content.js's 60s check
  bounced it back to `/directory/category/tom-clancys-rainbow-six-siege?filter=drops`
  within 45s.
- open-campaign snapshot refresh cadence: ageing `openCampaigns.fetchedAt`
  to 50 min -> the next `autoWatchTick` opened a transient `/drops/campaigns`
  tab and reset `fetchedAt` to ~1 min.
- popup "check All Campaigns now" button: click -> "checking..." ->
  "checked: 79 games with an open drop (of 82)" in ~8s.
- drop progress end to end: HITMAN `timeRemainingMin` fell 59 -> 41 -> 31
  -> ~1 over ~40 min of real watching, then the drop completed.

New tests: `testAutoOffOnAllDone`, `testAutoOffRespectsReenableGrace`,
`testExpiryPriorityUsesCampaignEndAt`. BUILD_MARKER -> `2026-09-01-r8`.

## 2026-09-02 — Released 0.6.0

`manifest.json` 0.6.0. `README.md` rewritten (open-campaign check,
permanent slug resolution, completion-based auto-off, updated test list)
with a Changelog section. Committed as `8fc06d4` on `master` (+ a
`release/0.6.0` branch), pushed to GitHub. Submitted to the public AMO
listed channel via `npm run submit:listed` - lint clean (0/0/0), signed
and auto-approved to `web-ext-artifacts/33d37586a96d443fa884-0.6.0.xpi`,
recorded in `.amo-submitted-versions.json`. Firefox installs auto-update
from the AMO listing.

## 2026-09-02 — Released 0.6.1 (debug instrumentation stripped)

0.6.0 shipped the GQL/DOM debugging layer that had accumulated across the
August drop-verification work. It was gated off by default, but the popup
still showed a "Debug: log GQL operations" toggle to end users, and
`inject.js` posted an `opSeen` message per GraphQL operation (plus a
one-shot `install` and `rawOp` dumps) on every twitch.tv page regardless of
the flag - real overhead for no user benefit.

Removed for 0.6.1:
- `inject.js`: the `install` / `opSeen` / `rawOp` posts, `RAW_DUMP_OPS`,
  `safeStringify`, `opSeq`. Only the signal `EXTRACTORS`
  (`DropChannelCampaignsProgress`, `Inventory`, `SideNav`,
  `ViewerDropsDashboard`) and the fetch/XHR hooks that feed them remain.
- `gql-bridge.js`: collapsed to a single `gqlDropSignal` relay - the
  `gqlInstall` / `gqlOpSeen` / `gqlRawOp` branches are gone.
- `background.js`: `handleGqlInstall`, `handleGqlOpSeen`,
  `handleChannelDomDebug`, `handleGqlRawOp`, `debugTag`, the `debugGql`
  block at the top of `handleGqlDropSignal`, and the four message-dispatch
  cases for them.
- `content.js`: `reportChannelDomDebug()` and its call site in the
  channel-watch interval.
- `popup.html` / `popup.js`: the Debug toggle row and all `debugGql`
  read/write/listener code.

Kept: the unconditional `BUILD_MARKER` startup log (`background.js`, per the
global "am I running the current code" rule) and the unconditional
`[verify]` logging in `verifyDropStatus()` (normal operational visibility,
never a diagnostic toggle). `BUILD_MARKER` bumped to `2026-09-02-r1`,
`manifest.json` to 0.6.1. All six test files still pass unchanged.

Committed as `02fa4da` on `master`, pushed to GitHub. Submitted to the
public AMO listed channel via `npm run submit:listed` - lint clean
(0/0/0), signed and auto-approved to
`web-ext-artifacts/33d37586a96d443fa884-0.6.1.xpi`, recorded in
`.amo-submitted-versions.json`. Firefox installs auto-update from the AMO
listing.

## 2026-09-02 — Popup UI language switcher (0.6.2)

**Feature (requested):** the popup was Thai-only. Added a language picker
at the top of the popup with nine languages: Thai, English, Simplified
Chinese, Japanese, Korean, Russian, French, Portuguese, Traditional
Chinese (Taiwan).

**How it works:**
- New `i18n.js` (loaded first in the popup and as a background script,
  same slot as `shared.js`) holds one flat string table per language plus
  four helpers: `i18nResolveLang(stored, navLang)`, `i18nT(lang, key,
  params)` (`{name}` interpolation, falls back English → raw key so a
  missing string is never blank), `i18nLocale(lang)` (BCP-47 tag for
  `toLocaleDateString`), and `applyI18n(root, lang)` (walks `[data-i18n]`
  / `[data-i18n-placeholder]` — text/placeholder only, never `innerHTML`,
  so lint stays at 0 warnings).
- The choice is stored as `browser.storage.local.uiLang`. When unset,
  `i18nResolveLang` maps the browser's own language (`navigator.language`),
  falling back to English; `zh-*` splits Traditional/HK/Macao → `zh-TW`,
  everything else `zh` → `zh-CN`.
- `popup.html` static text became `data-i18n` keys; `popup.js`'s
  dynamically built strings (relative times, per-game badges/details,
  campaign-check status, save confirmation) go through a local
  `t(key, params)` bound to the current `LANG`. The picker persists and
  re-renders live (no "save"); a `storage.onChanged` reaction keeps a
  second open popup in sync.
- `background.js`'s `refreshBadge()` now localizes the three toolbar
  tooltip strings (`tt_off` / `tt_all_done` / `tt_running`) from `uiLang`,
  and re-runs on a `uiLang` change. `navigator` is accessed defensively
  (`typeof navigator !== "undefined"`) so the vm-based tests don't need a
  stub.

**Tests:** new `test/i18n.test.js` — key parity across all nine languages
(same key set as `en`, no empty values, matching `{placeholder}` tokens),
`i18nResolveLang` mapping (stored choice > browser locale > English,
including the `zh` Simplified/Traditional split), `i18nT` interpolation
and fallback, and a static check that every `data-i18n` key in
`popup.html` and every `t(...)`/`i18nT(...)` key literal in `popup.js` /
`background.js` exists in `en`. The three vm-based suites
(`toggle-behavior`, `auto-watch-multi-tab`, `drop-verification`) now load
`i18n.js` into the sandbox alongside `shared.js`. All seven test files
pass; `web-ext lint` clean (0/0/0). `BUILD_MARKER` → `2026-09-02-r2`,
`manifest.json` → 0.6.2.

**Versioning going forward:** bump the patch component by exactly 0.0.1
per release (0.6.1 → 0.6.2 → 0.6.3 …) unless told otherwise.

**Dev workflow going forward:** `master` always mirrors what's live on
AMO. New features are built on a `dev` branch (test locally with
`npx web-ext run`), then merged to `master` with the version bump in the
same merge, and only then submitted to AMO.

Committed as `0f003dd` on `master`, pushed to GitHub. Submitted to the
public AMO listed channel via `npm run submit:listed` - lint clean
(0/0/0), signed and auto-approved to
`web-ext-artifacts/33d37586a96d443fa884-0.6.2.xpi`, recorded in
`.amo-submitted-versions.json`. Firefox installs auto-update from the AMO
listing. Created the `dev` branch off this commit for the next feature.

## 2026-09-03 — Per-game "watch from" picker: popup-safe + a time of day (0.6.3)

**Problem (reported):** the per-game "watch from" date picker
(`<input type="date">`, added in 0.6.0) opened its calendar panel *behind*
the popup and couldn't be used. This is a long-standing Firefox platform
bug - the native date/time picker panel is mispositioned / hidden when the
input lives inside a `browser_action` popup ([bug 1644337],
[Mozilla Discourse]), not something the extension can fix from CSS or
z-index. The same request also asked for a start *time*, not just a date,
so auto-watch can begin a game the moment its drop is released instead of
at local midnight.

[bug 1644337]: https://bugzilla.mozilla.org/show_bug.cgi?id=1644337
[Mozilla Discourse]: https://discourse.mozilla.org/t/webextensions-date-input-element-in-browser-action-does-not-work-in-desktop/27114

**Fix:** replaced the single `<input type="date">` with five plain
`<select>` dropdowns (year / month / day / hour / minute) built by a new
`waitControlEl(game, waitUntil)` in `popup.js`. Native `<select>` popups
render fine in a `browser_action` popup (the language and priority pickers
already prove that) and aren't clipped by the `overflow-y: auto` game
list. Details:
- Year offers last year … this year + 2. Minute is 5-minute steps.
- An incomplete date (year/month/day not all set) means "no gate" and
  clears any stored timestamp; hour/minute default to `00:00`.
- The chosen day is clamped to the selected month (`31` → `30` / `28`)
  instead of letting the `Date` constructor roll over into the next month.
- New `formatDateTime()` shows `HH:MM` alongside the date in the per-game
  badge / detail line whenever the timestamp isn't local midnight;
  `formatDate()` (still used for campaign end dates) is unchanged.
- The stored value is still a single epoch-ms number in
  `gameWaitUntil[slug]`, which `background.js` already compares as
  `> Date.now()` - no scheduler change, and old date-only values keep
  working.
- `popup.html`: `.g-wait` gains `flex-wrap: wrap`; the
  `input[type="date"]` rule becomes a `select` rule. `i18n.js`: one new
  key `row_wait_aria` (group aria-label) across all nine languages;
  removed the now-unused `tsToDateInput` / `dateInputToTs` helpers.

**Tests:** all seven test files pass unchanged; `test/i18n.test.js`
confirms the new key has parity across all nine languages. `web-ext lint`
clean (0/0/0). A jsdom check of `waitControlEl` verified the five selects,
populate/commit round-trip, and the Feb-31 → Feb-28 clamp. `BUILD_MARKER`
→ `2026-09-03-r1`, `manifest.json` → 0.6.3.

Authored on the `dev` branch, fast-forwarded to `master` as `de8e009`,
pushed to GitHub. Submitted to the public AMO listed channel via
`npm run submit:listed` - lint clean (0/0/0), signed and auto-approved to
`web-ext-artifacts/33d37586a96d443fa884-0.6.3.xpi`, recorded in
`.amo-submitted-versions.json`. Firefox installs auto-update from the AMO
listing.

## 2026-09-05 — Drop progress can stall while the monitor is off (0.6.4)

**Problem (reported):** with the display turned off via Windows' own idle
timer ("Turn off screen after") - not the PC sleeping, which stayed active
the whole time - drop watch-time on `/drops/inventory` stopped moving.

**Investigation (live, via `web-ext run` + Firefox RDP against a real
logged-in profile):** found two separate, real causes.

1. Twitch's own player sometimes never starts video at all in a tab this
   extension opened in the background (`active: false`) - `video.readyState`
   stuck at 0 / `currentTime` at 0 indefinitely (10+ minutes observed),
   intermittently, on some channels but not others, with no console error.
   A content-script nudge (synthetic click + `video.play()`) did not fix
   it. Only `browser.tabs.update(tabId, {active:true})` - making the tab
   genuinely the active tab of its window - reliably started playback
   within ~20s. This is independent of screen state; it can happen with
   the screen on too.
2. Separately, Firefox's own window-occlusion tracking listens to the real
   display power state, not just tab visibility - when the monitor turns
   off, Firefox can mark every window occluded even though nothing slept,
   which can suspend already-playing background video after a short delay
   (`media.suspend-bkgnd-video.enabled`). This is inside Firefox itself;
   WebExtensions have no permission to change `about:config`, so it can't
   be fixed from this extension - documented instead as a user-side
   troubleshooting section in `README.md` (three `about:config` prefs to
   try, or a `powercfg`+physical-monitor-button workaround that avoids
   needing any of them).

**Fix (cause 1, and its knock-on effect):**
- New `getOrCreateWatchWindow()` (`background.js`): every tab this
  extension opens (inventory, campaigns, watch, search) now opens inside
  one dedicated Firefox window, created once and remembered in
  `storage.local.watchWindowId` - never the window the user is actually
  using, so this can never interrupt YouTube or anything else they have
  open. `windows.update({focused:true})` is still never called anywhere.
- `flashTabToStartPlayback()`: right after `handleDirectoryPicked` picks a
  genuinely new channel, that tab is briefly set `active: true` for
  `PLAYBACK_FLASH_HOLD_MS` (8s) then back to `false` - but only after
  confirming, via `tab.windowId`, that the tab is actually inside the
  dedicated watch window. This is what reliably starts Twitch's player.
  Two alternatives that would have avoided touching `active` at all were
  tried first and live-verified NOT to work: a minimized window and a
  window positioned off-screen both leave `document.visibilityState`
  stuck at `"hidden"` (Firefox's real occlusion tracking, not just the
  `minimized` flag, decides this), and Twitch's player never starts
  either way.
- A real race found while live-testing this: re-querying `browser.tabs`
  right after `browser.windows.create()` isn't guaranteed to reflect the
  new window's own initial tab yet, which produced a genuine duplicate
  `/drops/inventory` tab. Fixed by having `getOrCreateWatchWindow()`
  return `{id, freshlyCreated}` so `openInventoryIfMissing()` never has to
  guess, and by navigating the new window's initial tab to `INVENTORY_URL`
  in place instead of passing a `url` to `windows.create()` (whose own
  tab isn't reliably queryable immediately either).

**Fix (system-wide stalls in general, not just cause 2):**
`verifySweep()` no longer rejects/blocklists each stalled watched channel
independently. It now collects a verdict per slug in the same sweep; if
2+ slugs were judged and ALL came back stalled, that's treated as a
system-wide cause (screen-off/occlusion, a network hiccup, anything that
would stall everything at once) and none are rotated that sweep - avoids
filling `blockedChannels` with channels that were actually fine while the
whole system was stalled. A single channel stalled while others progress
normally is still rotated exactly as before.

**Docs:** new README section "Known limitation: screen turns off, drop
progress stops (even with the PC not asleep)" explains both causes, what
the extension now does about cause 1, and the `about:config`/`powercfg`
options for cause 2.

**Tests:** `test/drop-verification.test.js` -
`testAllChannelsStalledTogetherSkipsRotation` /
`testOneStalledAmongOthersStillRotates` (the systemic-stall guard, and
that it doesn't shield a genuinely dead channel next to healthy ones).
`test/auto-watch-multi-tab.test.js` - `testWatchTabsIsolatedInDedicatedWindow`,
`testFreshChannelPickFlashesOnlyInsideWatchWindowThenReverts`,
`testNoDuplicateInventoryTabOnFirstWatchWindowCreation` (the dedicated
window, the guarded flash, and the duplicate-tab race respectively). All
seven test files pass; `web-ext lint` clean (0/0/0). `BUILD_MARKER` →
`2026-09-05-r1`, `manifest.json` → 0.6.4.

Committed to `master` as `1d37906`, pushed to GitHub. Submitted to the
public AMO listed channel via `npm run submit:listed` - lint clean
(0/0/0), signed and auto-approved to
`web-ext-artifacts/33d37586a96d443fa884-0.6.4.xpi`, recorded in
`.amo-submitted-versions.json`. Firefox installs auto-update from the AMO
listing.

## 2026-09-10 — "Watch from" picker gets a calendar; a lone finished campaign was never detected as done (0.6.5)

### Watch-from picker: calendar for the date, typed field for the time (requested)

**Problem (reported):** the five `<select>` dropdowns from 0.6.3 (year /
month / day / hour / minute) worked but were awkward - the user wanted to
see a calendar to pick the date, and found the hour+minute selects "too
long" to scroll. They also asked that the date read day-then-month-then-year.

**Fix:** `waitControlEl(game, waitUntil)` in `popup.js` rebuilt.
- **Date:** an inline month-grid calendar drawn in the row itself. It is
  ordinary in-flow popup DOM (`position: static`), not the native
  `<input type="date">` panel, so it cannot render behind the popup (the
  0.6.3 problem) - verified live in `web-ext run` that the rendered `.g-cal`
  computes to `position: static`. `‹` / `›` change month, today is
  outlined, the selected day is filled; weekday header is
  `Intl.DateTimeFormat(locale, {weekday:"narrow"})`, week starts Sunday;
  the month title is the locale month name + a plain Gregorian year (so it
  matches the field, no Buddhist-era mismatch for `th`). The trigger button
  shows the choice as `DD/MM/YYYY`.
- **Time:** a free-text field, not a picker. `parseTime()` accepts 24-hour
  (`14:30`, `1430`, `14`, `24:00`→`00:00`) and 12-hour (`2:30pm`,
  `2.30 PM`, `2pm`, `12am`→`00:00`, `12pm`→`12:00`), case-insensitive,
  optional space before am/pm. On a good parse the field is rewritten to
  the canonical `HH:MM` so the user sees what stuck; an unparseable
  non-empty value turns the field red (`.g-time.invalid`) and is not
  committed (the stored gate stands); blank = midnight.
- The day is still clamped to the chosen month, the stored value is still
  a single epoch-ms `gameWaitUntil[slug]`, and `formatDateTime()` /
  `background.js` are unchanged.
- `popup.html`: the `.g-wait select` rule replaced by `.g-date-field` /
  `.g-time` / `.g-cal*` rules (`.g-wait` now sits in a `.g-wait-box` so the
  calendar can be a block sibling below the flex row). `i18n.js`: seven new
  keys (`wait_pick_date`, `wait_time_ph`, `wait_time_aria`,
  `wait_date_aria`, `wait_cal_prev`, `wait_cal_next`, `wait_at`) across all
  nine languages.

### Fix: a lone finished / expired campaign was never marked done (reported)

**Problem (reported, confirmed live):** with every switch on and drops
collected, the Twitch tabs never closed, no "all claimed" badge appeared,
and the master switch never auto-off'd - even though Twitch's own inventory
showed everything done.

**Root cause (found via `web-ext run` + Firefox RDP against the reporter's
real logged-in profile):** all three symptoms share one signal,
`campaignProgress[slug].allComplete`, set from the `/drops/inventory` DOM
scrape. `findCampaignCardBoundary()` delimits a campaign card by walking up
from its boxart `<img>` until an ancestor's parent holds 2+ boxart images
(i.e. a sibling card). Once every *other* tracked game's drops are
claimed/expired - the normal end state - the "In Progress" section is down
to a single card, that delimiter never appears, and on Twitch's real deeply
nested DOM the 12-step walk runs out still inside the boxart column and
returns `img.parentElement`: a wrapper with **no progress bars and no
text**. So the last remaining game parses to `total: 0` →
`allComplete` / `expired` can never be true → its watch tab never closes →
`watchPhase` never reaches `all-done` → auto-off never fires → the
inventory / campaigns helper tabs stay open. Reproduced exactly against the
reporter's live inventory (one expired "2026 BDO Drops" card): old boundary
→ `total: 0`; new boundary → `total: 1, expired: true`, and after feeding
it through the real pipeline `campaignProgress['black-desert']` updated to
`expired: true`.

**Fix (`content.js`):**
- `findCampaignCardBoundary()`: after the existing count-the-images walk
  fails, a second walk up from the `<img>` returns the first ancestor that
  also encloses a `[role="progressbar"]` - the node where the boxart column
  and the reward-tier column meet, i.e. the card root - capped at 8 levels
  and stopping if it would span 2+ cards. The proven multi-card path is
  untouched; this only runs when the old logic returned nothing.
- `parseInventoryCampaigns()`: a reading with no tier bars and no
  expired / not-connected text is skipped instead of pushed, so a card that
  didn't finish rendering can't overwrite a real earlier
  `campaignProgress` entry with `claimed: 0, total: 0` ("not done" forever).

**Tests:** `test/inventory-parse.test.js` +
`testLoneDeeplyNestedCardStillGetsItsTiers` (one card buried ~16 levels
deep, only one boxart image on the page - still yields its tiers) and
`testEmptyReadingIsNotEmitted` (a no-bars, no-status card is dropped). All
seven test files pass; `web-ext lint` clean (0/0/0). A jsdom check of
`waitControlEl` covered the calendar grid, `DD/MM/YYYY`, the 12h/24h time
parser, invalid-time rejection, and the round-trip from a stored timestamp.
`BUILD_MARKER` → `2026-09-10-r1`, `manifest.json` → 0.6.5.

Committed to `master` as `2c3980b`, pushed to GitHub (`dev` fast-forwarded
to match, local and remote). Submitted to the public AMO listed channel
via `npm run submit:listed` - lint clean (0/0/0), signed and auto-approved
to `web-ext-artifacts/33d37586a96d443fa884-0.6.5.xpi`, recorded in
`.amo-submitted-versions.json`. Firefox installs auto-update from the AMO
listing.

## 2026-09-12 — Experiment: does spoofing Page Visibility help the screen-off stall? (no code shipped)

**Question asked:** for the 0.6.4 cause-2 stall (Firefox suspending
already-playing background video when the monitor turns off), is the
actual culprit Twitch's own JS reading `document.hidden` and pausing
itself, or Firefox's engine suspending decode directly? If the latter,
spoofing `document.hidden`/`visibilityState` from a content script would
be useless. Explicit instruction from the user: find out live before
writing any spoofing code, and do not ship anything from this session.

**Method:** `web-ext run` + Firefox RDP against copies of the real logged-in
profile (same technique as [[rdp-live-testing]]), each copy given a
different `about:config` state, driven by a small reusable RDP client
script (`rdp.mjs`, not checked in) that can eval in both the content world
(`document.*`) and the background page world (`browser.*`, via
`listAddons` → `getWatcher` → `watchTargets`). A tab was forced into a
"background" state via `browser.tabs.update` (selecting a different tab in
the same window), then polled every 3s for `document.hidden`,
`visibilityState`, and the `<video>` element's `paused` / `readyState` /
`currentTime`.

**Finding 1 — the freeze signature is engine-side, not a page script:**
every freeze reproduced (see table below) showed `video.paused` flipping
to `true` **at the same instant** `readyState` dropped from 4 to 3, with
`currentTime` frozen for the duration. A page script calling `pause()`
would not touch `readyState` (HLS segment buffering continues regardless
of the paused flag) - this signature is Gecko's own media pipeline
suspending decode, not Twitch's JS. Confirmed live, four separate profile
configurations, same channel, same harness:

| `about:config` state | Result |
|---|---|
| All defaults (nothing changed) | Froze at ~100s, recovered on its own ~15s later |
| The 3 prefs already documented in the README (`widget.windows.window_occlusion_tracking.enabled`, `media.suspend-bkgnd-video.enabled`, `network.http.throttle.enable`, all `false`) | Froze at ~139s, had **not** recovered 57s later when the run ended |
| Same 3 prefs **+** `dom.ipc.processPriorityManager.backgroundUsesEcoQoS` = `false` (Windows 11's per-process "Efficiency Mode" throttling for background content processes, landed Firefox 108, [bug 1796525](https://bugzilla.mozilla.org/show_bug.cgi?id=1796525)) | No freeze across a 220s run |

**Conclusion on the question asked:** the culprit is the Firefox engine,
confirmed live, not Twitch reading `document.hidden`. **No
`document.hidden`/`visibilityState` spoofing code was written** - the
evidence never supported it, since Gecko's suspend logic never consults
that JS-visible property.

**Finding 2 - the finding above almost led to the wrong fix.** All of the
above used `browser.tabs.update` to force the tab into a plain background
tab (non-selected, in a window shared with other tabs) - which is *not*
how this extension's own 0.6.4 dedicated-window architecture keeps a
watch tab. In production, a watch tab is normally the sole/active tab of
its own dedicated window ([[screen-off-video-stall]]), which is a
different Page Visibility state than "a background tab in a shared
window." Retested against that exact shape: a genuinely separate window
holding only the watch tab (active within it), OS focus given back to a
different window (matching that `background.js` never calls
`windows.update({focused:true})`), then a real 15-minute idle-triggered
screen-off (`display timeout` already at 60s on the test machine; no
synthetic `SC_MONITORPOWER` call this time).

Result: **`document.hidden` stayed `false` for all 300 samples across the
full 15 minutes**, `paused` never flipped, `readyState` never left 4,
`currentTime` advanced in a straight line the entire time. Firefox's
Page Visibility state for a tab is driven by whether it's the *selected*
tab of its own window, not by whether that window has OS focus - so the
0.6.4 dedicated-window design already keeps the watch tab "visible" from
Firefox's point of view even while genuinely off-screen behind other
windows with the monitor off, and none of the suspend paths above ever
engage.

**Decision:** no code changes. The three-run pref comparison (row 2 vs
row 3 of the table) is a real, reproducible difference, but it doesn't
generalize into a fix worth shipping: it was only ever observed against
an artificial same-window-background tab, a shape this extension's own
tabs are not normally in. On the actual shipped tab shape, the stall
did not reproduce at all in 15 real minutes, pref changes or not. README
and the popup are left as they are - the existing three-pref
troubleshooting section stays as a fallback for anyone whose tab
genuinely ends up backgrounded some other way (e.g. manually clicking
into the dedicated window and switching its tab away from the watch
tab), and the `backgroundUsesEcoQoS` pref is not added to it, since one
220-second run isn't enough to promote it and, per this session's second
finding, it likely isn't the operative variable for this extension's own
tabs anyway.

## 2026-09-12 (follow-up) — Repeat runs confirm pref #4 and the dedicated-window finding (0.6.6)

**Why repeat this:** the experiment above drew its `backgroundUsesEcoQoS`
conclusion from a single ~220-second run, and its dedicated-window
conclusion from a single 15-minute run - both explicitly flagged as not
enough to promote into README/popup. This follow-up reruns both, longer
and multiple times, to actually settle it.

**Method:** identical harness and `rdp.mjs` driver as above (not checked
in), run via several `web-ext` instances (staggered, sometimes 2-3
running concurrently against independent fresh copies of the same
profile) to fit the whole matrix into one sitting. Every run used the
real 60-second AC display-idle timeout already set on the test machine
(confirmed via `powercfg /query SCHEME_CURRENT SUB_VIDEO VIDEOIDLE` =
`0x3c`) for a genuine idle-triggered screen-off - no synthetic
`SC_MONITORPOWER` calls this time. `GetLastInputInfo` (Win32, checked
independently of the test harness) confirmed 0 real keyboard/mouse input
for the full test window, so the idle timer was never reset by the
testing process itself.

**Freeze signature, restated so it doesn't need re-deriving next time:**
a real freeze is `video.paused` flipping to `true` at the exact same
polled instant `video.readyState` drops from `4` to `3`, with
`currentTime` frozen for the duration - Gecko's own media pipeline
suspending decode. A page script calling `.pause()` would leave
`readyState` alone, since HLS segment buffering doesn't care about the
paused flag. **Do not mistake an ordinary `readyState` 3/4 fluctuation
for a freeze** - Twitch's own stream sits at `readyState:3` for long
healthy stretches with `paused:false` and `currentTime` still advancing
every single sample (visible throughout both tables below); only
`paused:true` at the same instant means anything.

**Round A - pref #4, same artificial shared-window background-tab shape
as the original experiment above.** Profile: the 3 documented prefs +
`dom.ipc.processPriorityManager.backgroundUsesEcoQoS` = `false`. Three
independent 13-minute (780s) runs, fresh `web-ext` launch and fresh live
channel each time:

| Run | Channel | Samples | `document.hidden` | Freeze? |
|---|---|---|---|---|
| A1 | fubgun | 156 | `true` for all samples (correctly - this shape *is* a real background tab) | None |
| A2 | sappyar | 156 | `true` for all samples | None |
| A3 | sappyar | 155 | `true` for all samples | None |

**Round B - the production dedicated-window shape**, profile = the 3
baseline prefs only, **no pref #4** (testing whether the 0.6.x
architecture alone is enough without any pref). One 13-minute (780s) run,
reusing the extension's own real `watchWindowId` window and real
temporarily-installed background.js (not a hand-rolled substitute),
`autoWatchEnabled` turned off first so the extension's own automation
didn't fight the manually-arranged tab:

| Run | Channel | Samples | `document.hidden` | Screen state | Freeze? |
|---|---|---|---|---|---|
| B | fubgun | 156 | `false` for all 156 samples | ON for ~60-90s, then genuine idle screen-off for the rest | None |

**Verdict on pref #4: confirmed**, not just n=1 anymore. Zero freezes
across all three Round A runs, each over 3x longer than the original
220-second trial that first surfaced it, and well past the ~139s mark
where the baseline-3-prefs-only run froze and never recovered (original
experiment above). `dom.ipc.processPriorityManager.backgroundUsesEcoQoS`
= `false` is promoted to the README's numbered pref list and the popup's
sleep-warning (see "Doc updates" below).

**Verdict on the dedicated-window architecture alone: confirmed
sufficient.** This reproduces the original single 15-minute finding with
an independent run and a longer/more faithful setup (the real production
window and code path, not a re-implementation). With **zero `about:config`
changes at all**, a watch tab that stays the active tab of its own
dedicated window never sees `document.hidden` flip to `true` and never
freezes, even through a genuine idle screen-off.

**None of the four `about:config` prefs (README's numbered list, items
1-4, `backgroundUsesEcoQoS` included) are required for normal use of this
extension, and installing it does not require touching `about:config` at
all.** The dedicated watch window (`getOrCreateWatchWindow()`,
[[screen-off-video-stall]]) already handles the screen-off case on its
own, unconditionally, for every user. All four prefs exist purely as a
troubleshooting fallback for one specific edge case: a watch tab that has
somehow stopped being the active tab of its own dedicated window (e.g. the
user manually clicked into that window and switched its tab away from the
watch tab). Outside that edge case they do nothing observable. A future
session should not read this file and conclude a pref needs to be set
before or during normal operation - it doesn't.

**On Page Visibility spoofing - do not revisit this.** Already ruled out
earlier today (Finding 1 above) and reconfirmed by every sample in both
tables here: every freeze this investigation has ever found is Gecko's
engine suspending decode, never a script reading `document.hidden`. There
is no `document.hidden`/`visibilityState` value a content script could
report that would change Gecko's own suspend decision - spoofing it
cannot work and should not be attempted again by a future session.

**Doc updates from this follow-up:** README.md's numbered `about:config`
list under "Known limitation: screen turns off, drop progress stops" gets
a 4th entry for `dom.ipc.processPriorityManager.backgroundUsesEcoQoS`.
The popup's `#sleepWarning` block (previously about full machine sleep
only) gets one added line per locale in `i18n.js` pointing to that README
section, since it's the same warning surface users already see and the
screen-off case is a distinct failure mode from full sleep that the
existing copy never mentioned.

**Process note:** every test `web-ext`/Firefox/RDP process from this
follow-up (5 `web-ext` runs total: A1, A2, A3, B, plus the initial
connectivity trial) was torn down after its round; the machine was
confirmed free of stray `node.exe`/`firefox.exe` afterward. `rdp.mjs`
remains a disposable scratchpad script, not checked in. The real Firefox
profile the user browses with day-to-day was never touched - all of this
ran against throwaway copies of `D:\ff-twitch-profile`.

Docs/i18n/popup only - no `background.js`/`content.js` changes, so
`BUILD_MARKER` stays `2026-09-10-r1`. `web-ext lint` clean (0/0/0);
`node -c i18n.js` clean. `manifest.json` → 0.6.6.

Committed to `master` as `34e2a05`, pushed to GitHub (`dev` fast-forwarded
to match, local and remote). Submitted to the public AMO listed channel
via `npm run submit:listed` - lint clean (0/0/0), signed and auto-approved
to `web-ext-artifacts/33d37586a96d443fa884-0.6.6.xpi`, recorded in
`.amo-submitted-versions.json`. Firefox installs auto-update from the AMO
listing.

## 2026-09-15 — Fix: a fully-claimed campaign's vanished card never marked the game done (0.6.7)

**Problem (reported):** with every drop for a game actually claimed
(confirmed by the user directly on `/drops/inventory`), the popup kept
showing stale progress (e.g. "5/6") indefinitely, and the game's watch tab
never closed.

**Root cause:** `campaignProgress[slug].allComplete` (the single signal
`isGameDone()` and the popup's "all claimed" badge both key off) is only
ever set inside `mergeInventoryProgress()`, and only for slugs actually
present in the `campaigns` array `content.js` reports. `parseInventoryCampaigns()`
finds cards via a selector scoped to Twitch's "In Progress" section
(`DropsCampaignInProgressDescription-game-card-image`) - once every reward
tier of a campaign is claimed, Twitch removes that card from this section
entirely (it has nothing left "in progress" to show), so the card simply
stops appearing in any future scan. Compounding this, `content.js`'s
`scanInventory()` only sent its `inventoryProgress` message when
`campaigns.length > 0`, so the case where a watched game's card disappeared
- including the common end state where every remaining watched game just
finished at once, leaving zero cards at all - was silently dropped before
it ever reached `background.js`. The last real reading (`claimed: 5, total:
6`) had no path to ever being overwritten.

**Fix:**
- `content.js`: `scanInventory()` now always sends the `inventoryProgress`
  message, even with an empty `campaigns` array - a watched game's card
  being missing is itself a signal, not something to swallow.
- `background.js`: `mergeInventoryProgress()` no longer early-returns on an
  empty `campaigns` array. New reconciliation pass: for every game still on
  `watchList` that has a prior reading with real progress (`total > 0`, not
  already `allComplete`/`expired`) but is absent from the current scan,
  track a per-slug `missingScans` counter. Once a slug has been missing for
  `REQUIRED_MISSING_SCANS` (2) consecutive scans (~2 minutes apart,
  `content.js`'s `inventoryScanIntervalId`), it's inferred `allComplete:
  true` and its watch tab closes - matching the badge Twitch's own
  inventory page already shows. Requiring 2 consecutive misses (not 1)
  keeps this fail-closed against a single mid-render hiccup, the same
  posture as every other DOM-scrape heuristic in this file.

**Tests:** `test/auto-watch-multi-tab.test.js` -
`testCardVanishedFromInProgressMarksComplete` (two watched games; one
game's card vanishes for 2 consecutive scans while the other keeps
reporting normally - asserts the tab stays open after 1 miss, only closes
after the 2nd, and the still-reporting game is untouched throughout). All
seven test files pass; `web-ext lint` clean (0/0/0).

`BUILD_MARKER` → `2026-09-15-r1`, `manifest.json` → 0.6.7.

Committed to `master` as `fe143a4`, pushed to GitHub (`dev` fast-forwarded
to match, local and remote). Submitted to the public AMO listed channel
via `npm run submit:listed` - lint clean (0/0/0), signed and auto-approved
to `web-ext-artifacts/33d37586a96d443fa884-0.6.7.xpi`, recorded in
`.amo-submitted-versions.json`. Firefox installs auto-update from the AMO
listing.

## 2026-09-25 — Fix: a reward counted as claimed at 100% progress, before the claim actually happened (0.6.8)

**Problem (found while checking what a drop card actually shows):** a live
capture of `/drops/inventory` showed a nopixel card with four reward tiers all
at 100% but each still carrying a "Claim Now" button - none of them were in
the page's own Claimed list yet. `parseInventoryCampaigns()` counted any tier
whose `[role="progressbar"]` was at 100% as claimed, so this card read as
4/4 -> `allComplete`, closing its watch tab and marking the game done while
the rewards were still unclaimed.

**Fix:** a tier now counts as claimed only when its reward name is present in
the inventory's Claimed section AND its bar is at 100%.
- `content.js`: `extractTierName(bar)` reads the reward name (real card: name
  `<p>` and bar sit in sibling divs under a per-tier wrapper). New
  `extractClaimedCounts()` reads the Claimed section into a `Map<name, count>`.
  Located structurally, not by text (heading "Claimed" and "N hours ago" are
  locale-dependent): the `<h5>` after the last campaign card, up to the next
  `<h4>`, taking each `<p>` whose parent's previous sibling holds another `<p>`
  (a claimed row is `(div (div time+qty) (div (p NAME)))`).
- Same-named tiers match Claimed entries one-for-one (the nopixel card has two
  "GTA$250K" tiers, so it needs two entries). The 100% guard stops a same-named
  reward from an older campaign marking an unfinished tier claimed.
- `scanInventory()` skips the scan when the Claimed section isn't rendered yet
  (`null` = can't tell) instead of reporting every tier unclaimed; the next
  60s scan retries. Twitch's `DropsListPresentation` (read out of the live JS
  bundle) renders the heading + description whenever it is not loading, and an
  empty-state message (not a list row) for an account with no claims, so an
  empty Map is distinguishable from "not loaded" and the empty-state text is
  never mistaken for a drop name.
- Known limits: Claimed shows only the first page (a "Load More" button we
  never click) so a very old claim can read as unclaimed; a game whose card
  has vanished from In Progress is still handled by the 0.6.7 inference.

**Verified live** against the real page: 20 Claimed entries; WoW BlizzCon
card -> "Cuddly Blue Grrgle" and "200 Trader's Tender" claimed (2 of 4),
nopixel card -> 0 of 4 (all pending "Claim Now"). Noted in passing: campaign
cards still show no game name, and the WoW boxart URL (`ttv-boxart/18122-285x380.jpg`)
has no `_IGDB-` segment, which `extractGameIdFromBoxart()`'s regex would not
match - not changed here, worth a separate look.

**Tests:** `test/inventory-parse.test.js` fixtures rebuilt to the real tier
and Claimed-row structure; added a 100%-but-not-in-Claimed case, duplicate
names, name-in-Claimed-with-bar-below-100%, and missing vs. empty Claimed
section. All seven test files pass; `web-ext lint` clean (0/0/0).

`BUILD_MARKER` -> `2026-09-25-r1`, `manifest.json` -> 0.6.8.

Committed to `master` as `7fa3508`, pushed to GitHub (`dev` fast-forwarded
to match, local and remote). Submitted to the public AMO listed channel
via `npm run submit:listed` - lint clean (0/0/0), signed and auto-approved
to `web-ext-artifacts/33d37586a96d443fa884-0.6.8.xpi`, recorded in
`.amo-submitted-versions.json`. Firefox installs auto-update from the AMO
listing.

## 0.6.9 - leave a channel that went offline or switched game

**Problem:** a watched streamer ending the stream or switching to another game
did not make the extension change channel. content.js only recognised an
offline page by Twitch's offline marker classes/text, and had no check for a
category change at all, so both cases waited for `verifyDropStatus`'s
17-minute progress comparison (which also fails closed when no
`timeRemainingMin` can be read). Even after bouncing to the directory,
`pickBestChannel()` could re-pick the same channel while Twitch's listing
still showed it.

**Fix:**
- `channelProblem()` (content.js) returns `"offline"` or `"game:<slug>"`. The
  game comes from `[data-a-target="stream-game-link"]` (href
  `/directory/category/<slug>`, captured live) compared with the slug the tab
  was picked for. A page that was live (viewer count seen) and lost the
  viewer count without any offline marker also counts as offline; a player
  content gate never does.
- The same problem must be seen again 10s later before acting, so a page
  mid-render does not bounce a good channel. Checked on the existing 60s tick.
- background.js `handleChannelUnusable()` (new `channelGameChanged` message,
  plus the existing `channelOffline`) blocks that channel for 20 min
  (`UNUSABLE_CHANNEL_COOLDOWN_MS`) so it is not re-picked. Deliberately
  shorter than `rejectChannel`'s 45 min and it leaves `watchMeta`/`dropSignals`
  alone; raids/redirects stay log-only.

**Verified live** (web-ext + RDP against a logged-in profile, watch tab on
Halo Infinite): rewriting the stream game link to `just-chatting` on the
channel page -> within ~1.5 min the tab returned to the directory, picked a
different channel and the old one was in `blockedChannels` with a ~20 min
expiry; removing the viewer-count element on the next channel -> same, moved
to a third channel and blocked.

**Tests:** `test/channel-live-detection.test.js` gains game-change (same,
case-insensitive, different, link not rendered) and ended-stream-without-
marker (was live / never live / content gate / explicit offline) cases. All
test files pass.

`BUILD_MARKER` -> `2026-09-27-r1`, `manifest.json` -> 0.6.9.

Committed to `master` as `53ffe98`, pushed to GitHub (`dev` fast-forwarded to
match, local and remote). Submitted to the public AMO listed channel via
`npm run submit:listed` - lint clean (0/0/0), signed and auto-approved to
`web-ext-artifacts/33d37586a96d443fa884-0.6.9.xpi`, recorded in
`.amo-submitted-versions.json`. Firefox installs auto-update from the AMO
listing.

## 0.6.10 - game-change check no longer depends on the directory slug

**Problem:** 0.6.9's game-change check compared the channel page's category
slug with the slug the tab was picked for. Those can legitimately differ (a
renamed/aliased game whose directory slug isn't the one Twitch puts on the
channel page), which would bounce a perfectly good channel every time - the
limitation flagged when 0.6.9 shipped.

**Fix:** `channelProblem(baselineGame, seenLive)` now compares against the
category the channel showed the first time it was seen live (`baselineGame`,
set on the first 60s tick), so only a real change while watching counts.
A channel already under the wrong category at pick time is still the drop-
progress verification's job.

**Verified live** (web-ext + RDP, Halo Infinite watch tab): rewriting the
stream game link to a slug unlike the expected one before the first tick ->
no bounce after 100s (the 0.6.9 logic would have bounced); changing it again
afterwards -> tab returned to the directory, picked another channel, old one
blocked ~20 min.

**Tests:** game-change test now uses a baseline (same, case-insensitive,
changed, link missing, no baseline yet). All test files pass.

`BUILD_MARKER` -> `2026-09-27-r2`, `manifest.json` -> 0.6.10.

Committed to `master` as `9345155`, pushed to GitHub (`dev` fast-forwarded
to match). Submitted to the public AMO listed channel via
`npm run submit:listed` - lint clean (0/0/0), signed and auto-approved to
`web-ext-artifacts/33d37586a96d443fa884-0.6.10.xpi`, recorded in
`.amo-submitted-versions.json`.
