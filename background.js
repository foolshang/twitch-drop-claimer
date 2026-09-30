/**
 * Twitch Drop Auto-Claimer - background script
 * (loaded after shared.js - toSlug/channelFromUrl/directoryUrl come from there)
 *
 * Three independent jobs (plus a passive snapshot, see 4):
 *
 * 1. Inventory upkeep (unchanged from before): Twitch's inventory page
 *    doesn't always update progress live, so if a tab is open on
 *    twitch.tv/drops/inventory we reload it every 15 minutes so the content
 *    script can click any newly-available Claim buttons.
 *
 * 2. Auto-watch orchestration: given an ordered list of games
 *    (browser.storage.local `watchList`), keep one pinned background tab per
 *    eligible game open at once (up to `tabQuota` concurrently, default 3),
 *    each pointed at a live, low-viewer channel of its own game. Games
 *    beyond the quota queue up in priority order. A game's tab closes on its
 *    own the moment that game is fully claimed / expired / invalid / removed
 *    from the list - the other tabs are unaffected. Once every game in the
 *    list is done, all watch tabs close and the badge shows "done".
 *
 *    An entry typed as "@channel" (see parseWatchList in shared.js) pins a
 *    specific channel instead of a game: its tab goes straight to that
 *    channel (never the directory), waits for it to go live rather than
 *    rotating to another channel, and is never blocklisted/rotated by
 *    verifyDropStatus for stalling - see handleChannelPlayingGame for how
 *    it gets bound to whatever game the channel is actually playing.
 *
 * 3. Drop-status verification: a channel a watch tab is parked on might
 *    never credit us - either it's a "fake category" stream (listed under a
 *    game's drops directory without that game's drop campaign actually
 *    attached) or it genuinely went offline/got raided away after being
 *    picked. Both cases have the exact same observable symptom (campaign
 *    progress stops moving) and the exact same fix (rotate to a different
 *    channel), so there is deliberately only ONE decision-maker for both:
 *    verifyDropStatus() cross-checks each watched channel against the
 *    campaign progress already scraped from the DOM of the always-open
 *    /drops/inventory tab (content.js's parseInventoryCampaigns, fed via the
 *    "inventoryProgress" message / mergeInventoryProgress()) a while after
 *    it's picked, and rotates the tab to the next channel if that campaign's
 *    numbers haven't moved. See the "drop-status verification" section below
 *    for the full decision logic.
 *
 *    content.js's own DOM check (looksLive()/looksOffline(), every 60s)
 *    still runs and still bounces the tab back to the directory as soon as
 *    it thinks a channel went offline or got raided - that's a real,
 *    valuable speedup (the tab physically leaves faster than waiting on
 *    campaign progress). What it must NOT do, and no longer does, is decide
 *    on its own that the channel should be rejected/blocklisted: a false
 *    positive there (DOM selectors are unverified against Twitch's actual
 *    markup, same caveat as every other DOM heuristic in this project)
 *    would blocklist a channel that was actually fine. Only
 *    verifyDropStatus's campaign-progress comparison may reject a channel.
 *    A prior version of this file also tried a DOM-independent GQL
 *    "playback beacon silence" signal (SendEvents) as a second, faster,
 *    independent rotation trigger - reverted after it produced false
 *    positives against live, crediting channels in practice; see HISTORY.md.
 *    Known accepted cost of the current single-decision-maker design: an
 *    offline channel can take up to VERIFY_DELAY_MS (17 min) to rotate away,
 *    traded deliberately for never wrongly rejecting a channel that's fine.
 *
 *    verifyDropStatus() used to instead sniff Twitch's own GraphQL
 *    responses from the *channel* tab itself (gql-bridge.js/inject.js)
 *    looking for DropsHighlightService_AvailableDrops. Verified with real
 *    instrumentation against a real pinned/hidden watch tab (195+ GQL
 *    operations captured over one session) that this operation - and every
 *    other drops-related one tried so far - never fires at all in a
 *    background (active:false) tab; Twitch apparently only issues it from a
 *    mounted, visible player UI component. gql-bridge.js/inject.js are kept
 *    only for the id->name / id->slug / open-campaign snapshot extractors
 *    (see inject.js), not for anything verifyDropStatus currently relies on.
 *
 * 4. Open-campaign snapshot (PASSIVE ONLY): whenever the user themselves has
 *    /drops/campaigns open, inject.js extracts the ViewerDropsDashboard GQL
 *    response and it is stored as `openCampaigns`, which drives
 *    annotateWatchListFromCampaigns() and autoWatchTick's lacksOpenCampaign()
 *    gate (that gate fails open once the snapshot is older than
 *    OPEN_CAMPAIGNS_MAX_AGE_MS). This file NEVER opens /drops/campaigns
 *    itself any more - a former transient background tab for it (refreshed
 *    every 45 min) got in the way of the user browsing other campaigns and
 *    was removed in 0.6.14. See the "open drop-campaign snapshot" section.
 *
 * The three tab-driving jobs are fully gated on the `enabled` flag in browser.storage.local -
 * once switched off, nothing here may open a tab, reload one, or fire a
 * request again. Auto-watch is additionally gated on `autoWatchEnabled`.
 *
 * Tab etiquette (verified below, not just assumed):
 *   - every tabs.create/tabs.update call below passes an explicit
 *     `active: false`, with ONE deliberate, narrow exception:
 *     flashTabToStartPlayback() briefly sets `active: true` then back to
 *     `false` a few seconds later, and ONLY after the caller has confirmed
 *     (via tab.windowId) the tab is inside the dedicated watch window from
 *     getOrCreateWatchWindow() - never the window the user is actually
 *     using. It exists because live RDP capture (2026-09-04) found Twitch's
 *     own player sometimes never starts video at all in a tab that was
 *     created active:false and never once became its window's active tab -
 *     no console error, intermittent per channel. A background window kept
 *     minimized was tried first instead (avoids ever touching `active` at
 *     all) but live-verified NOT to work: `document.visibilityState` stays
 *     `"hidden"` for a minimized window (also for one positioned off-screen
 *     - Firefox's occlusion tracking, not just the `minimized` flag,
 *     decides this) and Twitch's player never starts either way. The flash
 *     was the only thing confirmed to reliably fix it.
 *   - muting is done at the browser level via tabs.update({muted:true})
 *     right after a watch tab is created - never by clicking Twitch's own
 *     mute button (that part was removed from content.js).
 *   - windows.update({focused:true}) is never called anywhere in this file.
 *     The one window-focus-adjacent call, getOrCreateWatchWindow()'s
 *     windows.create(), is a one-time (per browser session) creation of the
 *     dedicated watch window - not a per-tab focus grab.
 *   - content.js's own same-tab `location.href = ...` navigation (picking a
 *     channel from the directory, bouncing back to the directory on
 *     offline/raid) never changes tab activation - navigating a page's own
 *     location is not a WebExtension action and has no "active" concept, so
 *     a background tab navigating itself stays in the background. This is
 *     inherent browser behavior, not something this file needs to enforce.
 */

// unconditional, first thing this script does on every load/reload - proves
// which build of background.js is actually running, independent of
// anything else. Compare against the BUILD_MARKER value in shared.js.
console.log(
  "[DropClaimer] BUILD_MARKER =", BUILD_MARKER,
  "| manifest version =", browser.runtime.getManifest().version,
  "| loaded at", new Date().toISOString()
);

const RELOAD_ALARM = "reload-inventory";
const RELOAD_PERIOD_MIN = 15;
const AUTO_OFF_ALARM = "auto-off-check";
const AUTO_OFF_PERIOD_MIN = 10;
const AUTO_WATCH_ALARM = "auto-watch-tick";
const AUTO_WATCH_PERIOD_MIN = 1;
const INVENTORY_URL = "https://www.twitch.tv/drops/inventory";
// small always-on relay (Python stdlib HTTP server on a GCE VM, see
// scripts/ - not checked into this repo) that turns a POST'd debug log into
// a GitHub issue on foolshang/twitch-drop-claimer. Exists so "send bug
// report" can be one click without ever shipping a GitHub write token
// inside this extension's own public, fully-inspectable source - the token
// lives only in that relay's environment. X-Client is not a secret, just a
// noise filter against generic internet scanners hitting the endpoint.
// HTTPS on purpose: a plain http:// IP:port endpoint is blocked outright by
// Firefox's HTTPS-Only Mode (fetch -> "NetworkError", live-verified
// 2026-09-28 - with it on, even a GET failed while curl worked). Caddy on
// the VM terminates TLS for this sslip.io name (wildcard DNS that resolves
// to the VM's static IP, so no domain purchase) and proxies to the relay.
const REPORT_BUG_URL = "https://35-188-24-245.sslip.io/report";
const REPORT_BUG_CLIENT_HEADER = "twitch-drop-claimer";
// how stale the openCampaigns snapshot may be before autoWatchTick refuses
// to act on "this game has no open campaign" (fail open on older data)
const OPEN_CAMPAIGNS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TAB_QUOTA = 3;
const EMPTY_COOLDOWN_MS = 5 * 60 * 1000; // how long a "nobody live" game sits out before retrying
// how long a game sits out after its directory page looked "invalid"
// (content.js's directoryIntervalId found the tab redirected away from
// /directory/category/<slug>) before automatically retrying. Used to be
// permanent (never retried at all) until a real, confirmed-real category
// ("path-of-exile-2" - actively watched with real progress minutes earlier
// the same session) got marked invalid, meaning "invalid" can be a
// transient false read (timing/redirect race), not always a genuinely
// wrong slug - same principle as EMPTY_COOLDOWN_MS/CHANNEL_BLOCK_COOLDOWN_MS
// above: never permanently give up on a signal that might be wrong.
const INVALID_SLUG_RETRY_MS = 45 * 60 * 1000;

// drop-status verification: catches channels that are listed under a game's
// drops directory but aren't actually broadcasting with that game's drop
// campaign attached ("fake category"), so watching them never accrues
// progress. See verifyDropStatus() below.
//
// This has to be long enough that the /drops/inventory tab's own numbers
// have had a real chance to change, not just long enough for our own code
// to re-check. content.js re-scrapes the inventory DOM every 60s regardless
// of whether Twitch's underlying data changed, so a short delay here would
// mostly measure "did content.js happen to re-scan" rather than "did this
// channel actually credit us" - a false-positive rotation trap. The one
// guaranteed-fresh data point we have is RELOAD_ALARM's periodic hard
// reload of the inventory tab (RELOAD_PERIOD_MIN), so this is set to
// comfortably outlast one full reload cycle.
const VERIFY_DELAY_MS = (RELOAD_PERIOD_MIN + 2) * 60 * 1000; // 17 min
const CHANNEL_BLOCK_COOLDOWN_MS = 45 * 60 * 1000; // don't immediately re-pick a channel we just rejected
const UNUSABLE_CHANNEL_COOLDOWN_MS = 20 * 60 * 1000; // offline / switched game (see handleChannelUnusable)

// A watched game's card vanishing from /drops/inventory's "In Progress"
// section (parseInventoryCampaigns returning nothing for its slug) usually
// means every reward tier just got claimed and Twitch moved/removed the card
// - but a single miss could just be a mid-render hiccup. Require this many
// consecutive scans (each ~60s apart, content.js's inventoryScanIntervalId)
// with the card absent before inferring allComplete, matching the fail-closed
// posture used everywhere else in this file.
const REQUIRED_MISSING_SCANS = 2;

// In-memory ring buffer of every log() line this file emits (rejectChannel,
// handleChannelUnusable's "unusable (offline|game:<slug>)" line, verify, ...).
// exportDebugLogToFile() below writes it to a plain-text file so it can be
// read without needing remote-debugging access to the user's real, logged-in
// browser profile - see HISTORY.md 2026-09-27.
const DEBUG_LOG_MAX_LINES = 1000;
const debugLogBuffer = [];
function pushDebugLog(line) {
  debugLogBuffer.push(line);
  if (debugLogBuffer.length > DEBUG_LOG_MAX_LINES) debugLogBuffer.shift();
}

