/**
 * pinned-offline-badge.test.js
 *
 * 0.6.20 showed "watching" (and "no expiry date known (using list order)") for pinned channels
 * that were offline and only waiting to go live - nothing is earned then. The popup now follows
 * what the channel's page reports to the background (live / offline / loading):
 *   live     -> "watching"
 *   offline  -> "offline - waiting to go live" (9 languages), and not "playing another game"
 *   loading / nothing reported yet -> "checking the channel...", never "watching"
 * A report from an older tab is ignored once the entry has another tab.
 *
 * Real background.js (status reports through its message handler) + real popup.html/popup.js.
 */

const vm = require("vm");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { MIN, flush, read, makeClock, makeBackground } = require("./claim-harness");
const { I18N, I18N_LANGS } = require("../i18n.js");

const en = I18N.en;
const TAB = 7;
const entry = (channel, extra = {}) => ({ input: `@${channel}`, slug: `channel:${channel.toLowerCase()}`, channel, pinnedChannel: true, ...extra });

async function renderRows(storage, lang = "en-US") {
  const dom = new JSDOM(read("popup.html").replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: "moz-extension://test/popup.html" });
  const w = dom.window;
  const data = { enabled: true, autoWatchEnabled: true, priorityMode: "expiry", ...storage };
  const pick = (keys) => {
    if (keys == null) return { ...data };
    if (typeof keys === "string") return { [keys]: data[keys] };
    const out = {};
    for (const k of keys) out[k] = data[k];
    return out;
  };
  w.browser = {
    storage: { local: { get: (k) => Promise.resolve(pick(k)), set: () => Promise.resolve() }, session: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } },
    runtime: { sendMessage: () => Promise.resolve({}), getManifest: () => ({ version: "0.0.0-test" }) },
    tabs: { query: () => Promise.resolve([]), create() {} },
  };
  Object.defineProperty(w.navigator, "language", { value: lang });
  w.eval([read("i18n.js"), read("shared.js"), read("popup.js")].join("\n"));
  await new Promise((r) => setTimeout(r, 60));
  return [...w.document.querySelectorAll("#gameStatusList .game-status-row")].map((row) => ({
    badge: (row.querySelector(".g-badge") || {}).textContent || "",
    details: [...row.querySelectorAll(".g-detail")].map((d) => d.textContent),
  }));
}

const listOf = (...channels) => ({
  watchList: channels.map((c) => entry(c)),
  watchTabs: Object.fromEntries(channels.map((c, i) => [`channel:${c.toLowerCase()}`, TAB + i])),
});
const live = (channel, i = 0, state = "live") => ({ [`channel:${channel.toLowerCase()}`]: { tabId: TAB + i, state, at: 1 } });

async function testPopupBadgePerPageState() {
  const base = listOf("xChocoBars", "DisguisedToast", "Blooprint", "SomeoneNew");
  const rows = await renderRows({
    ...base,
    pinnedLive: { ...live("xChocoBars", 0, "offline"), ...live("DisguisedToast", 1, "live"), ...live("Blooprint", 2, "loading") }, // SomeoneNew: no report yet
  });
  assert.strictEqual(rows[0].badge, en.badge_pinned_offline, "offline: " + rows[0].badge);
  assert.ok(rows[0].details.some((d) => d.startsWith(en.detail_pinned_offline)), "its detail says it is waiting: " + JSON.stringify(rows[0].details));
  assert.ok(!rows[0].details.some((d) => /no expiry date known/.test(d)), "no 'no expiry date known (using list order)' for an offline channel: " + JSON.stringify(rows[0].details));
  assert.notStrictEqual(rows[0].badge, en.badge_watching);
  assert.strictEqual(rows[1].badge, en.badge_watching, "live: watching as normal");
  assert.strictEqual(rows[2].badge, en.badge_pinned_checking, "a page that is still loading is not 'watching': " + rows[2].badge);
  assert.strictEqual(rows[3].badge, en.badge_pinned_checking, "nor one that has not reported yet: " + rows[3].badge);
  console.log("  OK  popup: offline -> 'offline - waiting to go live'; live -> 'watching'; loading / no report -> 'checking'");
}

async function testOnlineAfterOfflineAndStaleTabReports() {
  const base = listOf("xChocoBars");
  let rows = await renderRows({ ...base, pinnedLive: live("xChocoBars", 0, "offline") });
  assert.strictEqual(rows[0].badge, en.badge_pinned_offline);
  rows = await renderRows({ ...base, pinnedLive: live("xChocoBars", 0, "live") });
  assert.strictEqual(rows[0].badge, en.badge_watching, "the same entry once live");
  // a report from a tab that has since been replaced says nothing about the tab now open
  rows = await renderRows({ ...base, pinnedLive: { "channel:xchocobars": { tabId: 999, state: "live", at: 1 } } });
  assert.strictEqual(rows[0].badge, en.badge_pinned_checking, "an old tab's 'live' is not trusted");
  console.log("  OK  popup: offline -> live changes the badge; a replaced tab's report is ignored");
}

