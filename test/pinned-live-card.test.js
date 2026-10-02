/**
 * pinned-live-card.test.js
 *
 * Root cause of the "no live/offline verdict for hours" report (0.6.22): a pinned tab opened on a
 * channel while it was OFFLINE does not switch to the player when the channel goes live. The
 * channel home keeps its banner, gets a "Live Now" card ("<channel> is streaming <game>", a "Watch
 * now with N viewers" link) and the avatar a red LIVE badge. No offline marker, no player: the
 * verdict was null for hours and the stream never played.
 *
 * Built from the REAL HTML captured from Twitch (test/fixtures):
 *   card-live-now.html       GEEGA's home while live (Grand Theft Auto V)
 *   avatar-live-badge.html   GEEGA's avatar with the LIVE badge
 *   card-offlive-now.html    ds_lily's home while offline (a VOD "[DROPS+GIFT]" ... "Last Epoch")
 *   avatar-offlive-badge.html ds_lily's avatar while offline
 *
 *  - live card / own avatar badge -> verdict live, the game read from the live card ONLY
 *    ("Grand Theft Auto V" - so the 0.6.18 wrong-game check works), the page gets into the
 *    player (a reload - a page that loads while the stream is live shows the player; if the
 *    fresh page still shows the card, a click on "Watch now" once), then ONE flash per live
 *    session;
 *  - the offline page: verdict offline, no game name read from its text, not live, no drops signal;
 *  - a LIVE badge in the sidebar (another channel's, or this channel's own) is not counted;
 *  - explicit offline markers (.channel-status-info--offline / .home-offline-hero) alone are enough.
 *
 * Real content.js on a jsdom page + real background.js.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { MIN, flush, read, makeClock, makeBackground } = require("./claim-harness");

const fx = (f) => fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8");
const LIVE_CARD = fx("card-live-now.html");
const LIVE_AVATAR = fx("avatar-live-badge.html");
const OFFLINE_HOME = fx("card-offlive-now.html");
const OFFLINE_AVATAR = fx("avatar-offlive-badge.html");

const TAB = 73;
const entry = (name) => ({ input: `@${name}`, slug: `channel:${name.toLowerCase()}`, channel: name, pinnedChannel: true });

async function world(name) {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const flashes = [];
  const reloads = [];
  vm.runInContext(`
    getOrCreateWatchWindow = async () => ({ id: 100, freshlyCreated: false });
    flashTabToStartPlayback = async (id) => { __flashes.push([id, Date.now()]); };
    browser.tabs.get = async (id) => ({ id, windowId: 100 });
    browser.tabs.reload = async (id) => { __reloads.push([id, Date.now()]); };
  `, Object.assign(bg.ctx, { __flashes: flashes, __reloads: reloads }));
  const slug = `channel:${name.toLowerCase()}`;
  bg.local.enabled = true;
  bg.local.autoWatchEnabled = true;
  bg.local.openCampaigns = { fetchedAt: clock.now, bySlug: {} };
  bg.local.watchList = [entry(name)];
  bg.local.watchTabs = { [slug]: TAB };
  bg.local.watchMeta = { [slug]: { channel: name, tabId: TAB, watchStartedAt: clock.now } };
  return { clock, bg, flashes, reloads, name, rec: () => (bg.local.pinnedLive || {})[slug] };
}

// a channel page: the real content.js in front of the given body; returns the page's 60 s beat
async function page(w, html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: `https://www.twitch.tv/${w.name.toLowerCase()}` });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  const intervals = [];
  const sent = [];
  const clicks = [];
  window.document.addEventListener("click", (e) => { const a = e.target.closest("a"); if (a) { clicks.push(a.getAttribute("data-a-target") || a.getAttribute("href")); e.preventDefault(); } }, true);
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    Set, Map, Promise, URL, JSON, Math, Array, Object, Number, String, RegExp,
    Date: w.clock.FakeDate,
    window, document: window.document, location: window.location,
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {},
    setTimeout: (fn, ms) => w.clock.setTimeout(fn, ms), clearTimeout: (t) => w.clock.clearTimeout(t),
    browser: {
      storage: { local: { get: () => Promise.resolve({ enabled: true, gameIdMap: {} }), set: () => Promise.resolve() }, onChanged: { addListener() {} } },
      runtime: { sendMessage: (m) => { sent.push(m); return w.bg.send(m, TAB); }, onMessage: { addListener() {} } },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("content.js"), ctx);
  await flush();
  const beat = async () => { for (const i of intervals.filter((x) => x.ms === 60_000)) await i.fn(); await flush(); await flush(); };
  return { beat, sent, clicks, status: () => sent.filter((m) => m.type === "pinnedChannelStatus"), games: () => sent.filter((m) => m.type === "channelPlayingGame") };
}

const PLAYER_PAGE = '<div data-a-target="animated-channel-viewers-count">2K</div><a data-a-target="stream-game-link" href="/directory/category/grand-theft-auto-v">Grand Theft Auto V</a>';

async function testLiveCardIsLiveWithTheGameFromTheCard() {
  const w = await world("GEEGA");
  const p = await page(w, LIVE_CARD + LIVE_AVATAR);
  await p.beat();
  assert.strictEqual(w.rec().state, "live", "the Live Now card is a live verdict: " + JSON.stringify(w.rec()));
  const st = p.status()[0];
  assert.strictEqual(st.live, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(st.liveHome)), { via: "card", game: "Grand Theft Auto V" });
  assert.deepStrictEqual(p.games().map((m) => [m.slug, m.gameName]), [["grand-theft-auto-v", "Grand Theft Auto V"]], "the game is read from the card so the wrong-game check (0.6.18) can work");
  console.log("  OK  Live Now card (real HTML) -> live, game 'Grand Theft Auto V'");
}

async function testAvatarBadgeAloneIsLive() {
  const w = await world("GEEGA");
  const p = await page(w, LIVE_AVATAR);
  await p.beat();
  assert.strictEqual(w.rec().state, "live");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.status()[0].liveHome)), { via: "badge", game: null });
  assert.strictEqual(p.games().length, 0, "a badge says nothing about the game");
  console.log("  OK  the channel's own LIVE badge (real HTML) -> live, no game");
}

async function testTheOfflinePageIsOfflineAndItsTextIsNeverRead() {
  const w = await world("ds_lily");
  const p = await page(w, OFFLINE_HOME + OFFLINE_AVATAR);
  await p.beat();
  assert.strictEqual(w.rec().state, "offline", "offline page: " + JSON.stringify(w.rec()));
  const st = p.status()[0];
  assert.strictEqual(st.live, false);
  assert.ok(!st.liveHome, "not counted as live");
  assert.strictEqual(p.games().length, 0, "no game name is read from the offline page ('Last Epoch', '[DROPS+GIFT]')");
  assert.ok(!p.sent.some((m) => /Last Epoch|DROPS/.test(JSON.stringify(m))), "none of its text reaches the background");
  assert.strictEqual(w.reloads.length, 0);
  assert.strictEqual(w.flashes.length, 0);
  console.log("  OK  the offline page (real HTML): offline, no game read, nothing counted as live or as a drops signal");
}

async function testExplicitOfflineMarkersAreEnough() {
  const w = await world("ds_lily");
  // none of the older selectors (.channel-root__player--offline, home-offline-carousel, "is offline" text)
  const p = await page(w, '<div class="channel-status-info channel-status-info--offline"><strong>Nothing</strong></div>');
  await p.beat();
  assert.strictEqual(w.rec().state, "offline", "the status line's own marker");
  const w2 = await world("ds_lily");
  const p2 = await page(w2, '<div class="home-offline-hero"></div>');
  await p2.beat();
  assert.strictEqual(w2.rec().state, "offline", "the hero's own marker");
  console.log("  OK  .channel-status-info--offline / .home-offline-hero alone give an offline verdict");
}

async function testALiveBadgeInTheSidebarOrOfAnotherChannelIsNotCounted() {
  const sidebarOther = '<div class="side-nav"><a class="side-nav-card" href="/someoneelse"><div class="tw-channel-status-text-indicator"><span>LIVE</span></div></a></div>';
  const sidebarOwn = '<div class="side-nav"><a class="side-nav-card" href="/ds_lily"><div class="tw-channel-status-text-indicator"><span>LIVE</span></div></a></div>';
  const otherInPage = '<div class="somewhere"><a href="/GEEGA"><div class="tw-channel-status-text-indicator"><span>LIVE</span></div></a></div>';
  const otherCard = '<div class="home-carousel-info home-carousel-info--live"><h2><span>GEEGA</span> is streaming <span>Grand Theft Auto V</span></h2><a data-a-target="home-live-overlay-button" href="/GEEGA">Watch now</a></div>'; // a card of another channel
  for (const [label, extra] of [["another channel in the sidebar", sidebarOther], ["this channel's own sidebar entry", sidebarOwn], ["another channel's badge in the page", otherInPage], ["another channel's Live Now card", otherCard]]) {
    const w = await world("ds_lily");
    const p = await page(w, OFFLINE_HOME + OFFLINE_AVATAR + extra);
    await p.beat();
    assert.strictEqual(w.rec().state, "offline", `${label}: not live (${JSON.stringify(w.rec())})`);
    assert.ok(!p.status()[0].liveHome, label);
  }
  console.log("  OK  a LIVE badge / card of another channel or in the sidebar is not counted");
}

async function testGettingIntoThePlayerThenOneFlashPerLiveSession() {
  const w = await world("GEEGA");
  const card = await page(w, LIVE_CARD + LIVE_AVATAR);
  await card.beat();
  assert.deepStrictEqual(w.reloads.map((r) => r[0]), [TAB], "first: the tab is reloaded - a page that loads while live shows the player");
  assert.ok(w.bg.logLines().some((l) => /pinned channel geega - is live \(Grand Theft Auto V\) but its page only shows the offline home with a Live Now card/.test(l)), "logged clearly");
  assert.ok(w.bg.logLines().some((l) => /pinned channel geega resolved to game grand-theft-auto-v/.test(l)), "the game from the card reached the game binding (0.6.18)");
  assert.strictEqual(w.flashes.length, 0, "no flash while only the card shows");
  assert.strictEqual(card.clicks.length, 0);

  // the reloaded page loads straight into the player: live, flashed - once
  w.clock.advanceTo(w.clock.now + 20_000);
  const player = await page(w, PLAYER_PAGE);
  await player.beat();
  assert.strictEqual(w.rec().state, "live");
  assert.deepStrictEqual(w.flashes.map((f) => f[0]), [TAB], "flashed once the player is there");
  for (let i = 0; i < 8; i++) { w.clock.advanceTo(w.clock.now + MIN); await player.beat(); }
  assert.strictEqual(w.flashes.length, 1, "no more flashes for as long as it stays live (it was every 2 minutes)");
  assert.strictEqual(w.reloads.length, 1, "and no more reloads");

  // offline, then live again = a new live session: flashed again
  const off = await page(w, OFFLINE_HOME);
  await off.beat();
  assert.strictEqual(w.rec().state, "offline");
  w.clock.advanceTo(w.clock.now + 5 * MIN);
  const again = await page(w, PLAYER_PAGE);
  await again.beat();
  assert.strictEqual(w.flashes.length, 2, "a new live session is flashed once more");
  console.log("  OK  card -> one reload -> player -> ONE flash per live session (a new session flashes again)");
}

async function testIfTheReloadedPageStillShowsTheCardWatchNowIsClickedOnce() {
  const w = await world("GEEGA");
  const first = await page(w, LIVE_CARD);
  await first.beat();
  assert.strictEqual(w.reloads.length, 1);
  w.clock.advanceTo(w.clock.now + 30_000);
  const second = await page(w, LIVE_CARD); // the fresh page still shows the card
  await second.beat();
  assert.deepStrictEqual(second.clicks, ["home-live-overlay-button"], "Twitch's own 'Watch now' link is clicked");
  assert.strictEqual(w.reloads.length, 1, "no second reload");
  await second.beat();
  w.clock.advanceTo(w.clock.now + MIN);
  await second.beat();
  assert.strictEqual(second.clicks.length, 1, "clicked once, not on every beat");
  assert.strictEqual(w.reloads.length, 1, "never a reload loop");
  assert.strictEqual(w.flashes.length, 0, "nothing to flash until the player is there");
  console.log("  OK  card still there after the reload -> 'Watch now' clicked once; no reload loop");
}

(async () => {
  console.log("Running pinned Live Now card tests (real HTML fixtures, real content.js + background.js)...\n");
  try {
    await testLiveCardIsLiveWithTheGameFromTheCard();
    await testAvatarBadgeAloneIsLive();
    await testTheOfflinePageIsOfflineAndItsTextIsNeverRead();
    await testExplicitOfflineMarkersAreEnough();
    await testALiveBadgeInTheSidebarOrOfAnotherChannelIsNotCounted();
    await testGettingIntoThePlayerThenOneFlashPerLiveSession();
    await testIfTheReloadedPageStillShowsTheCardWatchNowIsClickedOnce();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
