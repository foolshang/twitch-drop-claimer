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
