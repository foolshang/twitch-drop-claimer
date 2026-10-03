/**
 * review-b-popup.test.js - findings B6, B7 (and C5) of the 0.6.24 code review (popup.js / shared.js)
 *
 *  B6 background rewrites of the list overwrote unsaved textarea edits; every storage change rebuilt the status rows
 *     (closing the "watch from" calendar, losing a half-typed time)
 *  B7 accents were deleted instead of folded ("Pokémon UNITE" -> pok-mon-unite); a line with nothing a slug can
 *     be built from was dropped silently
 *  C5 "24:00" in the time field meant the START of the chosen day
 */

const vm = require("vm");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { readFile } = require("./world-helpers");

async function openPopup(storage) {
  const dom = new JSDOM(readFile("popup.html").replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: "moz-extension://test/popup.html" });
  const w = dom.window;
  const data = { enabled: true, autoWatchEnabled: true, ...storage };
  const changeListeners = [];
  const pick = (keys) => {
    if (keys == null) return { ...data };
    if (typeof keys === "string") return { [keys]: data[keys] };
    const out = {};
    for (const k of keys) out[k] = data[k];
    return out;
  };
  w.browser = {
    storage: { local: { get: (k) => Promise.resolve(pick(k)), set: (o) => { Object.assign(data, o); return Promise.resolve(); } }, session: { get: () => Promise.resolve({}) }, onChanged: { addListener: (fn) => changeListeners.push(fn) } },
    runtime: { sendMessage: () => Promise.resolve({}), getManifest: () => ({ version: "0.0.0-test" }) },
    tabs: { query: () => Promise.resolve([]), create() {} },
  };
  Object.defineProperty(w.navigator, "language", { value: "en-US" });
  w.eval([readFile("i18n.js"), readFile("shared.js"), readFile("popup.js")].join("\n"));
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  await wait(80);
  const changed = async (changes) => { for (const fn of changeListeners) fn(changes, "local"); await wait(); };
  return { w, data, wait, changed, doc: w.document };
}

const rust = { input: "rust", slug: "rust", displayName: "Rust" };

async function testUnsavedEditsAreNeverOverwritten() {
  const p = await openPopup({ watchList: [rust], watchListRaw: "rust" });
  const ta = p.doc.getElementById("gamesList");
  assert.strictEqual(ta.value, "Rust", "sanity: the reconciled display name");
  ta.value = "rust\nmy unsaved game";
  ta.dispatchEvent(new p.w.Event("input", { bubbles: true }));
  // background rewrites the list (a resolved name) while the user has an unsaved edit
  p.data.watchList = [{ ...rust, displayName: "Rust (Twitch)" }];
  await p.changed({ watchList: { newValue: p.data.watchList } });
  assert.strictEqual(ta.value, "rust\nmy unsaved game", "the unsaved edit is untouched: " + ta.value);

  // once saved there is nothing unsaved: the textarea follows background again
  p.doc.getElementById("save").click();
  await p.wait();
  p.data.watchList = [{ ...rust, displayName: "Rust Final" }];
  await p.changed({ watchList: { newValue: p.data.watchList } });
  assert.ok(/Rust Final|rust/i.test(ta.value));
  console.log("  OK  B6: background's list rewrites never overwrite unsaved textarea edits");
}

