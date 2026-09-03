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
