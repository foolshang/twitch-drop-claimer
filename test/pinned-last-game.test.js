/**
 * pinned-last-game.test.js
 *
 * "@GEEGA (Grand Theft Auto V)" kept showing the last game seen after its campaign was done and its tab closed,
 * although GEEGA had moved on to Rust. The game in brackets is the CURRENT one: shown only while the entry's tab is
 * open and reporting; otherwise it is "last seen: <game>" on its own line (9 languages).
 */

const assert = require("assert");
const { renderPopupRows, pinnedEntry } = require("./campaign-matching.test.js");
const { I18N, I18N_LANGS } = require("../i18n.js");

const en = I18N.en;
const GEEGA = (extra = {}) => pinnedEntry("geega", { gameSlug: "grand-theft-auto-v", pinnedGameName: "Grand Theft Auto V", ...extra });
const done = { "channel:geega": { label: "Rust", claimed: 1, total: 1, allComplete: true, expired: false, timeRemainingMin: 0, campaignNames: ["Rust Isles Launcher"], updatedAt: 1 } };

async function testNoCurrentGameWithoutAnOpenReportingTab() {
  // done, its tab closed
  let rows = await renderPopupRows({ watchList: [GEEGA()], watchTabs: {}, campaignProgress: done });
  assert.ok(/^1\. @geega$/.test(rows[0].name), "no game in brackets: " + rows[0].name);
  assert.ok(rows[0].details.includes(en.row_last_game.replace("{game}", "Grand Theft Auto V")), "'last seen' instead: " + JSON.stringify(rows[0].details));

  // a tab is open and the page says it is live: the current game, as before
  rows = await renderPopupRows({ watchList: [GEEGA()], watchTabs: { "channel:geega": 5 } });
  assert.ok(/^1\. @geega \(Grand Theft Auto V\)$/.test(rows[0].name), "open and live: " + rows[0].name);
  assert.ok(!rows[0].details.some((d) => /last seen/.test(d)), "no 'last seen' line then");

  // a tab is open but offline / still checking: what it played is not current either
  rows = await renderPopupRows({ watchList: [GEEGA()], watchTabs: { "channel:geega": 5 }, pinnedLive: { "channel:geega": { tabId: 5, state: "offline", at: 1 } } });
  assert.ok(/^1\. @geega$/.test(rows[0].name), "offline: " + rows[0].name);
  assert.ok(rows[0].details.some((d) => /last seen/.test(d)));

  // waiting without a tab (e.g. over the cap): same
  rows = await renderPopupRows({ watchList: [GEEGA()], watchTabs: {} });
  assert.ok(/^1\. @geega$/.test(rows[0].name));

  // a pinned channel with no game ever seen has nothing to show either way
  rows = await renderPopupRows({ watchList: [pinnedEntry("newguy")], watchTabs: {} });
  assert.ok(/^1\. @newguy$/.test(rows[0].name) && !rows[0].details.some((d) => /last seen/.test(d)));
  console.log("  OK  the game in brackets only while the tab is open and live; otherwise 'last seen: <game>'");
}

function testAllLanguages() {
  for (const { code } of I18N_LANGS) {
    assert.ok(/\{game\}/.test(I18N[code].row_last_game || ""), `${code}.row_last_game`);
    if (code !== "en") assert.notStrictEqual(I18N[code].row_last_game, en.row_last_game, `${code} is translated`);
  }
  console.log("  OK  'last seen: {game}' exists in all 9 languages");
}

(async () => {
  console.log("Running pinned last-game display tests...\n");
  try {
    await testNoCurrentGameWithoutAnOpenReportingTab();
    testAllLanguages();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
