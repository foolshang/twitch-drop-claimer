/**
 * i18n.test.js
 *
 * Covers the popup UI translation layer added in 0.6.2:
 *
 *   - i18n.js loads as a plain CommonJS module (it's also a plain browser
 *     global script - the module.exports tail is test-only)
 *   - every language in I18N has exactly the same key set as `en`, with no
 *     empty strings and matching {placeholder} tokens (a missing or renamed
 *     placeholder would interpolate wrong at runtime)
 *   - i18nResolveLang() maps a stored choice / a browser locale / an unknown
 *     locale the way the picker and the fallback rely on
 *   - i18nT() interpolates {name} params and falls back en -> raw key
 *   - every data-i18n / data-i18n-placeholder key used in popup.html exists
 *     in `en`
 *   - every i18nT(lang, "literal") / t("literal") key referenced in popup.js
 *     and background.js exists in `en`
 *
 * No browser, no DOM - pure string-table checks against the real files.
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const { I18N_LANGS, I18N, i18nResolveLang, i18nT, i18nLocale } = require("../i18n.js");

const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();

function testKeyParity() {
  const enKeys = Object.keys(I18N.en).sort();
  assert.ok(enKeys.length > 40, "en table looks too small - did it load?");

  for (const { code } of I18N_LANGS) {
    assert.ok(I18N[code], `I18N is missing the "${code}" table listed in I18N_LANGS`);
    const keys = Object.keys(I18N[code]).sort();
    assert.deepStrictEqual(
      keys, enKeys,
      `"${code}" key set differs from "en" (missing: ${enKeys.filter((k) => !keys.includes(k))}; extra: ${keys.filter((k) => !enKeys.includes(k))})`
    );
    for (const k of keys) {
      const v = I18N[code][k];
      assert.ok(typeof v === "string" && v.trim() !== "", `"${code}".${k} is empty`);
      assert.deepStrictEqual(
        placeholders(v), placeholders(I18N.en[k]),
        `"${code}".${k} has different {placeholders} than "en" ("${v}" vs "${I18N.en[k]}")`
      );
    }
  }
  // every I18N table must be declared in the picker list, or it's unreachable
  for (const code of Object.keys(I18N)) {
    assert.ok(I18N_LANGS.some((l) => l.code === code), `I18N has "${code}" but I18N_LANGS doesn't list it`);
  }
  console.log(`  OK  key parity: ${I18N_LANGS.length} languages, ${enKeys.length} keys each, placeholders aligned`);
}

function testResolveLang() {
  // stored valid choice always wins
  assert.strictEqual(i18nResolveLang("ja", "en-US"), "ja");
  // stored garbage is ignored, falls through to the browser locale
  assert.strictEqual(i18nResolveLang("xx", "fr-FR"), "fr");
  // browser locale mapping
  assert.strictEqual(i18nResolveLang(null, "th"), "th");
  assert.strictEqual(i18nResolveLang(null, "th-TH"), "th");
  assert.strictEqual(i18nResolveLang(undefined, "ko-KR"), "ko");
  assert.strictEqual(i18nResolveLang(null, "ru"), "ru");
  assert.strictEqual(i18nResolveLang(null, "pt-BR"), "pt");
  assert.strictEqual(i18nResolveLang(null, "fr-CA"), "fr");
  // Chinese: Traditional/Taiwan/HK/Macao -> zh-TW, everything else zh -> zh-CN
  assert.strictEqual(i18nResolveLang(null, "zh-CN"), "zh-CN");
  assert.strictEqual(i18nResolveLang(null, "zh"), "zh-CN");
  assert.strictEqual(i18nResolveLang(null, "zh-Hans"), "zh-CN");
  assert.strictEqual(i18nResolveLang(null, "zh-TW"), "zh-TW");
  assert.strictEqual(i18nResolveLang(null, "zh-HK"), "zh-TW");
  assert.strictEqual(i18nResolveLang(null, "zh-Hant"), "zh-TW");
  // anything unknown -> English
  assert.strictEqual(i18nResolveLang(null, "de-DE"), "en");
  assert.strictEqual(i18nResolveLang(null, ""), "en");
  assert.strictEqual(i18nResolveLang(null, undefined), "en");
  // every resolvable code has a locale tag
  for (const { code } of I18N_LANGS) {
    assert.ok(i18nLocale(code), `no locale tag for "${code}"`);
  }
  console.log("  OK  i18nResolveLang: stored choice > browser locale > English fallback");
}

function testTranslateAndInterpolate() {
  assert.strictEqual(i18nT("en", "detail_pieces", { claimed: 2, total: 3 }), "2/3 items");
  assert.strictEqual(i18nT("th", "time_min_ago", { n: 5 }), "5 นาทีที่แล้ว");
  // missing param leaves the token untouched rather than printing "undefined"
  assert.strictEqual(i18nT("en", "detail_pieces", { claimed: 2 }), "2/{total} items");
  // unknown key in a known language -> en value
  const onlyEn = "__only_in_en__";
  I18N.en[onlyEn] = "hello {who}";
  try {
    assert.strictEqual(i18nT("ja", onlyEn, { who: "world" }), "hello world");
  } finally {
    delete I18N.en[onlyEn];
  }
  // unknown key everywhere -> raw key, never a crash
  assert.strictEqual(i18nT("en", "totally_unknown_key"), "totally_unknown_key");
  console.log("  OK  i18nT: {param} interpolation, en fallback, raw-key last resort");
}

function collectKeys(src) {
  // t("key"...) and i18nT(lang, "key"...) call sites, single or double quoted
  const keys = new Set();
  const re = /\b(?:i18nT\([^,]+,\s*|t\()\s*(["'])([a-z0-9_]+)\1/g;
  let m;
  while ((m = re.exec(src))) keys.add(m[2]);
  return keys;
}

function testPopupHtmlKeysExist() {
  const html = read("popup.html");
  const re = /data-i18n(?:-placeholder)?="([a-z0-9_]+)"/g;
  let m;
  let count = 0;
  while ((m = re.exec(html))) {
    count++;
    assert.ok(I18N.en[m[1]], `popup.html references data-i18n "${m[1]}" with no "en" entry`);
  }
  assert.ok(count > 15, `only ${count} data-i18n attributes found in popup.html - selector stale?`);
  console.log(`  OK  popup.html: all ${count} data-i18n keys exist in "en"`);
}

function testScriptKeysExist() {
  for (const file of ["popup.js", "background.js"]) {
    const keys = collectKeys(read(file));
    assert.ok(keys.size > 0, `no t()/i18nT() key literals found in ${file} - regex stale?`);
    for (const k of keys) {
      assert.ok(I18N.en[k], `${file} calls for key "${k}" with no "en" entry`);
    }
    console.log(`  OK  ${file}: all ${keys.size} referenced keys exist in "en"`);
  }
}

(async () => {
  console.log("Running i18n tests (no browser, no DOM)...\n");
  try {
    testKeyParity();
    testResolveLang();
    testTranslateAndInterpolate();
    testPopupHtmlKeysExist();
    testScriptKeysExist();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