async function testOfflineBeatsPlayingAnotherGame() {
  const base = listOf("mrwobblestwitch");
  const withCampaign = {
    ...base,
    watchList: [entry("mrwobblestwitch", { gameSlug: "im-only-sleeping", pinnedGameName: "I'm Only Sleeping" })],
    campaignProgress: { "channel:mrwobblestwitch": { label: "Rust", claimed: 0, total: 1, allComplete: false, expired: false, timeRemainingMin: 56, campaignNames: ["Tac Gloves"], campaignGameSlugs: ["rust"], campaignGameNames: ["rust"], updatedAt: 1 } },
  };
  let rows = await renderRows({ ...withCampaign, pinnedLive: live("mrwobblestwitch", 0, "live") });
  assert.strictEqual(rows[0].badge, en.badge_other_game, "live on the wrong game (0.6.18): still 'playing another game'");
  rows = await renderRows({ ...withCampaign, pinnedLive: live("mrwobblestwitch", 0, "offline") });
  assert.strictEqual(rows[0].badge, en.badge_pinned_offline, "offline: what it played last is stale, it says offline");
  assert.ok(rows[0].details.some((d) => /0\/1|0 \/ 1/.test(d) || d.includes("1")), "the campaign progress stays visible: " + JSON.stringify(rows[0].details));
  console.log("  OK  popup: wrong game while live; offline once it is offline");
}

async function testFinishedAndOtherStatesAreNotOverridden() {
  const base = { ...listOf("xChocoBars"), campaignProgress: { "channel:xchocobars": { label: "Rust", claimed: 1, total: 1, allComplete: true, expired: false, timeRemainingMin: 0, campaignNames: ["Tac"], updatedAt: 1 } } };
  const rows = await renderRows({ ...base, pinnedLive: live("xChocoBars", 0, "offline") });
  assert.strictEqual(rows[0].badge, en.badge_all_claimed, "a finished campaign stays 'done' whatever the page says: " + rows[0].badge);
  console.log("  OK  popup: a finished campaign keeps its done badge");
}

async function testAllLanguagesHaveTheTexts() {
  for (const { code } of I18N_LANGS) {
    for (const k of ["badge_pinned_offline", "badge_pinned_checking", "detail_pinned_offline"]) {
      assert.ok(I18N[code][k] && I18N[code][k].length > 3, `${code}.${k}`);
    }
    if (code !== "en") assert.notStrictEqual(I18N[code].badge_pinned_offline, en.badge_pinned_offline, `${code} is translated`);
  }
  const th = await renderRows({ ...listOf("xChocoBars"), pinnedLive: live("xChocoBars", 0, "offline") }, "th-TH");
  assert.strictEqual(th[0].badge, I18N.th.badge_pinned_offline, "rendered in the UI language");
  console.log("  OK  the texts exist in all 9 languages and render in the UI language");
}

// ---- background: what the page reports is what the popup gets ----------------------------------------------------
async function testBackgroundRecordsWhatThePageReports() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  bg.local.enabled = true;
  bg.local.watchTabs = { "channel:xchocobars": TAB };
  bg.local.watchList = [entry("xChocoBars")];
  const report = async (live, extra = {}) => { await bg.send({ type: "pinnedChannelStatus", channel: "xChocoBars", live, ...extra }, TAB); await flush(); };
  const state = () => bg.local.pinnedLive && bg.local.pinnedLive["channel:xchocobars"];

  assert.strictEqual(state(), undefined, "nothing before the first report");
  await report(null);
  assert.deepStrictEqual({ tabId: state().tabId, state: state().state }, { tabId: TAB, state: "loading" });
  await report(false);
  assert.strictEqual(state().state, "offline");
  clock.advanceTo(clock.now + MIN);
  await report(false);
  const at = state().at;
  assert.strictEqual(state().state, "offline");
  clock.advanceTo(clock.now + MIN);
  await report(false);
  assert.strictEqual(state().at, at, "written only when the state changes (not every minute)");
  await report(true);
  assert.strictEqual(state().state, "live", "offline -> live");
  await report(false);
  assert.strictEqual(state().state, "offline", "and back");
  console.log("  OK  background: the page's live / offline / loading reports reach storage on change only");
}

(async () => {
  console.log("Running pinned offline badge tests (real popup.js + background.js)...\n");
  try {
    await testPopupBadgePerPageState();
    await testOnlineAfterOfflineAndStaleTabReports();
    await testOfflineBeatsPlayingAnotherGame();
    await testFinishedAndOtherStatesAreNotOverridden();
    await testAllLanguagesHaveTheTexts();
    await testBackgroundRecordsWhatThePageReports();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
