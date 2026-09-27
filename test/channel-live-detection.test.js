/**
 * channel-live-detection.test.js
 *
 * Exercises content.js's looksLive() / looksOffline() against a real jsdom
 * DOM, using fixtures built from the actual channel-page markup captured
 * live over the Firefox Remote Debugging Protocol on 2026-09-01 (a
 * `web-ext run` instance pointed at a copy of the logged-in profile):
 *
 *   live channel  (twitch.tv/warframe):
 *     <div class="channel-root channel-root--live channel-root--watch ...">
 *       <div class="channel-root__player"> ... <video> ... </div>
 *     [data-a-target="animated-channel-viewers-count"] present
 *
 *   offline channel  (twitch.tv/ghazzytv, autohosting):
 *     <div class="channel-root ...">   (no --live modifier)
 *       <div class="channel-root__player channel-root__player--offline">
 *       <div class="channel-root__info channel-root__info--offline channel-root__info--home">
 *     [data-a-target="home-offline-carousel"] present
 *     [data-a-target="animated-channel-viewers-count"] absent
 *     NOTE: the old `.channel-status-info--offline` selector matched ZERO
 *     elements in both captures - it is fully stale. An autohosting-while-
 *     offline channel uses `.channel-status-info--autohost`; the new
 *     `.channel-root__info--offline` check covers it.
 *
 * The point of this file: lock in that the offline check keys off the
 * viewed channel's own page root, not off any "LIVE" badge that a *different*
 * channel contributes to the sidebar - the exact contamination that left a
 * watch tab stuck on a dead channel (see HISTORY.md 2026-08-27).
 *
 * Uses jsdom (test-only devDependency; content.js has zero runtime deps).
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// content.js wraps its whole body in one top-level `(() => { ... })();` IIFE
// so its inner functions aren't reachable from a vm context - strip just
// that outer wrapper (content.js itself is never modified). Mirrors
// inventory-parse.test.js's readContentJsUnwrapped().
function readContentJsUnwrapped() {
  const src = read("content.js");
  const startMarker = "(() => {";
  const endMarker = "})();";
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.lastIndexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error("content.js's IIFE wrapper markers changed - update readContentJsUnwrapped()");
  }
  return src.slice(startIdx + startMarker.length, endIdx);
}

// A followed/live-channels sidebar that always lists OTHER channels as live,
// with their own "LIVE" status badges - present in every real capture, and
// the source of the historical false-positive.
const SIDEBAR_WITH_OTHER_LIVE_CHANNELS = `
  <nav class="side-nav">
    <div class="side-nav-card">
      <a class="side-nav-card__link" href="/someoneelse">
        <div class="side-nav-card__live-status"><span>LIVE</span></div>
        <div class="tw-channel-status-text-indicator">LIVE</div>
      </a>
    </div>
    <div class="side-nav-card">
      <a class="side-nav-card__link side-nav-card__link--offline" href="/anotherperson">
        <div class="side-nav-card__avatar side-nav-card__avatar--offline"></div>
      </a>
    </div>
  </nav>
`;

const LIVE_CHANNEL_MAIN = `
  <div class="root-scrollable__wrapper">
    <div class="channel-root channel-root--live channel-root--watch channel-root--unanimated">
      <div class="channel-root__player">
        <div class="video-player" data-a-target="video-player"><video></video></div>
      </div>
      <div class="channel-root__info channel-root__info--home">
        <div class="channel-info-content">
          <section id="live-channel-stream-information" aria-label="Stream Information">
            <p data-a-target="stream-title">Devshorts #116</p>
            <span class="live-time">0:09:23 since live stream started</span>
            <span data-a-target="animated-channel-viewers-count">7.8K</span>
          </section>
        </div>
      </div>
    </div>
  </div>
`;

// live channel whose stream info carries the category link - markup captured
// live 2026-09-27 (twitch.tv/yuki_nuki, Just Chatting)
const liveWithGame = (slug) => LIVE_CHANNEL_MAIN.replace(
  '<span data-a-target="animated-channel-viewers-count">',
  `<a data-a-target="stream-game-link" class="ScCoreLink tw-link" href="/directory/category/${slug}"><span>Game</span></a>` +
  '<span data-a-target="animated-channel-viewers-count">'
);

const OFFLINE_CHANNEL_MAIN = `
  <div class="root-scrollable__wrapper">
    <div class="channel-root channel-root--unanimated">
      <div class="channel-root__player channel-root__player--offline">
        <div class="home-offline-hero"></div>
        <div class="video-player" data-a-target="video-player" data-a-player-type="channel_home_carousel"><video></video></div>
      </div>
      <div class="channel-root__info channel-root__info--offline channel-root__info--home">
        <div class="channel-info-content">
          <section id="offline-channel-main-content" aria-label="Main Content">
            <div class="channel-status-info channel-status-info--autohost"></div>
          </section>
        </div>
        <div data-a-target="home-offline-carousel"></div>
      </div>
    </div>
  </div>
`;

// offline page root but the player area is a subscriber-only / rerun content
// gate rather than a plain offline banner - explicitly NOT "offline"
const CONTENT_GATE_MAIN = `
  <div class="root-scrollable__wrapper">
    <div class="channel-root channel-root--live channel-root--watch">
      <div class="channel-root__player">
        <div data-a-target="player-overlay-content-gate">Subscribe to watch</div>
      </div>
    </div>
  </div>
`;

// a real category page - always gets an <h1> + a "<Game> - Twitch" title,
// even with zero viewers (title reflects the category's own metadata, not
// who's currently live)
const REAL_CATEGORY_MAIN = `
  <main>
    <h1>Rainbow Six Siege</h1>
    <div class="directory-grid"></div>
  </main>
`;

// a slug with no matching category at all - confirmed live 2026-09-01:
// same URL (no redirect), but the SPA never sets a category title/heading
const UNKNOWN_CATEGORY_MAIN = `
  <main>
    <div class="directory-grid"></div>
  </main>
`;

function makeCtx(mainHtml, { title = "" } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${SIDEBAR_WITH_OTHER_LIVE_CHANNELS}${mainHtml}</body></html>`
  );
  const { window } = dom;
  if (title) window.document.title = title;
  // jsdom has no layout engine -> no innerText; textContent is adequate here
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; },
    configurable: true,
  });

  const storageData = {};
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    document: window.document,
    location: { pathname: "/warframe", href: "https://www.twitch.tv/warframe" },
    MutationObserver: window.MutationObserver,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    browser: {
      storage: {
        local: {
          get: (keys) => {
            if (keys == null) return Promise.resolve({ ...storageData });
            if (typeof keys === "string") return Promise.resolve({ [keys]: storageData[keys] });
            const out = {};
            for (const k of keys) out[k] = storageData[k];
            return Promise.resolve(out);
          },
          set: (obj) => { Object.assign(storageData, obj); return Promise.resolve(); },
        },
        onChanged: { addListener: () => {} },
      },
      runtime: { sendMessage: () => Promise.resolve() },
    },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(readContentJsUnwrapped(), ctx);
  return ctx;
}

const looksLive = (ctx) => vm.runInContext("looksLive", ctx)();
const looksOffline = (ctx) => vm.runInContext("looksOffline", ctx)();
// content.js line ~609: the only condition that makes a watch tab leave a channel
const rotates = (ctx) => !looksLive(ctx) && looksOffline(ctx);

async function testLiveChannelStays() {
  const ctx = makeCtx(LIVE_CHANNEL_MAIN);
  assert.strictEqual(looksLive(ctx), true, "animated-viewer-count present -> live");
  assert.strictEqual(looksOffline(ctx), false, "no offline page-root markers -> not offline");
  assert.strictEqual(rotates(ctx), false, "a live channel must never be rotated away");
  console.log("  OK  a live channel (animated viewer count + .channel-root--live) is kept, not rotated");
}

async function testOfflineChannelRotates() {
  const ctx = makeCtx(OFFLINE_CHANNEL_MAIN);
  assert.strictEqual(looksLive(ctx), false, "no animated-viewer-count -> not live");
  assert.strictEqual(looksOffline(ctx), true, ".channel-root__info--offline present -> offline");
  assert.strictEqual(rotates(ctx), true, "a dead channel must be rotated away");
  console.log("  OK  an offline channel (.channel-root__player--offline / __info--offline) is detected and rotated");
}

async function testSidebarLiveBadgesDoNotKeepADeadChannel() {
  // the regression from HISTORY.md 2026-08-27: other channels' "LIVE"
  // badges in the sidebar kept a stuck tab from ever leaving a dead channel
  const ctx = makeCtx(OFFLINE_CHANNEL_MAIN);
  const sidebarLiveBadges = vm
    .runInContext("document", ctx)
    .querySelectorAll(".tw-channel-status-text-indicator, .side-nav-card__live-status").length;
  assert.ok(sidebarLiveBadges > 0, "fixture must actually contain other channels' live badges");
  assert.strictEqual(looksLive(ctx), false, "sidebar LIVE badges must not make looksLive() true");
  assert.strictEqual(rotates(ctx), true, "still rotates despite sidebar live badges");
  console.log("  OK  other channels' sidebar LIVE badges do not keep a watch tab stuck on a dead channel");
}

async function testContentGateIsNotOffline() {
  const ctx = makeCtx(CONTENT_GATE_MAIN);
  assert.strictEqual(looksOffline(ctx), false, "a subscriber-only / rerun content gate is not 'offline'");
  assert.strictEqual(rotates(ctx), false, "a content-gated channel is not rotated as if dead");
  console.log("  OK  a player content gate (sub-only / rerun) is not treated as offline");
}

async function testStaleOfflineBannerClassNoLongerRelied() {
  // guards against silently regressing to the stale selector: an offline
  // page that has NONE of the old `.channel-status-info--offline` markup
  // must still be detected via the new page-root check
  const ctx = makeCtx(OFFLINE_CHANNEL_MAIN);
  const staleHits = vm
    .runInContext("document", ctx)
    .querySelectorAll(".channel-status-info--offline").length;
  assert.strictEqual(staleHits, 0, "fixture deliberately omits the stale class");
  assert.strictEqual(looksOffline(ctx), true, "offline still detected without the stale class present");
  console.log("  OK  offline detection does not depend on the stale .channel-status-info--offline selector");
}

async function testRealCategoryPageIsNotUnknown() {
  const ctx = makeCtx(REAL_CATEGORY_MAIN, { title: "Rainbow Six Siege - Twitch" });
  const looksLikeUnknownCategory = vm.runInContext("looksLikeUnknownCategory", ctx);
  assert.strictEqual(looksLikeUnknownCategory(), false,
    "a real category (has <h1> + its own title) must never be flagged as unknown");
  console.log("  OK  a real, valid category page is not flagged as unknown even with zero live channels");
}

async function testWrongSlugDetectedAsUnknownCategory() {
  // real capture (2026-09-01): the guessed slug "rainbow-six-siege" for a
  // renamed game kept the same URL (no redirect) but the SPA never set a
  // category title/heading - title stayed the bare default "Twitch"
  const ctx = makeCtx(UNKNOWN_CATEGORY_MAIN, { title: "Twitch" });
  const looksLikeUnknownCategory = vm.runInContext("looksLikeUnknownCategory", ctx);
  assert.strictEqual(looksLikeUnknownCategory(), true,
    "no <h1> + bare 'Twitch' title -> this slug doesn't map to a real category");
  console.log("  OK  a wrong slug (no redirect, but no category title/heading either) is detected as unknown");
}

async function testGameChangeIsDetected() {
  const problem = (html, baseline, seen) =>
    vm.runInContext("channelProblem", makeCtx(html))(baseline, seen);
  assert.strictEqual(problem(liveWithGame("path-of-exile-2"), "path-of-exile-2", true), null,
    "same game as first seen -> no problem");
  assert.strictEqual(problem(liveWithGame("Path-of-Exile-2"), "path-of-exile-2", true), null,
    "slug comparison is case-insensitive");
  assert.strictEqual(problem(liveWithGame("just-chatting"), "path-of-exile-2", true), "game:just-chatting",
    "streamer switched to another category after first seen -> game change");
  assert.strictEqual(problem(LIVE_CHANNEL_MAIN, "path-of-exile-2", true), null,
    "category link not rendered -> can't tell, no problem");
  assert.strictEqual(problem(liveWithGame("rainbow-six-siege"), null, true), null,
    "no baseline yet -> nothing to compare with, and a renamed-game slug never trips it");
  console.log("  OK  a stream switching to another game is detected (missing link / no baseline never is)");
}

async function testEndedStreamWithoutOfflineMarkerIsDetected() {
  const problem = (html, expected, seen) =>
    vm.runInContext("channelProblem", makeCtx(html))(expected, seen);
  const bare = '<div class="channel-root"><div class="channel-root__player"></div></div>';
  assert.strictEqual(problem(bare, "x", true), "offline", "was live, viewer count gone, no marker -> offline");
  assert.strictEqual(problem(bare, "x", false), null, "never seen live yet (still loading) -> not offline");
  assert.strictEqual(problem(CONTENT_GATE_MAIN, "x", true), null, "content gate stays not-offline even after being live");
  assert.strictEqual(problem(OFFLINE_CHANNEL_MAIN, "x", false), "offline", "explicit offline page");
  console.log("  OK  a stream that just ended (no offline marker) is detected, a loading page is not");
}

(async () => {
  console.log("Running channel-live-detection tests (real jsdom DOM, no real browser/network)...\n");
  try {
    await testLiveChannelStays();
    await testOfflineChannelRotates();
    await testSidebarLiveBadgesDoNotKeepADeadChannel();
    await testContentGateIsNotOffline();
    await testStaleOfflineBannerClassNoLongerRelied();
    await testRealCategoryPageIsNotUnknown();
    await testWrongSlugDetectedAsUnknownCategory();
    await testGameChangeIsDetected();
    await testEndedStreamWithoutOfflineMarkerIsDetected();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