const log = (...args) => {
  const rendered = args.map((a) => {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ");
  pushDebugLog(`[${new Date().toISOString()}] [bg] ${rendered}`);
  console.log("[DropClaimer]", ...args);
};

// Firefox's downloads API resolves a bare relative filename against whatever
// folder the browser is actually configured to save downloads to
// (browser.download.dir) - NOT necessarily a folder literally named
// "Downloads" (confirmed live: this project's own test profile has it set to
// D:\Browser). conflictAction "overwrite" + a fixed name keeps this one file
// up to date across writes instead of piling up "(1)", "(2)", ... copies.
// exportDebugLogToFile() resolves the real on-disk path via
// downloads.search() rather than asserting one, so the popup can show where
// the file actually landed instead of guessing wrong.
const DEBUG_LOG_FILENAME = "twitch-drop-claimer-debug.log";
async function exportDebugLogToFile() {
  const text = debugLogBuffer.length ? debugLogBuffer.join("\n") + "\n" : "(no log lines yet)\n";
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  try {
    const id = await browser.downloads.download({
      url,
      filename: DEBUG_LOG_FILENAME,
      conflictAction: "overwrite",
      saveAs: false,
    });
    for (let i = 0; i < 20; i++) {
      const [item] = await browser.downloads.search({ id });
      if (item && item.state === "complete") return { ok: true, path: item.filename };
      if (item && item.state === "interrupted") return { ok: false, error: item.error || "interrupted" };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: true, path: null }; // still in progress - unusual for a small text blob, don't block on it forever
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    // give the download time to actually read the blob before revoking
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

// manual "send bug report" button in popup.js - posts the same log text
// exportDebugLogToFile() writes locally to REPORT_BUG_URL instead, which
// creates a GitHub issue and hands back its number/URL. Never sends
// anything except this log text (channel/game names, timestamps, internal
// decisions - never login/tokens, same content as the local export).
//
// The relay rejects a body over 60,000 bytes - and does so with a 413 it
// sends before reading the body, so the connection is reset and fetch()
// only surfaces an opaque "NetworkError" (a full 1000-line buffer easily
// exceeds that). So the whole log is never sent as one request: it is cut
// on line boundaries into parts whose `log` field stays under
// REPORT_CHUNK_MAX_BYTES (measured as JSON-escaped UTF-8, i.e. what goes on
// the wire), each sent as its own request/issue, tagged "part i/n" plus a
// shared report id so the issues can be matched up.
const REPORT_CHUNK_MAX_BYTES = 49_000; // + header/JSON wrapper stays under 50 KB

const jsonEscapedBytes = (s) => new TextEncoder().encode(JSON.stringify(s)).length - 2;

// slices one over-long line so every piece fits maxBytes even if every char
// escapes to \uXXXX (6 bytes); never cuts a surrogate pair in half
function sliceLongLine(line, maxBytes) {
  if (jsonEscapedBytes(line) <= maxBytes) return [line];
  const maxChars = Math.floor(maxBytes / 6);
  const pieces = [];
  for (let i = 0; i < line.length;) {
    let end = Math.min(i + maxChars, line.length);
    const c = line.charCodeAt(end - 1);
    if (end < line.length && c >= 0xd800 && c <= 0xdbff) end--;
    pieces.push(line.slice(i, end));
    i = end;
  }
  return pieces;
}

function splitLogForReport(lines, maxBytes = REPORT_CHUNK_MAX_BYTES) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const line of lines) {
    for (const piece of sliceLongLine(line, maxBytes)) {
      const cost = jsonEscapedBytes(piece) + 2; // the joining "\n" escapes to 2 bytes
      if (cur.length && size + cost > maxBytes) {
        chunks.push(cur.join("\n"));
        cur = [];
        size = 0;
      }
      cur.push(piece);
      size += cost;
    }
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks;
}

async function postBugReportPart(text, meta) {
  try {
    const res = await fetch(REPORT_BUG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client": REPORT_BUG_CLIENT_HEADER },
      body: JSON.stringify({ log: text, ...meta }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      return { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
    }
    return { ok: true, issue: data.issue, url: data.url };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function reportBugToGitHub() {
  const lines = debugLogBuffer.length ? debugLogBuffer : ["(no log lines yet)"];
  const cfg = await browser.storage.local.get("uiLang");
  const meta = { version: browser.runtime.getManifest().version, lang: cfg.uiLang || "?" };
  const chunks = splitLogForReport(lines);
  const reportId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const urls = [];
  let firstIssue = null;
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks.length > 1
      ? `=== bug report ${reportId} - part ${i + 1}/${chunks.length} ===\n${chunks[i]}`
      : chunks[i];
    const r = await postBugReportPart(text, meta);
    if (!r.ok) {
      // stop at the first failure: later parts would only pile more
      // half-reports onto the relay's hourly rate limit
      const where = chunks.length > 1 ? `part ${i + 1}/${chunks.length} (${urls.length} sent): ` : "";
      return { ok: false, error: where + r.error, sent: urls.length, parts: chunks.length };
    }
    if (firstIssue == null) firstIssue = r.issue;
    urls.push(r.url);
  }
  return { ok: true, issue: firstIssue, url: urls[0], urls, parts: chunks.length };
}

// Auto-export is throttled (rather than firing on every single event) so a
// burst of channel rotations doesn't spam the user's Downloads folder/toolbar
// with repeated overwrites of the same file.
const AUTO_EXPORT_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastAutoExportAt = 0;
function maybeAutoExportDebugLog() {
  const now = Date.now();
  if (now - lastAutoExportAt < AUTO_EXPORT_MIN_INTERVAL_MS) return;
  lastAutoExportAt = now;
  exportDebugLogToFile().then((r) => {
    if (!r.ok) log("auto debug-log export failed:", r.error);
  });
}

// serializes every auto-watch mutation so concurrent tab events (multiple
// games finishing/going offline near-simultaneously) can't race each other
// on a storage.local read-modify-write
let taskChain = Promise.resolve();
function serialized(fn) {
  const run = taskChain.then(fn, fn);
  taskChain = run.catch(() => {});
  return run;
}

// ============================================================================
// badge
// ============================================================================
async function refreshBadge() {
  const cfg = await browser.storage.local.get(["enabled", "watchPhase", "uiLang"]);
  const enabled = cfg.enabled ?? true;
  const navLang = typeof navigator !== "undefined" ? navigator.language : "";
  const lang = i18nResolveLang(cfg.uiLang, navLang);

  if (!enabled) {
    browser.browserAction.setBadgeText({ text: "OFF" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#6d6d75" });
    browser.browserAction.setTitle({ title: i18nT(lang, "tt_off") });
    return;
  }

  if (cfg.watchPhase === "all-done") {
    browser.browserAction.setBadgeText({ text: "✓" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#00f593" });
    browser.browserAction.setTitle({ title: i18nT(lang, "tt_all_done") });
    return;
  }

  browser.browserAction.setBadgeText({ text: "" });
  browser.browserAction.setBadgeBackgroundColor({ color: "#00f593" });
  browser.browserAction.setTitle({ title: i18nT(lang, "tt_running") });
}

// ============================================================================
// dedicated watch window - isolates every tab this extension opens from
// whatever the user is actually doing (see the tab-etiquette comment at the
// top of this file). Needed for the brief active:true flash in
// handleDirectoryPicked below: Twitch's own player does not reliably start
// video in a tab that has never been the active tab of its window (live RDP
// capture, 2026-09-04 - some channels' players simply never issue the
// PlaybackAccessToken/usher fetch otherwise, no console error). A flash is
// the only thing confirmed to fix that, so it must happen somewhere the
// user is never looking - a separate window they didn't ask to see, not a
// tab switch in whatever window they're using for YouTube/anything else.
// ============================================================================
// Returns { id, freshlyCreated }. freshlyCreated tells callers whether this
// call's window is the one that just got its initial tab navigated to
// INVENTORY_URL right here - openInventoryIfMissing() relies on that
// instead of re-querying browser.tabs right after, because whether
// browser.tabs.query() reflects a just-created/just-navigated tab by the
// very next call is not guaranteed (produced a real duplicate inventory tab
// in a live test, 2026-09-04).
//
// Window and tab ids only mean something inside ONE browser session (Firefox
// numbers them from 1 again on every start), and Firefox's session restore
// brings back last session's watch window - pinned watch tabs and all - so
// three things are handled here (2026-09-28: a restart used to give the user
// three windows, and a remembered id can even equal one of their own):
//   - resetStateForNewBrowserSession(): a fresh session forgets every
//     remembered tab/window id;
//   - findWatchWindowCandidates()/adoption below: an existing window that
//     looks like ours (all tabs pinned twitch.tv, one of them the inventory)
//     is adopted instead of opening a second one, with its stale tabs closed;
//   - sweepStaleWatchLeftovers(): any further such window (session restore
//     can land after the first tick) and any pinned /drops/campaigns tab in
//     the watch window (left behind by versions before 0.6.14) is closed.
async function resetStateForNewBrowserSession() {
  if (!browser.storage.session) return false; // no per-session storage -> nothing to compare against
  const { tdcSessionStarted } = await browser.storage.session.get("tdcSessionStarted");
  if (tdcSessionStarted) return false;
  await browser.storage.session.set({ tdcSessionStarted: Date.now() });
  await browser.storage.local.set({ watchTabs: {}, watchMeta: {}, dropSignals: {}, watchWindowId: null, claimHealth: null });
  claimBackoff = new Map(); // and every reward's claim backoff (see getClaimBackoff)
  try { await browser.storage.session.set({ claimBackoff: {} }); } catch { /* best effort */ }
  log("new browser session (or the extension was just loaded): forgot remembered watch tab/window ids");
  return true;
}

const isTwitchUrl = (u) => /^https?:\/\/([^/]+\.)?twitch\.tv(\/|$)/.test(u || "");
// Windows that look like a leftover/restored watch window of ours. Every tab
// must be one of: a pinned twitch.tv tab, the drops inventory (pinned or not -
// a freshly created watch window's initial tab is navigated to it unpinned),
// or Firefox's own blank/home page (windows.create() leaves an about:home tab
// behind - seen in the real session file). At least one tab must be the
// inventory and - unless `loose` - at least one a pinned twitch.tv tab. Any
// ordinary tab (a YouTube tab, the user's own unpinned Twitch tab, an
// extension page) means it is the user's window, never ours. `loose` is only
// for ADOPTING a window (a lone-inventory window from before an extension
// reload is still ours to reuse); CLOSING one always uses the strict form,
// since a user looking at their inventory in a window of its own must be safe.
// A tab that is still loading is never "blank": a tab the user just opened with
// a URL (Firefox started with one, a link opened in a new tab) reports
// about:blank until its navigation commits, and treating it as blank made the
// user's window look like ours - adoption then closed their campaigns tab.
const isBlankTab = (t) => /^about:(blank|home|newtab)$/.test(t.url || "") && t.status !== "loading";
// How long a window that only qualifies thanks to a blank tab must keep
// qualifying before we adopt or close it (a navigation that has not reported
// "loading" yet has committed by then).
const ADOPT_SETTLE_MS = 1_500;
const isInventoryTab = (t) => isTwitchUrl(t.url) && /\/drops\/inventory/.test(t.url || "");
async function findWatchWindowCandidates({ loose = false } = {}) {
  let wins;
  try {
    wins = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
  } catch { return []; }
  return (wins || []).filter((w) => {
    const tabs = w.tabs || [];
    return tabs.length > 0 &&
      tabs.every((t) => (t.pinned && isTwitchUrl(t.url)) || isInventoryTab(t) || isBlankTab(t)) &&
      tabs.some(isInventoryTab) &&
      (loose || tabs.some((t) => t.pinned && isTwitchUrl(t.url)));
  });
}

// findWatchWindowCandidates() for the callers that ADOPT or CLOSE what it
// returns. A window that qualifies only because a tab is momentarily blank
// (the user's new tab before its navigation commits) is looked at again after
// ADOPT_SETTLE_MS and kept only if it still qualifies; the tab lists of the
// second look are returned, so nothing that navigated in between is touched.
async function findSettledWatchWindowCandidates(opts) {
  const first = await findWatchWindowCandidates(opts);
  if (!first.some((w) => w.tabs.some(isBlankTab))) return first;
  await new Promise((resolve) => setTimeout(resolve, ADOPT_SETTLE_MS));
  const firstIds = new Set(first.map((w) => w.id));
  return (await findWatchWindowCandidates(opts)).filter((w) => firstIds.has(w.id));
}

async function adoptExistingWatchWindow() {
  const strict = await findSettledWatchWindowCandidates();
  const strictIds = new Set(strict.map((w) => w.id));
  const loose = (await findSettledWatchWindowCandidates({ loose: true })).filter((w) => !strictIds.has(w.id));
  const candidates = [...strict, ...loose]; // an unmistakable watch window is preferred
  if (candidates.length === 0) return null;
  const [keep, ...others] = candidates;
  for (const w of others) {
    if (!strictIds.has(w.id)) continue; // a loose-only match could be the user's - never closed
    log("closing an extra leftover watch window", w.id);
    try { await browser.windows.remove(w.id); } catch { /* already gone */ }
  }
  // keep one inventory tab (the one the extension refreshes); everything else
  // in there is a stale watch/campaigns tab from before the restart
  let keptInventory = false;
  for (const t of keep.tabs) {
    if (!keptInventory && /\/drops\/inventory/.test(t.url || "")) { keptInventory = true; continue; }
    try { await browser.tabs.remove(t.id); } catch { /* already gone */ }
  }
  await browser.storage.local.set({ watchWindowId: keep.id });
  log("adopted the existing watch window", keep.id, "instead of opening another");
  return keep.id;
}

async function sweepStaleWatchLeftovers() {
  const { watchWindowId } = await browser.storage.local.get("watchWindowId");
  if (!watchWindowId) return;
  let closedInventoryWindow = false;
  for (const w of await findSettledWatchWindowCandidates()) {
    if (w.id === watchWindowId) continue;
    log("closing a stale watch window", w.id, "(restored from an earlier session)");
    try { await browser.windows.remove(w.id); closedInventoryWindow = true; } catch { /* already gone */ }
  }
  try {
    for (const t of await browser.tabs.query({ windowId: watchWindowId, pinned: true })) {
      if (/\/drops\/campaigns/.test(t.url || "")) {
        log("closing a leftover pinned /drops/campaigns tab", t.id);
        try { await browser.tabs.remove(t.id); } catch { /* already gone */ }
      }
    }
  } catch { /* window gone - the next getOrCreateWatchWindow recreates it */ }
  if (closedInventoryWindow) await openInventoryIfMissing();
}

let watchWindowCreateInFlight = null;
async function getOrCreateWatchWindow() {
  const cfg = await browser.storage.local.get("watchWindowId");
  if (cfg.watchWindowId) {
    try {
      await browser.windows.get(cfg.watchWindowId);
      return { id: cfg.watchWindowId, freshlyCreated: false };
    } catch {
      // closed by the user (or gone) - fall through and make a new one
    }
  }
  if (watchWindowCreateInFlight) return watchWindowCreateInFlight;
  watchWindowCreateInFlight = (async () => {
    try {
      const adopted = await adoptExistingWatchWindow();
      if (adopted != null) return { id: adopted, freshlyCreated: false };
      const win = await browser.windows.create({ type: "normal" }); // blank - navigated below
      await browser.storage.local.set({ watchWindowId: win.id });
      const initialTab = win.tabs && win.tabs[0];
      if (initialTab) {
        try { await browser.tabs.update(initialTab.id, { url: INVENTORY_URL }); } catch { /* best-effort */ }
      }
      return { id: win.id, freshlyCreated: true };
    } catch (e) {
      log("getOrCreateWatchWindow: could not create a dedicated window, falling back to the current window:", e);
      return { id: null, freshlyCreated: false };
    } finally {
      watchWindowCreateInFlight = null;
    }
  })();
  return watchWindowCreateInFlight;
}

// ============================================================================
// inventory tab upkeep
// ============================================================================
async function openInventoryIfMissing() {
  const tabs = await browser.tabs.query({ url: "*://www.twitch.tv/drops/inventory*" });
  if (tabs.length === 0) {
    const { id: watchWindowId, freshlyCreated } = await getOrCreateWatchWindow();
    if (freshlyCreated) {
      // its initial tab was already navigated to INVENTORY_URL
      log("dedicated watch window created with the inventory tab already open");
    } else {
      await browser.tabs.create({ url: INVENTORY_URL, active: false, pinned: true, ...(watchWindowId ? { windowId: watchWindowId } : {}) });
      log("opened inventory tab");
    }
  }
}

// ---- claim backoff, one state for every tab --------------------------------
// content.js (any tab) asks `claimAsk` before it clicks a claim button and
// reports the verdict 12 s later (`claimResult`, see verifyClaim there);
// background.js owns the per-reward state (shared.js: CLAIM_*):
//   { f: failures in a row, next: earliest next click, stop: given up }
// plus, in memory only, `inflightAt`: a tab holds the reward's claim from the
// moment `claimAsk` said yes until its verdict, so of several tabs looking at
// the same button only one clicks per round (a tab that dies before reporting
// stops holding it after CLAIM_INFLIGHT_TTL_MS, no failure counted). The state
// outlives any tab (closing/reopening the inventory does not reset it) and is
// mirrored into storage.session; a new browser session forgets it (see
// resetStateForNewBrowserSession). The decision + bookkeeping in each handler
// has no await between reading and writing the map, so two tabs asking in the
// same instant cannot both be told yes.
const CLAIM_INFLIGHT_TTL_MS = 60_000;
let claimBackoff = null; // Map: reward key -> { f, next, stop, inflightAt? }

async function getClaimBackoff() {
  if (claimBackoff) return claimBackoff;
  let stored = {};
  try {
    if (browser.storage.session) stored = (await browser.storage.session.get("claimBackoff")).claimBackoff || {};
  } catch { /* no per-session storage: memory only */ }
  if (!claimBackoff) claimBackoff = new Map(Object.entries(stored)); // a concurrent caller / reset may have set it meanwhile
  return claimBackoff;
}

function saveClaimBackoff() {
  if (!browser.storage.session || !claimBackoff) return;
  const out = {};
  for (const [key, st] of claimBackoff) out[key] = { f: st.f, next: st.next, stop: st.stop };
  browser.storage.session.set({ claimBackoff: out }).catch(() => {});
}

async function handleClaimAsk(msg) {
  const map = await getClaimBackoff();
  const key = String(msg.key || "");
  const now = Date.now();
  const st = map.get(key);
  if (!claimBackoffAllows(st, now)) return { allowed: false, reason: st.stop ? "stopped" : "backoff" };
  if (st && st.inflightAt && now - st.inflightAt < CLAIM_INFLIGHT_TTL_MS) return { allowed: false, reason: "in-flight" };
  map.set(key, { f: 0, next: 0, stop: false, ...(st || {}), inflightAt: now });
  return { allowed: true };
}

// the tab that was told yes will not click after all (switched off, navigated away)
async function handleClaimRelease(msg) {
  const map = await getClaimBackoff();
  const st = map.get(String(msg.key || ""));
  if (!st) return;
  delete st.inflightAt;
  if (!st.f && !st.stop) map.delete(String(msg.key || ""));
}

// Verdict on a claim. Also keeps storage.local `claimHealth` for the popup:
// `streak` is the number of rejected claims in a row with no success in
// between (across rewards), `stopped` the rewards given up on this session.
// The lines logged here are the ones a bug report shows (content.js's own
// console lines never reach the report).
async function handleClaimResult(msg) {
  const map = await getClaimBackoff();
  const key = String(msg.key || "?");
  const now = Date.now();
  const { claimHealth } = await browser.storage.local.get("claimHealth");
  const h = claimHealth && typeof claimHealth === "object" ? claimHealth : {};
  const stopped = new Set(Array.isArray(h.stopped) ? h.stopped : []);
  let streak;
  if (msg.ok) {
    streak = 0;
    stopped.delete(key);
    map.delete(key);
    log(`claim went through: "${key}"`);
  } else {
    streak = (h.streak || 0) + 1;
    const next = claimBackoffAfterFailure(map.get(key), now); // no inflightAt: the round is over
    map.set(key, next);
    if (next.stop) {
      stopped.add(key);
      log(`claim rejected ${next.f} times in a row, likely integrity - not retrying "${key}" this session`);
    } else {
      log(`claim rejected, likely integrity - backing off ${Math.round((next.next - now) / 60_000)} min for "${key}" (failure ${next.f}/${CLAIM_MAX_FAILURES})`);
    }
  }
  saveClaimBackoff();
  await browser.storage.local.set({
    claimHealth: { streak, stopped: [...stopped], lastFailureAt: msg.ok ? (h.lastFailureAt || null) : now },
  });
}

let dropClaimedDebounce = null;
async function handleDropClaimed() {
  if (dropClaimedDebounce) return;
  dropClaimedDebounce = setTimeout(() => { dropClaimedDebounce = null; }, 60_000);

  const tabs = await browser.tabs.query({ url: "*://www.twitch.tv/drops/inventory*" });
  for (const tab of tabs) {
    if (!tab.active) browser.tabs.reload(tab.id);
  }
}

// ============================================================================
// open drop-campaign snapshot  (/drops/campaigns -> ViewerDropsDashboard GQL)
// ============================================================================
// Lets the watch list tell, per game, whether Twitch has an OPEN drop
// campaign for that game right now, and resolves the user's typed name to
// Twitch's own game.displayName/slug. /drops/campaigns is the only page that
// fires ViewerDropsDashboard (confirmed live 2026-09-01), and this file no
// longer opens it - the snapshot is only ever (re)written when the user has
// that page open themselves (inject.js's extractor -> handleGqlDropSignal
// below).

// set true only while annotateWatchListFromCampaigns() writes watchList back,
// so the storage.onChanged handler doesn't treat our own rewrite as a
// user edit and loop
let suppressWatchListReaction = false;

// One entry per real category slug, aggregating across a game's multiple
// campaigns (a game can list an ACTIVE and an EXPIRED campaign at once).
// `gameSlugMap` (id -> slug, learned from SideNav GQL) is preferred over
// toSlug(displayName) because ViewerDropsDashboard carries no slug and
// toSlug guesses wrong for renamed games (Rainbow Six Siege etc.).
function buildOpenCampaignsSnapshot(games, gameSlugMap = {}) {
  const bySlug = {};
  for (const g of games) {
    const slug = gameSlugMap[String(g.id)] || toSlug(g.name);
    if (!slug) continue;
    const cur = bySlug[slug] || {
      slug, gameId: String(g.id), displayName: g.name,
      active: false, endAt: null, accountConnected: false,
    };
    cur.active = cur.active || !!g.active;
    cur.accountConnected = cur.accountConnected || !!g.accountConnected;
    if (g.endAt != null) {
      if (g.active) {
        // latest end among the game's ACTIVE campaigns (last one to expire)
        cur.endAt = cur.endAt == null ? g.endAt : Math.max(cur.endAt, g.endAt);
      } else if (!cur.active && cur.endAt == null) {
        // no open campaign: keep the most recent end so the popup can still
        // say when the last one ended
        cur.endAt = g.endAt;
      }
    }
    bySlug[slug] = cur;
  }
  return bySlug;
}

// Re-resolves every watch-list entry against the current openCampaigns
// snapshot: binds it to Twitch's own displayName/slug/gameId when a matching
// OPEN campaign exists and records whether one is open (`campaign.open`).
// Only writes watchList back when a meaningful field changed. MUST NOT be
// called from inside a serialized() block - it runs its own, and then a
// serialized(autoWatchTick), so nesting would deadlock the task chain.
async function annotateWatchListFromCampaigns() {
  await serialized(async () => {
    const cfg = await browser.storage.local.get(["watchList", "openCampaigns"]);
    const list = cfg.watchList || [];
    const oc = cfg.openCampaigns;
    if (list.length === 0 || !oc || !oc.bySlug) return;

    const activeCampaigns = Object.values(oc.bySlug).filter((c) => c.active);
    let listChanged = false;

    const next = list.map((g) => {
      // pinned-channel entries have no typed game name to match against a
      // campaign display name (g.input is "@channelname") - their slug is
      // resolved dynamically from what the channel is actually playing (see
      // handleChannelPlayingGame), never from this snapshot
      if (g.pinnedChannel) return g;

      const match =
        matchOpenCampaign(g.input, activeCampaigns) ||
        (oc.bySlug[g.slug] && oc.bySlug[g.slug].active ? oc.bySlug[g.slug] : null);

      const slug = match ? match.slug : g.slug;
      const displayName = match ? match.displayName : (g.displayName || null);
      const gameId = match ? match.gameId : (g.gameId || null);
      const campaign = match
        ? { open: true, endAt: match.endAt ?? null, accountConnected: !!match.accountConnected, checkedAt: oc.fetchedAt }
        : { open: false, checkedAt: oc.fetchedAt };

      const prev = g.campaign || {};
      if (
        g.slug !== slug || g.displayName !== displayName || g.gameId !== gameId ||
        prev.open !== campaign.open || prev.endAt !== campaign.endAt ||
        prev.accountConnected !== campaign.accountConnected
      ) {
        listChanged = true;
      }
      return { ...g, slug, displayName, gameId, campaign };
    });

    if (listChanged) {
      suppressWatchListReaction = true;
      try {
        await browser.storage.local.set({ watchList: next });
      } finally {
        suppressWatchListReaction = false;
      }
    }
  });
  await serialized(autoWatchTick);
}

// ============================================================================
// auto-off - turn the master switch off once there's nothing left to watch
// (every tracked game fully claimed / expired / has no open campaign). Driven
// mainly by finishAllDone() the instant that happens; the AUTO_OFF_ALARM run
// is just a backstop in case that path was somehow missed.
// ============================================================================
async function checkAutoOff() {
  const cfg = await browser.storage.local.get(["enabled", "autoOffEnabled", "watchPhase", "enabledSince"]);
  if (!cfg.enabled || !cfg.autoOffEnabled) return;
  if (cfg.watchPhase !== "all-done") return;
  // grace window right after a manual re-enable so flipping the switch back
  // on (e.g. to add games / wait for new campaigns) isn't instantly undone
  if (cfg.enabledSince && Date.now() - cfg.enabledSince < 3 * 60 * 1000) return;
  log("auto-off: every tracked game is done -> turning the master switch off");
  await browser.storage.local.set({ enabled: false, completedAllAt: Date.now() });
}

// ============================================================================
// auto-watch orchestration - one tab per eligible game, up to tabQuota
// ============================================================================
function isGameDone(slug, campaignProgress, invalidSlugs) {
  if (invalidSlugs && (invalidSlugs[slug] || 0) > Date.now()) return true;
  const p = campaignProgress && campaignProgress[slug];
  if (!p) return false;
  return !!(p.allComplete || p.expired);
}

// True only when we have a reasonably fresh /drops/campaigns snapshot that
// positively shows NO open campaign for this game - never on missing or
// stale data (fail open), and never overriding a per-game campaign
// annotation that already says one is open.
function lacksOpenCampaign(game, openCampaigns) {
  // a pinned channel is trusted to be worth watching by virtue of being
  // pinned - never gated on the /drops/campaigns snapshot, which has no way
  // to know in advance what game an unresolved (or just-switched) pinned
  // channel is even playing
  if (game.pinnedChannel) return false;
  if (!openCampaigns || !openCampaigns.bySlug || !openCampaigns.fetchedAt) return false;
  // an empty snapshot is a failed/partial capture, not "Twitch has no
  // campaigns" - a real one always lists 100+ - so don't act on it
  if (Object.keys(openCampaigns.bySlug).length === 0) return false;
  if (Date.now() - openCampaigns.fetchedAt > OPEN_CAMPAIGNS_MAX_AGE_MS) return false;
  if (game.campaign && game.campaign.open) return false;
  const entry = openCampaigns.bySlug[game.slug];
  if (entry && entry.active) return false;
  return true;
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try { await browser.tabs.get(tabId); return true; } catch { return false; }
}

// closes (if open) and removes the tab tracked for one game - mutates the
// passed-in watchTabs object in place, caller is responsible for persisting it
async function closeWatchTab(watchTabs, slug) {
  const tabId = watchTabs[slug];
  if (tabId) {
    try { await browser.tabs.remove(tabId); } catch { /* already closed by the user */ }
  }
  delete watchTabs[slug];
}

// list-order (default): original priority order, with any game currently in
// its "nobody live" cooldown pushed to the back.
// expiry: soonest-expiring-first among games with a known expiry date;
// unknown-expiry games fall back to list order and sort after the known
// ones - never guessed. The expiry date is Twitch's own campaign endAt
// (from the open-campaigns snapshot, known for every game that has an open
// campaign) when available, otherwise the inventory card's parsed "End
// Date" as a fallback.
function orderByPriority(games, mode, campaignProgress, emptyUntil) {
  const now = Date.now();
  const tagged = games.map((g, i) => ({
    g, i, cooling: (emptyUntil[g.slug] || 0) > now,
  }));

  if (mode === "expiry") {
    const withExpiry = tagged.map((x) => {
      const p = campaignProgress[x.g.slug];
      const fromCampaign = x.g.campaign && typeof x.g.campaign.endAt === "number" ? x.g.campaign.endAt : null;
      const fromInventory = p && typeof p.expiresAt === "number" ? p.expiresAt : null;
      const expiresAt = fromCampaign != null ? fromCampaign : fromInventory;
      return { ...x, expiresAt };
    });
    const known = withExpiry.filter((x) => x.expiresAt != null && !x.cooling)
      .sort((a, b) => a.expiresAt - b.expiresAt);
    const unknown = withExpiry.filter((x) => x.expiresAt == null && !x.cooling)
      .sort((a, b) => a.i - b.i);
    const cooling = withExpiry.filter((x) => x.cooling).sort((a, b) => a.i - b.i);
    return [...known, ...unknown, ...cooling].map((x) => x.g);
  }

  const active = tagged.filter((x) => !x.cooling).sort((a, b) => a.i - b.i);
  const cooling = tagged.filter((x) => x.cooling).sort((a, b) => a.i - b.i);
  return [...active, ...cooling].map((x) => x.g);
}

async function teardownAllWatch(reason) {
  const cfg = await browser.storage.local.get(["watchTabs", "watchPhase"]);
  const watchTabs = cfg.watchTabs || {};
  for (const tabId of Object.values(watchTabs)) {
    try { await browser.tabs.remove(tabId); } catch { /* already closed */ }
  }
  if (cfg.watchPhase !== "idle") {
    await browser.storage.local.set({ watchTabs: {}, watchPhase: "idle", watchMeta: {}, dropSignals: {} });
  }
  log("auto-watch idle:", reason);
  await refreshBadge();
}

async function finishAllDone() {
  const cfg = await browser.storage.local.get(["watchPhase", "watchTabs"]);
  if (cfg.watchPhase === "all-done") return; // already handled
  const watchTabs = cfg.watchTabs || {};
  log("every tracked game is fully collected - closing all watch tabs");
  for (const tabId of Object.values(watchTabs)) {
    try { await browser.tabs.remove(tabId); } catch { /* already closed */ }
  }
  await browser.storage.local.set({ watchTabs: {}, watchPhase: "all-done", watchMeta: {}, dropSignals: {} });
  await refreshBadge();
  // if the user asked for it, switch the whole extension off now that every
  // tracked game is collected - nothing more for it to do until they change
  // the list (see checkAutoOff)
  await checkAutoOff();
}

// the core scheduler - not self-serializing, callers must go through
// serialized(autoWatchTick)
async function autoWatchTick() {
  const cfg = await browser.storage.local.get([
    "enabled", "autoWatchEnabled", "watchList", "invalidSlugs", "campaignProgress",
    "watchTabs", "tabQuota", "priorityMode", "emptyUntil", "watchMeta", "dropSignals",
    "gameWaitUntil", "openCampaigns",
  ]);
  if (!cfg.enabled || !cfg.autoWatchEnabled) return;

  const list = cfg.watchList || [];
  if (list.length === 0) {
    await teardownAllWatch("no games in list");
    return;
  }

  await sweepStaleWatchLeftovers();
  await sweepStalePinnedHeartbeats();

  const invalidSlugs = cfg.invalidSlugs || [];
  const campaignProgress = cfg.campaignProgress || {};
  const emptyUntil = cfg.emptyUntil || {};
  const gameWaitUntil = cfg.gameWaitUntil || {};
  const quota = Math.max(1, cfg.tabQuota || DEFAULT_TAB_QUOTA);
  const priorityMode = cfg.priorityMode === "expiry" ? "expiry" : "list-order";
  let watchTabs = { ...(cfg.watchTabs || {}) };
  let watchMeta = { ...(cfg.watchMeta || {}) };
  let dropSignals = { ...(cfg.dropSignals || {}) };

  const now = Date.now();
  const eligible = list.filter((g) =>
    !isGameDone(g.slug, campaignProgress, invalidSlugs) &&
    !((gameWaitUntil[g.slug] || 0) > now) &&
    !lacksOpenCampaign(g, cfg.openCampaigns)
  );

  if (eligible.length === 0) {
    // nothing to watch right now - but this can be purely "every game is
    // waiting on a start date / has no open campaign yet", which is not the
    // same as "all done". Only call it done when at least one game is
    // genuinely finished/expired and none are merely waiting.
    const anyWaiting = list.some((g) =>
      (gameWaitUntil[g.slug] || 0) > now || lacksOpenCampaign(g, cfg.openCampaigns)
    );
    if (anyWaiting) {
      await teardownAllWatch("all games waiting on a start date / open campaign");
    } else {
      await finishAllDone();
    }
    return;
  }

  // drop tabs for games that are no longer eligible (done, invalid, or
  // removed from the list) - every other game's tab is untouched
  const eligibleSlugs = new Set(eligible.map((g) => g.slug));
  for (const slug of Object.keys(watchTabs)) {
    if (!eligibleSlugs.has(slug)) {
      await closeWatchTab(watchTabs, slug);
      delete watchMeta[slug];
      delete dropSignals[slug];
    }
  }

  // drop bookkeeping for tabs the user closed manually
  for (const slug of Object.keys(watchTabs)) {
    if (!(await tabExists(watchTabs[slug]))) delete watchTabs[slug];
  }

  // fill remaining quota with the next-priority eligible games not already watched
  const ordered = orderByPriority(eligible, priorityMode, campaignProgress, emptyUntil);
  let openCount = Object.keys(watchTabs).length;
  for (const game of ordered) {
    if (openCount >= quota) break;
    if (watchTabs[game.slug]) continue; // already has a tab

    const { id: watchWindowId } = await getOrCreateWatchWindow();
    const url = game.pinnedChannel ? channelUrl(game.channel) : directoryUrl(game.slug);
    const tab = await browser.tabs.create({ url, active: false, pinned: true, ...(watchWindowId ? { windowId: watchWindowId } : {}) });
    await browser.tabs.update(tab.id, { active: false, muted: true });
    watchTabs[game.slug] = tab.id;
    openCount++;
    log("opened watch tab for", game.slug, `tab=${tab.id}`, `(${openCount}/${quota})`);

    if (game.pinnedChannel) {
      // the destination channel is already known (no directory pick to wait
      // on) - go straight to tracking it, same shape handleDirectoryPicked
      // uses for a freshly-picked channel
      watchMeta[game.slug] = { channel: game.channel, tabId: tab.id, watchStartedAt: Date.now() };
      // fire-and-forget - never block opening the tab on this (see
      // flashTabToStartPlayback's top comment for why a fresh tab needs it)
      (async () => {
        const { id: wwId } = await getOrCreateWatchWindow();
        if (wwId == null) return;
        try {
          const liveTab = await browser.tabs.get(tab.id);
          if (liveTab.windowId === wwId) await flashTabToStartPlayback(tab.id);
        } catch {
          // tab already gone
        }
      })();
    }
  }

  await browser.storage.local.set({ watchTabs, watchPhase: "watching", watchMeta, dropSignals });
  await refreshBadge();
}

async function handleDirectoryInvalid(slug, actualPathname, actualHref) {
  return serialized(async () => {
    const cfg = await browser.storage.local.get(["invalidSlugs", "watchTabs"]);
    // invalidSlugs is slug -> retry-after timestamp (was a permanent array
    // until INVALID_SLUG_RETRY_MS was added - see its comment); tolerate
    // old array-shaped data left over from before that change by just
    // ignoring it rather than crashing on it.
    const prevInvalidSlugs = cfg.invalidSlugs;
    const invalidSlugs = { ...(prevInvalidSlugs && !Array.isArray(prevInvalidSlugs) ? prevInvalidSlugs : {}) };
    invalidSlugs[slug] = Date.now() + INVALID_SLUG_RETRY_MS;
    const watchTabs = { ...(cfg.watchTabs || {}) };
    await closeWatchTab(watchTabs, slug);
    await browser.storage.local.set({ invalidSlugs, watchTabs });
    log(
      "slug looks invalid (directory redirected away), retrying automatically in",
      Math.round(INVALID_SLUG_RETRY_MS / 60000), "min:", slug,
      "- landed on", actualPathname || "(unknown)", actualHref ? `(${actualHref})` : ""
    );
    await autoWatchTick();
  });
}

async function handleDirectoryEmpty(slug) {
  return serialized(async () => {
    const cfg = await browser.storage.local.get(["watchTabs", "emptyUntil"]);
    const watchTabs = { ...(cfg.watchTabs || {}) };
    await closeWatchTab(watchTabs, slug);
    const emptyUntil = { ...(cfg.emptyUntil || {}) };
    emptyUntil[slug] = Date.now() + EMPTY_COOLDOWN_MS;
    await browser.storage.local.set({ watchTabs, emptyUntil });
    log("no live channels for", slug, "- freed its slot for", Math.round(EMPTY_COOLDOWN_MS / 60000), "min");
    await autoWatchTick();
  });
}

// ============================================================================
// slug resolution via Twitch search  (permanent fix for "wrong guessed slug")
// ============================================================================
// content.js's directory-page check found a slug that renders a blank
// unknown-category page (no redirect, no <h1>/title - see
// looksLikeUnknownCategory). Rather than just parking it, look up the real
// directory slug from Twitch's own search results: content.js scrapes the
// `a[data-a-target="search-result-category"]` link (a stable selector, and
// its href carries the canonical slug even when the game's display name no
// longer matches it) on the /search page and posts `searchCategoryResult`.
// On success the watch-list slug is corrected in place and cached in
// `gameSlugMap` so it's a one-time cost per game; on failure it falls back
// to the normal invalid-slug retry cooldown.

// normalizeGameName(term) -> resolve(slug) for an in-flight search lookup
const pendingSlugResolves = new Map();

function handleSearchCategoryResult(msg) {
  if (!msg || !msg.term || !msg.slug) return;
  const resolver = pendingSlugResolves.get(normalizeGameName(msg.term));
  if (resolver) resolver(msg.slug);
}

async function handleDirectoryUnknownCategory(msg) {
  const badSlug = msg.slug;
  if (!badSlug) return;

  // park the dud slug briefly so autoWatchTick doesn't reopen its tab while
  // the search runs (extended to the full retry window, or cleared, below)
  await serialized(async () => {
    const cfg = await browser.storage.local.get(["invalidSlugs", "watchTabs"]);
    const invalidSlugs = { ...(cfg.invalidSlugs && !Array.isArray(cfg.invalidSlugs) ? cfg.invalidSlugs : {}) };
    invalidSlugs[badSlug] = Date.now() + 3 * 60 * 1000;
    const watchTabs = { ...(cfg.watchTabs || {}) };
    await closeWatchTab(watchTabs, badSlug);
    await browser.storage.local.set({ invalidSlugs, watchTabs });
  });
  await serialized(autoWatchTick);

  let gameName = msg.gameName;
  if (!gameName) {
    const { watchList } = await browser.storage.local.get("watchList");
    const g = (watchList || []).find((x) => x.slug === badSlug);
    gameName = g && (g.displayName || g.input);
  }
  if (!gameName) {
    log("unknown category for", badSlug, "- no game name to search with, leaving it parked");
    return;
  }

  const key = normalizeGameName(gameName);
  let searchTab = null;
  const found = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 25_000);
    pendingSlugResolves.set(key, (slug) => { clearTimeout(timer); resolve(slug); });
    getOrCreateWatchWindow()
      .then(({ id: watchWindowId }) => browser.tabs.create({ url: searchUrl(gameName), active: false, pinned: true, ...(watchWindowId ? { windowId: watchWindowId } : {}) }))
      .then((t) => { searchTab = t; })
      .catch((e) => { clearTimeout(timer); log("slug-resolve: could not open search tab:", e); resolve(null); });
  });
  pendingSlugResolves.delete(key);
  if (searchTab) { try { await browser.tabs.remove(searchTab.id); } catch { /* gone */ } }

  if (found && found !== badSlug) {
    log("resolved real category slug for", JSON.stringify(gameName), ":", badSlug, "->", found);
    await applyResolvedSlug(badSlug, found);
  } else {
    log("search could not resolve a real slug for", JSON.stringify(gameName), "- keeping", badSlug, "parked for the normal retry window");
    await handleDirectoryInvalid(badSlug, "(unknown category; search resolution failed)", null);
  }
}

// swap a wrong slug for the resolved one everywhere it's keyed, cache it in
// gameSlugMap so future openCampaigns snapshots get it right first time, and
// re-run the scheduler so the directory tab reopens with the correct slug.
async function applyResolvedSlug(badSlug, goodSlug) {
  await serialized(async () => {
    const cfg = await browser.storage.local.get([
      "watchList", "invalidSlugs", "emptyUntil", "gameWaitUntil",
      "campaignProgress", "gameSlugMap", "watchTabs", "openCampaigns",
    ]);
    const watchList = (cfg.watchList || []).map(
      (g) => (g.slug === badSlug ? { ...g, slug: goodSlug } : g)
    );

    const rekey = (obj) => {
      if (!obj || typeof obj !== "object" || Array.isArray(obj) || !(badSlug in obj)) return obj || {};
      const next = { ...obj, [goodSlug]: obj[badSlug] };
      delete next[badSlug];
      return next;
    };
    const invalidSlugs = rekey(cfg.invalidSlugs && !Array.isArray(cfg.invalidSlugs) ? cfg.invalidSlugs : {});
    delete invalidSlugs[goodSlug]; // resolved - retry now, don't sit in cooldown
    const emptyUntil = rekey(cfg.emptyUntil || {});
    delete emptyUntil[goodSlug];
    const gameWaitUntil = rekey(cfg.gameWaitUntil || {});
    const campaignProgress = rekey(cfg.campaignProgress || {});

    const gameSlugMap = { ...(cfg.gameSlugMap || {}) };
    const ocEntry = cfg.openCampaigns && cfg.openCampaigns.bySlug &&
      (cfg.openCampaigns.bySlug[badSlug] || cfg.openCampaigns.bySlug[goodSlug]);
    const gid = (ocEntry && ocEntry.gameId) ||
      ((cfg.watchList || []).find((g) => g.slug === badSlug || g.slug === goodSlug) || {}).gameId;
    if (gid) gameSlugMap[gid] = goodSlug;

    const watchTabs = { ...(cfg.watchTabs || {}) };
    await closeWatchTab(watchTabs, badSlug);

    suppressWatchListReaction = true;
    try {
      await browser.storage.local.set({
        watchList, invalidSlugs, emptyUntil, gameWaitUntil, campaignProgress, gameSlugMap, watchTabs,
      });
    } finally {
      suppressWatchListReaction = false;
    }
  });
  await serialized(autoWatchTick);
}

// ============================================================================
// pinned-channel resolution - a watch-list entry typed as "@channel" starts
// with a synthetic "channel:<name>" slug (see parseWatchList). Once
// content.js's channel-page monitor sees that channel live and reports what
// game it's playing (msg.slug, already run through toSlug()+ALIASES the same
// way parseInventoryCampaigns derives its own card slug - see
// currentStreamGame() in content.js), rewrite the entry's slug to that real
// category slug so every existing per-slug system (inventory-progress
// matching, badges, isGameDone, verifyDropStatus) treats it exactly like an
// ordinary typed-game entry from here on. Also fires again if a pinned
// channel later switches to a genuinely different game - campaign progress
// belongs to a specific game and is never carried across that switch, but
// the tab itself is untouched (it's already sitting on the right channel).
// ============================================================================
async function handleChannelPlayingGame(msg, tab) {
  const { channel, slug, gameName } = msg;
  if (!tab || !channel || !slug) return;

  const changed = await serialized(async () => {
    const cfg = await browser.storage.local.get([
      "watchList", "watchTabs", "watchMeta", "dropSignals", "campaignProgress",
      "invalidSlugs", "emptyUntil", "gameWaitUntil", "blockedChannels",
    ]);
    const watchTabs = cfg.watchTabs || {};
    const fromSlug = Object.keys(watchTabs).find((s) => watchTabs[s] === tab.id);
    if (!fromSlug || fromSlug === slug) return false;

    const watchList = cfg.watchList || [];
    const game = watchList.find((g) => g.slug === fromSlug);
    if (!game || !game.pinnedChannel) return false; // not a pinned-channel watch tab

    if (watchList.some((g) => g.slug === slug)) {
      log("pinned channel", channel, "- won't bind to", slug, "- already tracked by another watch-list entry");
      return false;
    }

    const nextWatchList = watchList.map((g) =>
      g.slug === fromSlug ? { ...g, slug, pinnedGameName: gameName || null } : g
    );

    const rekey = (obj) => {
      if (!obj || typeof obj !== "object" || Array.isArray(obj) || !(fromSlug in obj)) return obj || {};
      const next = { ...obj, [slug]: obj[fromSlug] };
      delete next[fromSlug];
      return next;
    };
    const nextWatchTabs = rekey(watchTabs);
    const nextInvalidSlugs = rekey(cfg.invalidSlugs && !Array.isArray(cfg.invalidSlugs) ? cfg.invalidSlugs : {});
    const nextEmptyUntil = rekey(cfg.emptyUntil || {});
    const nextGameWaitUntil = rekey(cfg.gameWaitUntil || {});
    const nextBlockedChannels = rekey(cfg.blockedChannels || {});

    // campaign progress is game-specific - never carried across a pinned
    // channel binding to a game for the first time (nothing to carry) or
    // switching to a different one (would misattribute the old game's numbers)
    const nextCampaignProgress = { ...(cfg.campaignProgress || {}) };
    delete nextCampaignProgress[fromSlug];

    // fresh verify clock - can't judge progress against a baseline from
    // before this game was even known
    const nextWatchMeta = { ...(cfg.watchMeta || {}) };
    delete nextWatchMeta[fromSlug];
    nextWatchMeta[slug] = { channel, tabId: tab.id, watchStartedAt: Date.now() };
    const nextDropSignals = { ...(cfg.dropSignals || {}) };
    delete nextDropSignals[fromSlug];

    suppressWatchListReaction = true;
    try {
      await browser.storage.local.set({
        watchList: nextWatchList,
        watchTabs: nextWatchTabs,
        watchMeta: nextWatchMeta,
        dropSignals: nextDropSignals,
        campaignProgress: nextCampaignProgress,
        invalidSlugs: nextInvalidSlugs,
        emptyUntil: nextEmptyUntil,
        gameWaitUntil: nextGameWaitUntil,
        blockedChannels: nextBlockedChannels,
      });
    } finally {
      suppressWatchListReaction = false;
    }
    log(
      "pinned channel", channel, fromSlug.startsWith("channel:") ? "resolved to game" : "switched game to",
      slug, gameName ? `(${gameName})` : ""
    );
    return true;
  });

  if (changed) await serialized(autoWatchTick);
}

async function mergeInventoryProgress(campaigns) {
  // campaigns may legitimately be [] (every watched game's card is gone from
  // "In Progress") - still need to run so the missing-card reconciliation
  // below gets a chance to fire. Only a genuinely missing/malformed message
  // short-circuits.
  if (!campaigns) return;

  return serialized(async () => {
    const cfg = await browser.storage.local.get([
      "campaignProgress", "watchTabs", "watchMeta", "dropSignals", "gameIdMap", "gameActiveIds", "watchList",
    ]);
    const progress = cfg.campaignProgress || {};
    const watchTabs = { ...(cfg.watchTabs || {}) };
    const watchMeta = { ...(cfg.watchMeta || {}) };
    const dropSignals = { ...(cfg.dropSignals || {}) };
    const watchList = cfg.watchList || [];
    let anyJustFinished = false;

    // GQL's own campaign.status ("ACTIVE"/"EXPIRED", learned alongside
    // gameIdMap - see inject.js's Inventory extractor) is a more reliable
    // "is there still a live campaign for this game" check than content.js's
    // DOM text scrape, which has no way to disambiguate when a game shows
    // more than one campaign card at once (an old, past-end-date one
    // alongside a current one) - real capture caught exactly that for
    // marvel-rivals. Build slug -> confirmed-still-active once per merge.
    const gameIdMap = cfg.gameIdMap || {};
    const gameActiveIds = cfg.gameActiveIds || {};
    const activeSlugs = new Set();
    for (const [id, name] of Object.entries(gameIdMap)) {
      if (gameActiveIds[id]) activeSlugs.add(toSlug(name));
    }

    for (const c of campaigns) {
      const allComplete = c.total > 0 && c.claimed >= c.total && !c.accountNotConnected;
      const expired = !!c.expired && !activeSlugs.has(c.slug);
      progress[c.slug] = {
        label: c.label,
        claimed: c.claimed,
        total: c.total,
        accountNotConnected: !!c.accountNotConnected,
        expired,
        allComplete,
        expiresAt: typeof c.expiresAt === "number" ? c.expiresAt : null,
        timeRemainingMin: c.timeRemainingMin ?? null,
        updatedAt: Date.now(),
        missingScans: 0,
      };
      if ((allComplete || expired) && watchTabs[c.slug]) {
        await closeWatchTab(watchTabs, c.slug);
        delete watchMeta[c.slug];
        delete dropSignals[c.slug];
        anyJustFinished = true;
        log(c.slug, allComplete ? "fully claimed" : "expired", "- closed its tab");
      }
    }

    // Reconcile watched games whose card wasn't in this scan at all. Only
    // acts on a slug that: is still on the watch list, has a prior reading
    // with real progress (total > 0 - never invent completion for a game we
    // never actually saw a card for), and isn't already resolved. See
    // REQUIRED_MISSING_SCANS above for why this waits for corroboration
    // instead of acting on the first miss.
    const seenSlugs = new Set(campaigns.map((c) => c.slug));
    for (const game of watchList) {
      const slug = game.slug;
      if (seenSlugs.has(slug)) continue;
      const p = progress[slug];
      if (!p || p.allComplete || p.expired || !(p.total > 0)) continue;

      const missingScans = (p.missingScans || 0) + 1;
      if (missingScans >= REQUIRED_MISSING_SCANS) {
        progress[slug] = { ...p, allComplete: true, missingScans: 0, updatedAt: Date.now() };
        if (watchTabs[slug]) {
          await closeWatchTab(watchTabs, slug);
          delete watchMeta[slug];
          delete dropSignals[slug];
          anyJustFinished = true;
        }
        log(slug, "card vanished from In Progress across", missingScans, "scans - treating as fully claimed");
      } else {
        progress[slug] = { ...p, missingScans };
      }
    }

    await browser.storage.local.set({ campaignProgress: progress, watchTabs, watchMeta, dropSignals });
    if (anyJustFinished) await autoWatchTick();
  });
}

// ============================================================================
// drop-status verification - catches "fake category" streams: a channel
// listed under a game's drops-filtered directory that isn't actually
// broadcasting with that game's drop campaign attached, so watching it
// never accrues progress.
//
// Signal source: campaignProgress[slug], the same data content.js already
// scrapes from the /drops/inventory page's DOM for the auto-skip logic
// (mergeInventoryProgress() above) - specifically .claimed (reward tiers
// fully claimed) and .timeRemainingMin (best-effort parse of Twitch's own
// "N min left" text, see extractRemainingMinutes() in content.js). A
// baseline of both is captured the first time a fresh-enough reading is
// seen after switching to a channel; on a later sweep, once VERIFY_DELAY_MS
// has passed AND a newer reading than the baseline has come in, neither
// number having moved is treated as "not crediting us" and the channel gets
// rotated. If neither number is usable at all (timeRemainingMin never
// parsed and claimed never moved) that's "can't tell", not "it's stuck" -
// fails closed to keep watching rather than risk rejecting a channel that's
// actually fine.
//
// This intentionally does NOT use gql-bridge.js/inject.js's channel-tab GQL
// sniffing (dropSignals) - see the top-of-file comment for why that data
// source turned out to be a dead end for a background/pinned watch tab.
//
// Already-claimed campaigns are NOT this function's job: mergeInventoryProgress
// / isGameDone already close a game's tab the moment its campaign is fully
// claimed or expired. verifyDropStatus only runs for games still eligible
// and currently on a channel, and only ever *rotates* the channel - it never
// removes a game from the watch list.
//
// rejectChannel() is deliberately the ONLY place that blocklists a channel -
// see the top-of-file comment on why content.js's DOM offline/raid check
// (handleChannelLeft below) must not do this on its own.
// ============================================================================
async function rejectChannel(slug, channelName, tabId) {
  const cfg = await browser.storage.local.get(["blockedChannels", "watchMeta", "dropSignals"]);
  const blockedChannels = { ...(cfg.blockedChannels || {}) };
  const forSlug = { ...(blockedChannels[slug] || {}) };
  forSlug[(channelName || "").toLowerCase()] = Date.now() + CHANNEL_BLOCK_COOLDOWN_MS;
  blockedChannels[slug] = forSlug;

  const watchMeta = { ...(cfg.watchMeta || {}) };
  delete watchMeta[slug];
  const dropSignals = { ...(cfg.dropSignals || {}) };
  delete dropSignals[slug];

  await browser.storage.local.set({ blockedChannels, watchMeta, dropSignals });
  maybeAutoExportDebugLog();

  try {
    // same tab, bounced back to the directory - cheaper than closing and
    // reopening, and content.js's existing directory-page picker takes it
    // from here (it will read blockedChannels back via isWatchTab and skip
    // this channel on the re-pick).
    await browser.tabs.update(tabId, { url: directoryUrl(slug), active: false });
  } catch (e) {
    log("rejectChannel: tab already gone for", slug, e);
  }
}

async function verifyDropStatus(slug) {
  const cfg = await browser.storage.local.get(["watchTabs", "watchMeta", "campaignProgress"]);
  const tabId = (cfg.watchTabs || {})[slug];
  const meta = (cfg.watchMeta || {})[slug];
  if (!tabId || !meta) return; // no tab, or no channel picked yet for it

  const progress = (cfg.campaignProgress || {})[slug];
  if (progress && (progress.allComplete || progress.expired)) return; // autoWatchTick handles closing this tab

  // No inventory reading at all yet since this channel started - fail
  // closed (can't judge on nothing), whether that's because the inventory
  // tab hasn't scanned yet or this game isn't showing on that page at all.
  if (!progress || !progress.updatedAt || progress.updatedAt < meta.watchStartedAt) {
    log("[verify]", slug, "channel", meta.channel, "- no fresh inventory reading yet since this channel started, waiting");
    return;
  }

  // First fresh-enough reading since this channel started: record it as the
  // baseline and judge on a later sweep, rather than comparing against a
  // stale number left over from a previous channel.
  if (meta.baselineCapturedAt == null) {
    const watchMeta = { ...(cfg.watchMeta || {}) };
    watchMeta[slug] = {
      ...meta,
      baselineCapturedAt: Date.now(),
      baselineClaimed: progress.claimed,
      baselineTimeRemainingMin: progress.timeRemainingMin,
    };
    await browser.storage.local.set({ watchMeta });
    log(
      "[verify]", slug, "channel", meta.channel, "- baseline captured:",
      `claimed=${progress.claimed}`, `timeRemainingMin=${progress.timeRemainingMin}`
    );
    return;
  }

  // Gated on time-since-*this*-baseline, not time-since-watchStartedAt -
  // this is what makes verification a repeating rolling check instead of a
  // one-shot: once a window's judgment re-baselines below (the "progressing"
  // branch), the very next window starts counting from that fresh point,
  // so a channel doesn't become permanently exempt from ever being
  // re-checked again just because it passed once.
  const elapsedSinceBaseline = Date.now() - meta.baselineCapturedAt;
  if (elapsedSinceBaseline < VERIFY_DELAY_MS) {
    log(
      "[verify]", slug, "channel", meta.channel, "- waiting,",
      Math.round(elapsedSinceBaseline / 1000), "/", Math.round(VERIFY_DELAY_MS / 1000), "s since baseline"
    );
    return;
  }
  if (progress.updatedAt <= meta.baselineCapturedAt) {
    log("[verify]", slug, "channel", meta.channel, "- verify window elapsed but no reading newer than the baseline yet, waiting");
    return;
  }

  const claimedMoved = progress.claimed > meta.baselineClaimed;
  const timeMoved =
    meta.baselineTimeRemainingMin != null &&
    progress.timeRemainingMin != null &&
    progress.timeRemainingMin < meta.baselineTimeRemainingMin;

  if (claimedMoved || timeMoved) {
    // Progressing - re-baseline against *this* reading instead of just
    // returning and leaving the old baseline in place. Comparing every
    // future window against a stale, ever-further-in-the-past baseline
    // would mean "moved at all since the very first reading" stays true
    // forever even after the channel stops crediting entirely (e.g. goes
    // offline) - this bug is exactly why a real offline channel sat
    // un-rotated for an entire overnight run instead of being caught
    // within one VERIFY_DELAY_MS window. See HISTORY.md.
    log(
      "[verify]", slug, "channel", meta.channel, "- progressing, re-baselining:",
      `claimed ${meta.baselineClaimed} -> ${progress.claimed},`,
      `timeRemainingMin ${meta.baselineTimeRemainingMin} -> ${progress.timeRemainingMin}`
    );
    const watchMeta = { ...(cfg.watchMeta || {}) };
    watchMeta[slug] = {
      ...meta,
      baselineCapturedAt: Date.now(),
      baselineClaimed: progress.claimed,
      baselineTimeRemainingMin: progress.timeRemainingMin,
    };
    await browser.storage.local.set({ watchMeta });
    return;
  }

  if (meta.baselineTimeRemainingMin == null && progress.timeRemainingMin == null) {
    // never got a usable timeRemainingMin reading at all for this campaign
    // (DOM parsing probably isn't matching this card's text - best-effort,
    // see extractRemainingMinutes in content.js) and reward-tier completion
    // is too coarse a signal to trust alone this early - can't tell, so
    // fail closed rather than risk rejecting a channel that's actually fine
    log("[verify]", slug, "channel", meta.channel, "- no usable timeRemainingMin signal at all, can't tell, keeping watching (fail closed)");
    return;
  }

  log(
    "[verify]", slug, "channel", meta.channel, "- no progress for a full verify window",
    `(claimed ${meta.baselineClaimed} -> ${progress.claimed},`,
    `timeRemainingMin ${meta.baselineTimeRemainingMin} -> ${progress.timeRemainingMin})`,
    "- flagged stalled"
  );
  return { stalled: true, channelName: meta.channel, tabId };
}

// Every slug reaching a stalled verdict in the SAME sweep - with 2+ slugs
// actually judged - points at a system-wide cause (network/GPU/OS hiccup,
// e.g. the display-power-off/window-occlusion interaction reported
// 2026-09-04: Windows turning the monitor off is not sleep, but Firefox's
// window-occlusion tracking can still treat every window as invisible and
// suspend background video, which would stall every watched channel at
// once) rather than any one channel actually going bad. rejectChannel()
// blocklists by channel NAME, so blindly rejecting every slug in that
// situation would fill blockedChannels with channels that were fine,
// working through them one sweep at a time until nothing usable is left.
// Only reject when it's not unanimous - a single stalled slug alongside
// others still progressing normally is real evidence against that one
// channel specifically.
async function verifySweep() {
  const cfg = await browser.storage.local.get(["watchMeta", "watchList"]);
  const slugs = Object.keys(cfg.watchMeta || {});
  const pinnedSlugs = new Set(
    (cfg.watchList || []).filter((g) => g.pinnedChannel).map((g) => g.slug)
  );
  const verdicts = [];
  for (const slug of slugs) {
    const verdict = await verifyDropStatus(slug);
    if (verdict) verdicts.push({ slug, ...verdict });
  }

  // a user-pinned channel is never rotated away for stalling - they chose it
  // deliberately, so just note it and leave it watching. Excluded from both
  // the rotation below AND the "stalled together" system-wide heuristic,
  // which is about deciding whether to rotate at all.
  for (const v of verdicts) {
    if (v.stalled && pinnedSlugs.has(v.slug)) {
      log("[verify]", v.slug, "channel", v.channelName, "- stalled, but it's a pinned channel, not rotating away");
    }
  }
  const rotatable = verdicts.filter((v) => !pinnedSlugs.has(v.slug));

  const allStalledTogether = rotatable.length >= 2 && rotatable.every((v) => v.stalled);
  if (allStalledTogether) {
    log(
      "[verify] all", rotatable.length, "watched channels stalled in the same sweep",
      `(${rotatable.map((v) => v.slug).join(", ")})`,
      "- treating as a system-wide cause, not rotating any of them this sweep"
    );
    return;
  }

  for (const v of rotatable) {
    if (v.stalled) await rejectChannel(v.slug, v.channelName, v.tabId);
  }
}

// How long a freshly-picked watch tab is briefly brought to the foreground
// of the dedicated watch window (getOrCreateWatchWindow above) so Twitch's
// own player actually starts. Live RDP capture (2026-09-04) found
// video.readyState/currentTime stuck at 0 indefinitely without this on some
// channels - Twitch's player never issues the PlaybackAccessToken/usher
// fetch for a tab that has never been the active tab of its window. Only
// ever called after confirming (via tab.windowId, in the caller) the tab is
// actually inside the isolated watch window - never anywhere the user could
// be looking. holdMs is a parameter (not just the constant) purely so tests
// can exercise the revert without a real 8s wait.
const PLAYBACK_FLASH_HOLD_MS = 8_000;
// tabId -> when it was last flashed, so a pinned channel's "it's live now"
// report right after the creation-time flash doesn't flash the tab twice
const lastPlaybackFlashAt = new Map();
const PINNED_LIVE_FLASH_MIN_GAP_MS = 2 * 60 * 1000;
async function flashTabToStartPlayback(tabId, holdMs = PLAYBACK_FLASH_HOLD_MS) {
  lastPlaybackFlashAt.set(tabId, Date.now());
  try {
    await browser.tabs.update(tabId, { active: true });
  } catch (e) {
    log("flashTabToStartPlayback: could not activate tab", tabId, e);
    return;
  }
  setTimeout(async () => {
    try {
      await browser.tabs.update(tabId, { active: false });
    } catch {
      // tab already gone/rotated away - nothing to revert
    }
  }, holdMs);
}

// A pinned "@channel" tab is created straight on the channel page, so the
// creation-time flash (see autoWatchTick) is wasted if the channel was
// offline then - Twitch's player never starts in a tab that was never
// active while the stream was live. content.js reports the moment it sees
// the channel live (first sighting after a page load / after being offline);
// flash the tab then, exactly as for a freshly-picked channel. Only for a
// tab this file tracks as a pinned entry, only inside the dedicated watch
// window, and not twice within PINNED_LIVE_FLASH_MIN_GAP_MS.
async function flashPinnedTabOnceLive(tabId, channel) {
  if (Date.now() - (lastPlaybackFlashAt.get(tabId) || 0) < PINNED_LIVE_FLASH_MIN_GAP_MS) {
    log("pinned channel", channel, "is live - tab was flashed moments ago, not again");
    return;
  }
  const { id: watchWindowId } = await getOrCreateWatchWindow();
  if (watchWindowId == null) return; // no isolated window - never flash in the user's own
  try {
    const liveTab = await browser.tabs.get(tabId);
    if (liveTab.windowId !== watchWindowId) return;
  } catch {
    return; // tab already gone
  }
  log("pinned channel", channel, "went live - flashing its tab to start playback");
  await flashTabToStartPlayback(tabId);
}

// ============================================================================
// pinned-channel offline recovery
// ============================================================================
// content.js's pinned branch ONLY reports what the DOM currently shows
// (msg.live: true/false/null) every 60s tick - it never reloads its own page
// any more. Deliberately: a tab Firefox has discarded to free memory has no
// content script left running at all, so reload logic living there could
// silently stop firing forever - exactly the failure mode this replaces. Both
// the decision and the actual browser.tabs.reload() live here instead, in the
// persistent background page, which is unaffected by any one tab's content
// script dying - and a reload works even on an already-discarded tab (it
// fully reconstructs it, not a no-op against dead content).
//
// pinnedTabState: tabId -> { offlineTicks, lastHeartbeatAt }. In-memory only
// (like lastPlaybackFlashAt above) - lost on an extension reload/restart,
// which is fine: the next status report (or the safety-net sweep once one
// arrives) rebuilds it, and one spurious extra reload right after a restart
// is harmless.
const pinnedTabState = new Map();
// routine reload cadence while a pinned channel's page keeps showing offline
const PINNED_OFFLINE_RELOAD_TICKS = 3;
// a status report (including "still loading/gated", live===null) counts as
// proof of life; this is the safety net for when NO report arrives at all -
// generously longer than PINNED_OFFLINE_RELOAD_TICKS*60s so it only fires for
// a genuinely stuck/discarded tab, not a slow-but-alive one
const PINNED_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
const PINNED_RELOAD_MIN_GAP_MS = 2 * 60 * 1000;
const lastPinnedReloadAt = new Map();

async function getPinnedGameForTab(tabId) {
  const cfg = await browser.storage.local.get(["watchTabs", "watchList", "enabled"]);
  if (!cfg.enabled) return null; // disabling clears watchTabs anyway - this is belt-and-braces
  const watchTabs = cfg.watchTabs || {};
  const slug = Object.keys(watchTabs).find((s) => watchTabs[s] === tabId);
  const game = slug && (cfg.watchList || []).find((g) => g.slug === slug);
  return game && game.pinnedChannel ? game : null;
}

async function reloadPinnedTab(tabId, channel, reason) {
  if (Date.now() - (lastPinnedReloadAt.get(tabId) || 0) < PINNED_RELOAD_MIN_GAP_MS) return;
  lastPinnedReloadAt.set(tabId, Date.now());
  pinnedTabState.set(tabId, { offlineTicks: 0, lastHeartbeatAt: Date.now() });
  log("pinned channel", channel, "-", reason, "- reloading its tab");
  try { await browser.tabs.reload(tabId); } catch (e) { log("reloadPinnedTab: tab already gone", tabId, e); }
}

async function handlePinnedChannelStatus(msg, tab) {
  if (!tab) return;
  const game = await getPinnedGameForTab(tab.id);
  if (!game) return; // not (or no longer) a tracked pinned-channel tab

  const state = pinnedTabState.get(tab.id) || { offlineTicks: 0, lastHeartbeatAt: 0 };
  state.lastHeartbeatAt = Date.now();

  if (msg.live === true) {
    state.offlineTicks = 0;
    pinnedTabState.set(tab.id, state);
    await flashPinnedTabOnceLive(tab.id, msg.channel);
    return;
  }
  if (msg.live === false) {
    state.offlineTicks++;
    pinnedTabState.set(tab.id, state);
    if (msg.sidebarLive) {
      await reloadPinnedTab(tab.id, msg.channel, "is live in the sidebar but this page still shows offline");
    } else if (state.offlineTicks >= PINNED_OFFLINE_RELOAD_TICKS) {
      await reloadPinnedTab(tab.id, msg.channel, "still offline - reloading to catch it going live");
    }
    return;
  }
  // live === null (loading / content-gated): heartbeat only, no action
  pinnedTabState.set(tab.id, state);
}

// Safety net for a pinned tab that stops reporting ENTIRELY (Firefox
// discarded it for memory, or its content script otherwise died) - no
// message from it can ever arrive, so this has to be driven independently, on
// the existing per-minute AUTO_WATCH_ALARM cadence rather than waiting on a
// report that will never come. tabs.reload() also works on an already-
// discarded tab (fully reconstructs it), which is the actual point.
async function sweepStalePinnedHeartbeats() {
  const cfg = await browser.storage.local.get(["watchTabs", "watchList"]);
  const watchTabs = cfg.watchTabs || {};
  const now = Date.now();
  for (const game of cfg.watchList || []) {
    if (!game.pinnedChannel) continue;
    const tabId = watchTabs[game.slug];
    if (tabId == null) continue;
    const state = pinnedTabState.get(tabId);
    // no state yet just means this tab hasn't had time to report in since it
    // was opened/discovered - give it PINNED_HEARTBEAT_TIMEOUT_MS from now,
    // don't reload a brand-new tab
    if (!state) { pinnedTabState.set(tabId, { offlineTicks: 0, lastHeartbeatAt: now }); continue; }
    if (now - state.lastHeartbeatAt > PINNED_HEARTBEAT_TIMEOUT_MS) {
      const idleMin = Math.round((now - state.lastHeartbeatAt) / 60000);
      await reloadPinnedTab(tabId, game.channel, `stopped reporting entirely (tab likely discarded) for ${idleMin} min`);
    }
  }
}

async function handleDirectoryPicked(slug, channel, tab) {
  return serialized(async () => {
    if (!tab) return;
    const cfg = await browser.storage.local.get(["watchTabs", "watchMeta", "dropSignals"]);
    if ((cfg.watchTabs || {})[slug] !== tab.id) return; // stale message from a tab no longer tracked for this slug

    const watchMeta = { ...(cfg.watchMeta || {}) };
    const dropSignals = { ...(cfg.dropSignals || {}) };
    const prev = watchMeta[slug];
    let freshChannel = false;

    if (prev && prev.channel === channel) {
      // Same channel re-picked - happens when content.js's DOM offline/raid
      // check (handleChannelLeft below) bounces the tab to the directory
      // but Twitch's own listing hasn't dropped this channel yet, so
      // pickBestChannel() re-selects it. Deliberately keep the existing
      // watchStartedAt/baseline going rather than resetting the verify
      // clock: only verifyDropStatus's campaign-progress comparison may
      // decide to reject a channel (see the top-of-file comment) - if this
      // reset on every re-pick, a channel that keeps getting re-picked
      // before the listing catches up would never accumulate enough
      // elapsed time for that check to ever fire, and would sit there
      // indefinitely instead of eventually rotating.
      log("watch tab for", slug, `tab=${tab.id}`, "re-picked the same channel", channel, "- keeping existing verify clock");
    } else {
      watchMeta[slug] = { channel, tabId: tab.id, watchStartedAt: Date.now() };
      delete dropSignals[slug]; // fresh channel, fresh signals
      freshChannel = true;
      log("watch tab for", slug, `tab=${tab.id}`, "now on channel", channel);
    }

    await browser.storage.local.set({ watchMeta, dropSignals });

    if (freshChannel) {
      // fire-and-forget - never block picking the channel on this
      (async () => {
        const { id: watchWindowId } = await getOrCreateWatchWindow();
        if (watchWindowId == null) return; // no isolated window - never flash in the user's own
        try {
          const liveTab = await browser.tabs.get(tab.id);
          if (liveTab.windowId === watchWindowId) await flashTabToStartPlayback(tab.id);
        } catch {
          // tab already gone
        }
      })();
    }
  });
}

// content.js's own DOM offline/raid check already navigates its own tab
// back to the directory immediately on its own (see content.js,
// looksLive()/looksOffline(), a same-tab location.href - not a
// WebExtension action, so it's not something this file commands or could
// prevent even if it wanted to). This handler is deliberately NOT allowed
// to reject/blocklist the channel or touch watchMeta/dropSignals on its
// own - see the top-of-file comment on why: that decision belongs solely
// to verifyDropStatus's campaign-progress comparison. Left as a log-only
// hint. watchMeta is deliberately left untouched here so
// handleDirectoryPicked's same-channel re-pick handling (above) can keep
// the verify clock running across any bounce this DOM check causes.
async function handleChannelLeft(slug) {
  if (!slug) return;
  log(slug, "- DOM check reported offline/redirected (informational only, does not reject the channel)");
}

// Exception to the rule above: an offline channel, or one whose own stream
// info now names a different game, is confirmed twice by content.js
// (channelProblem(), 10s apart) and is unambiguous, not a heuristic - and the
// tab is already on its way back to the directory, where Twitch's listing
// often still shows the channel for a while and pickBestChannel() would
// re-pick it. So it only gets a short block (not rejectChannel's 45 min, and
// watchMeta/dropSignals stay untouched).
async function handleChannelUnusable(msg) {
  const { slug, channel, reason } = msg;
  if (!slug || !channel) return;
  return serialized(async () => {
    const cfg = await browser.storage.local.get(["blockedChannels"]);
    const blockedChannels = { ...(cfg.blockedChannels || {}) };
    blockedChannels[slug] = {
      ...(blockedChannels[slug] || {}),
      [channel.toLowerCase()]: Date.now() + UNUSABLE_CHANNEL_COOLDOWN_MS,
    };
    await browser.storage.local.set({ blockedChannels });
    log(slug, "- channel", channel, "unusable (" + reason + "), skipped for", UNUSABLE_CHANNEL_COOLDOWN_MS / 60000, "min");
    maybeAutoExportDebugLog();
  });
}

async function handleGqlDropSignal(msg, tab) {
  if (!tab) return;

  // openCampaigns is a full snapshot of every drop campaign Twitch currently
  // lists (captured while the user has /drops/campaigns open)
  // - account-wide, not tied to a watch tab, so handled before the slug-gate.
  // id -> real category slug, learned from SideNav (which carries id + slug
  // together). Global, not tab-scoped - handled before the slug gate.
  if (msg.signal.kind === "gameSlugs") {
    return serialized(async () => {
      const cfg = await browser.storage.local.get(["gameSlugMap", "gameIdMap"]);
      const gameSlugMap = { ...(cfg.gameSlugMap || {}) };
      const gameIdMap = { ...(cfg.gameIdMap || {}) };
      let changed = false;
      for (const g of msg.signal.games) {
        if (g.slug && gameSlugMap[g.id] !== g.slug) { gameSlugMap[g.id] = g.slug; changed = true; }
        if (g.name && gameIdMap[g.id] !== g.name) { gameIdMap[g.id] = g.name; changed = true; }
      }
      if (changed) await browser.storage.local.set({ gameSlugMap, gameIdMap });
    });
  }

  if (msg.signal.kind === "openCampaigns") {
    await serialized(async () => {
      const cfg = await browser.storage.local.get(["gameIdMap", "gameSlugMap"]);
      const gameIdMap = { ...(cfg.gameIdMap || {}) };
      for (const g of msg.signal.games) {
        if (g.id && g.name && gameIdMap[String(g.id)] !== g.name) gameIdMap[String(g.id)] = g.name;
      }
      const bySlug = buildOpenCampaignsSnapshot(msg.signal.games, cfg.gameSlugMap || {});
      await browser.storage.local.set({
        gameIdMap,
        openCampaigns: { fetchedAt: Date.now(), bySlug },
      });
      const activeCount = Object.values(bySlug).filter((c) => c.active).length;
      log("[openCampaigns] snapshot:", Object.keys(bySlug).length, "games,", activeCount, "with an open campaign");
    });
    // not inside the serialized block above - annotateWatchListFromCampaigns
    // runs its own serialized units (see its comment)
    await annotateWatchListFromCampaigns();
    return;
  }

  // gameIds is global (game.id -> game.name), not tied to any particular
  // watch tab/slug - deliberately handled before the slug-gate below, which
  // would otherwise drop it whenever it comes from a tab that isn't
  // currently one of our own watch tabs (which, so far, is the only place
  // it's actually been observed - see inject.js's top-of-file comment).
  if (msg.signal.kind === "gameIds") {
    return serialized(async () => {
      const cfg = await browser.storage.local.get(["gameIdMap", "gameActiveIds"]);
      const gameIdMap = { ...(cfg.gameIdMap || {}) };
      const gameActiveIds = { ...(cfg.gameActiveIds || {}) };
      let changed = false;
      for (const g of msg.signal.games) {
        if (gameIdMap[g.id] !== g.name) {
          gameIdMap[g.id] = g.name;
          changed = true;
        }
      }
      // active is only present on extractors that actually carry Twitch's
      // own campaign.status (currently just Inventory - see inject.js);
      // OR within this one batch so a game with both an active and an
      // expired campaign card still counts as active. Each fresh batch
      // fully replaces the previous verdict for the ids it mentions (not
      // sticky-true-forever) so a game that later truly finishes for good
      // still becomes correctly detectable as done.
      const activeThisBatch = {};
      for (const g of msg.signal.games) {
        if (g.active === undefined) continue;
        activeThisBatch[g.id] = activeThisBatch[g.id] || !!g.active;
      }
      for (const [id, active] of Object.entries(activeThisBatch)) {
        if (gameActiveIds[id] !== active) {
          gameActiveIds[id] = active;
          changed = true;
        }
      }
      if (changed) {
        await browser.storage.local.set({ gameIdMap, gameActiveIds });
        log("[gameIdMap] learned:", msg.signal.games.map((g) => `${g.id}=${g.name}`).join(", "));
      }
    });
  }

  return serialized(async () => {
    const cfg = await browser.storage.local.get(["watchTabs", "dropSignals"]);
    const watchTabs = cfg.watchTabs || {};
    const slug = Object.keys(watchTabs).find((s) => watchTabs[s] === tab.id);
    if (!slug) return; // signal from a tab we're not tracking (e.g. the user's own browsing)

    const dropSignals = { ...(cfg.dropSignals || {}) };
    const entry = { ...(dropSignals[slug] || {}) };

    if (msg.signal.kind === "channelCampaigns") {
      entry.channelCampaigns = { campaignIds: msg.signal.campaignIds, at: msg.at };
    } else if (msg.signal.kind === "inventory") {
      // Inventory is account-wide, covering every in-progress campaign at
      // once - pick out the entry for the game this tab is watching by
      // matching its display name back to our slug (shared.js's toSlug is
      // already loaded in this context).
      const match = (msg.signal.campaigns || []).find(
        (c) => c.gameName && toSlug(c.gameName) === slug
      );
      if (match) {
        entry.latestMinutesWatched = match.minutesWatched;
        entry.latestMinutesAt = msg.at;
      }
    }

    dropSignals[slug] = entry;
    await browser.storage.local.set({ dropSignals });
  });
}

// ============================================================================
// alarms
// ============================================================================
async function applyEnabledState(enabled) {
  if (enabled) {
    browser.alarms.create(RELOAD_ALARM, { periodInMinutes: RELOAD_PERIOD_MIN });
    browser.alarms.create(AUTO_OFF_ALARM, { periodInMinutes: AUTO_OFF_PERIOD_MIN });
    browser.alarms.create(AUTO_WATCH_ALARM, { periodInMinutes: AUTO_WATCH_PERIOD_MIN });
    await serialized(openInventoryIfMissing);
    await serialized(autoWatchTick);
  } else {
    await browser.alarms.clear(RELOAD_ALARM);
    await browser.alarms.clear(AUTO_OFF_ALARM);
    await browser.alarms.clear(AUTO_WATCH_ALARM);
    await teardownAllWatch("master switch off");
  }
  await refreshBadge();
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  const cfg = await browser.storage.local.get("enabled");
  if (!cfg.enabled) return;

  if (alarm.name === RELOAD_ALARM) {
    try {
      const tabs = await browser.tabs.query({ url: "*://www.twitch.tv/drops/inventory*" });
      if (tabs.length === 0) {
        await serialized(openInventoryIfMissing);
        return;
      }
      for (const tab of tabs) {
        if (!tab.active) {
          browser.tabs.reload(tab.id);
          log("reloaded inventory tab", tab.id);
        }
      }
    } catch (e) {
      log("reload failed:", e);
    }
  } else if (alarm.name === AUTO_OFF_ALARM) {
    checkAutoOff();
  } else if (alarm.name === AUTO_WATCH_ALARM) {
    serialized(autoWatchTick);
    serialized(verifySweep);
  }
});

// ============================================================================
// messages from content scripts
// ============================================================================
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "isWatchTab":
      return (async () => {
        const cfg = await browser.storage.local.get([
          "enabled", "autoWatchEnabled", "watchTabs", "watchList", "blockedChannels",
        ]);
        if (!cfg.enabled || !cfg.autoWatchEnabled || !sender.tab) {
          return { isWatchTab: false, activeGame: null, blockedChannels: [] };
        }
        const watchTabs = cfg.watchTabs || {};
        const slug = Object.keys(watchTabs).find((s) => watchTabs[s] === sender.tab.id);
        if (!slug) return { isWatchTab: false, activeGame: null, blockedChannels: [] };
        const game = (cfg.watchList || []).find((g) => g.slug === slug) || { slug, input: slug };
        const now = Date.now();
        const blockedForSlug = (cfg.blockedChannels || {})[slug] || {};
        const blockedChannels = Object.keys(blockedForSlug).filter((name) => blockedForSlug[name] > now);
        return { isWatchTab: true, activeGame: game, blockedChannels };
      })();

    case "directoryInvalid":
      return handleDirectoryInvalid(msg.slug, msg.actualPathname, msg.actualHref);

    case "directoryEmpty":
      return handleDirectoryEmpty(msg.slug);

    case "directoryUnknownCategory":
      return handleDirectoryUnknownCategory(msg);

    case "searchCategoryResult":
      return handleSearchCategoryResult(msg);

    case "reportBug":
      return reportBugToGitHub();

    case "directoryPicked":
      return handleDirectoryPicked(msg.slug, msg.channel, sender.tab);

    case "channelOffline":
    case "channelGameChanged":
      return handleChannelUnusable(msg);

    case "channelRedirected":
      return handleChannelLeft(msg.slug);

    case "channelPlayingGame":
      return handleChannelPlayingGame(msg, sender.tab);

    case "pinnedChannelStatus":
      return handlePinnedChannelStatus(msg, sender.tab);

    case "gqlDropSignal":
      return handleGqlDropSignal(msg, sender.tab);

    case "inventoryProgress":
      return mergeInventoryProgress(msg.campaigns);

    case "dropClaimed":
      return handleDropClaimed();

    case "claimAsk":
      return handleClaimAsk(msg);

    case "claimRelease":
      return handleClaimRelease(msg);

    case "claimResult":
      return handleClaimResult(msg);

    default:
      return undefined;
  }
});

// ============================================================================
// react to relevant storage changes without needing a reload
// ============================================================================
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;

  if (changes.enabled) {
    const enabled = changes.enabled.newValue ?? true;
    if (enabled && !changes.enabled.oldValue) {
      // turned back on - drop the "auto-off: all collected" marker and the
      // stale all-done phase so the scheduler starts fresh
      await browser.storage.local.set({ enabledSince: Date.now(), completedAllAt: null, watchPhase: "idle" });
    }
    await applyEnabledState(enabled);
  }

  if (changes.autoWatchEnabled) {
    if (changes.autoWatchEnabled.newValue) {
      await serialized(autoWatchTick);
    } else {
      await teardownAllWatch("auto-watch turned off");
    }
  }

  if (changes.watchList && !suppressWatchListReaction) {
    const newList = changes.watchList.newValue || [];
    const slugs = new Set(newList.map((g) => g.slug));
    const cfg = await browser.storage.local.get(["invalidSlugs", "gameWaitUntil"]);
    const prevInvalidSlugs = cfg.invalidSlugs;
    const invalidSlugs = { ...(prevInvalidSlugs && !Array.isArray(prevInvalidSlugs) ? prevInvalidSlugs : {}) };
    for (const s of Object.keys(invalidSlugs)) {
      if (!slugs.has(s)) delete invalidSlugs[s];
    }
    // drop any manual wait-until date for a game that's no longer listed
    const gameWaitUntil = { ...(cfg.gameWaitUntil || {}) };
    let waitPruned = false;
    for (const s of Object.keys(gameWaitUntil)) {
      if (!slugs.has(s)) { delete gameWaitUntil[s]; waitPruned = true; }
    }
    await browser.storage.local.set(waitPruned ? { invalidSlugs, gameWaitUntil } : { invalidSlugs });
    await serialized(autoWatchTick);
    // re-resolve names / open-campaign status for the new list against
    // whatever snapshot is already stored (account-wide, so it covers a
    // just-added game too). Not awaited, so the popup's save returns
    // immediately.
    annotateWatchListFromCampaigns()
      .catch((e) => log("campaign annotate after watchList change failed:", e));
  }

  if (changes.tabQuota || changes.priorityMode) {
    await serialized(autoWatchTick);
  }

  // popup's language picker writes uiLang - the toolbar tooltip is localized
  if (changes.uiLang) {
    await refreshBadge();
  }

  // popup's per-game "start watching from <date>" picker writes gameWaitUntil
  // directly - re-run the scheduler so a newly-set date pulls a tab now, and
  // a cleared/passed one lets the game back in
  if (changes.gameWaitUntil && !suppressWatchListReaction) {
    await serialized(autoWatchTick);
  }
});

// ---- runs when the background script loads (extension enabled / browser just started) ----
(async () => {
  const cfg = await browser.storage.local.get(["enabled", "enabledSince"]);
  const enabled = cfg.enabled ?? true;
  if (enabled && !cfg.enabledSince) {
    await browser.storage.local.set({ enabledSince: Date.now() });
  }
  await resetStateForNewBrowserSession();
  await applyEnabledState(enabled);
})();