async function testTheStatusRowsAreNotRebuiltUnderAnOpenPicker() {
  const p = await openPopup({ watchList: [rust], watchListRaw: "rust", watchTabs: {} });
  const row = () => p.doc.querySelector("#gameStatusList .game-status-row");
  const first = row();
  assert.ok(first, "a row is shown");

  // nothing visible changed (watchTabs is written every minute): the same DOM
  p.data.watchTabs = { other: 1 };
  await p.changed({ watchTabs: { newValue: p.data.watchTabs } });
  assert.strictEqual(row(), first, "same row element: no rebuild when nothing visible changed");

  // the calendar is open; a change that is visible must wait until it is closed
  first.querySelector(".g-date-field").click();
  assert.ok(first.querySelector(".g-cal:not([hidden])"), "the picker is open");
  p.data.watchTabs = { rust: 5 };
  p.data.campaignProgress = { rust: { claimed: 1, total: 4, allComplete: false, expired: false, updatedAt: 1 } };
  await p.changed({ watchTabs: { newValue: p.data.watchTabs }, campaignProgress: { newValue: p.data.campaignProgress } });
  assert.strictEqual(row(), first, "the open picker row was not rebuilt");
  assert.ok(first.querySelector(".g-cal:not([hidden])"), "and the picker is still open");
  assert.ok(!/1\/4/.test(first.textContent), "the change is waiting");

  first.querySelector(".g-date-field").click(); // close the picker
  await p.wait();
  assert.ok(/1\/4/.test(row().textContent), "closed: the waiting change is shown: " + row().textContent);
  console.log("  OK  B6: rows are left alone when nothing visible changed; a change waits for an open picker");
}

async function testNonLatinLinesAreReportedAndAccentsFolded() {
  const ctx = vm.createContext({});
  vm.runInContext(readFile("shared.js"), ctx);
  const call = (e) => vm.runInContext(e, ctx);
  assert.strictEqual(call('toSlug("Pokémon UNITE")'), "pokemon-unite", "accents are folded");
  assert.strictEqual(call('toSlug("Pokémon UNITE")'), call('toSlug("pokemon unite")'));
  assert.strictEqual(call('normalizeGameName("Pokémon UNITE")'), "pokemonunite");
  assert.strictEqual(call('toSlug("Café Mocha")'), "cafe-mocha");
  assert.deepStrictEqual(JSON.parse(call('JSON.stringify(invalidWatchLines("原神\\nRust\\n@streamer\\n!!!"))')), ["原神", "!!!"]);

  const p = await openPopup({});
  const ta = p.doc.getElementById("gamesList");
  ta.value = "原神\nRust";
  ta.dispatchEvent(new p.w.Event("input", { bubbles: true }));
  const preview = p.doc.getElementById("gamesPreview").textContent;
  assert.ok(/⚠/.test(preview) && /原神/.test(preview), "the unusable line is named in the preview, not dropped silently: " + preview);
  assert.ok(/rust/i.test(preview), "the usable one still shows");
  const { I18N, I18N_LANGS } = require("../i18n.js");
  for (const { code } of I18N_LANGS) assert.ok(/\{lines\}/.test(I18N[code].preview_invalid || ""), `${code}.preview_invalid`);
  console.log("  OK  B7: 'Pokémon UNITE' = pokemon-unite; an unusable line is reported in the popup (9 languages)");
}

async function testTwentyFourHundredIsTheEndOfTheDay() {
  const p = await openPopup({ watchList: [rust], watchListRaw: "rust" });
  const row = p.doc.querySelector("#gameStatusList .game-status-row");
  row.querySelector(".g-date-field").click();
  const day = [...row.querySelectorAll(".g-cal-day:not(.blank)")].find((b) => b.textContent === "10");
  day.click();
  await p.wait();
  const t10 = p.data.gameWaitUntil && p.data.gameWaitUntil.rust;
  assert.ok(t10, "a date was chosen");
  assert.strictEqual(new Date(t10).getDate(), 10, "no time = the start of that day");
  const time = p.doc.querySelector("#gameStatusList .g-time");
  time.value = "24:00";
  time.dispatchEvent(new p.w.Event("change", { bubbles: true }));
  await p.wait();
  const ts = p.data.gameWaitUntil.rust;
  const d = new Date(ts);
  assert.deepStrictEqual([d.getDate(), d.getHours(), d.getMinutes()], [11, 0, 0], "24:00 on the 10th = 00:00 of the 11th (the end of the 10th): " + d.toString());
  console.log("  OK  C5: '24:00' means the end of the chosen day");
}

(async () => {
  console.log("Running review group B (popup) tests...\n");
  try {
    await testUnsavedEditsAreNeverOverwritten();
    await testTheStatusRowsAreNotRebuiltUnderAnOpenPicker();
    await testNonLatinLinesAreReportedAndAccentsFolded();
    await testTwentyFourHundredIsTheEndOfTheDay();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
