/**
 * popup.js - main on/off switch + status, game watch-list, auto-watch,
 * tab quota / priority, auto-off settings, UI language.
 * toSlug/parseWatchList/channelFromUrl/directoryUrl come from shared.js;
 * I18N_LANGS/i18nResolveLang/i18nT/i18nLocale/applyI18n come from i18n.js.
 */

const DEFAULT_TAB_QUOTA = 3;

// current UI language - resolved from storage `uiLang` / the browser locale on
// load, updated by the language picker. Every user-facing string goes through
// t() with this.
let LANG = "en";
const t = (key, params) => i18nT(LANG, key, params);

function relativeTime(ts) {
  if (!ts) return null;
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return t("time_just_now");
  if (diffMin < 60) return t("time_min_ago", { n: diffMin });
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return t("time_hour_ago", { n: diffHr });
  return t("time_day_ago", { n: Math.round(diffHr / 24) });
}

function formatDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toLocaleDateString(i18nLocale(LANG), { month: "short", day: "numeric" });
}

// like formatDate but also shows HH:MM when the timestamp isn't local midnight
// (the per-game "watch from" picker now carries a time of day, not just a date)
function formatDateTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const opts = { month: "short", day: "numeric" };
  if (d.getHours() !== 0 || d.getMinutes() !== 0) {
    opts.hour = "2-digit";
    opts.minute = "2-digit";
  }
  return d.toLocaleString(i18nLocale(LANG), opts);
}

async function setGameWaitUntil(slug, ts) {
  const cfg = await browser.storage.local.get("gameWaitUntil");
  const gameWaitUntil = { ...(cfg.gameWaitUntil || {}) };
  if (ts) gameWaitUntil[slug] = ts;
  else delete gameWaitUntil[slug];
  await browser.storage.local.set({ gameWaitUntil });
}

// auto-watch can hold several tabs open at once now - list every twitch.tv
// channel tab currently open, not just the first one found
async function findWatchingChannels() {
  const tabs = await browser.tabs.query({ url: "*://www.twitch.tv/*" });
  const channels = [];
  for (const tab of tabs) {
    const ch = channelFromUrl(tab.url || "");
    if (ch) channels.push(ch);
  }
  return channels;
}

const $power = document.getElementById("power");
const $powerStatus = document.getElementById("powerStatus");
const $powerStatusText = document.getElementById("powerStatusText");
const $infoPanel = document.getElementById("infoPanel");
const $offNote = document.getElementById("offNote");
const $allDoneBanner = document.getElementById("allDoneBanner");
const $claimWarning = document.getElementById("claimWarning");
const $integrityWarning = document.getElementById("integrityWarning");
const $notLinkedWarnings = document.getElementById("notLinkedWarnings");
const $sleepWarning = document.getElementById("sleepWarning");
const $watchingChannel = document.getElementById("watchingChannel");
const $watchingChannelHint = document.getElementById("watchingChannelHint");
const $lastClaim = document.getElementById("lastClaim");

const $gamesList = document.getElementById("gamesList");
const $gamesPreview = document.getElementById("gamesPreview");
const $autoWatch = document.getElementById("autowatch");
const $tabQuota = document.getElementById("tabQuota");
const $priorityMode = document.getElementById("priorityMode");
const $gameStatusList = document.getElementById("gameStatusList");
const $gameStatusEmpty = document.getElementById("gameStatusEmpty");

const $reportBug = document.getElementById("reportBug");
const $reportBugStatus = document.getElementById("reportBugStatus");
const $autoOff = document.getElementById("autooff");
const $status = document.getElementById("status");
const $uiLang = document.getElementById("uiLang");

// re-render every string on the page for the current LANG: the static
// [data-i18n] markup plus everything popup.js builds itself.
function applyLanguage() {
  document.documentElement.lang = i18nLocale(LANG);
  applyI18n(document, LANG);
  renderPower($power.checked);
  renderInfo();
  renderGamesPreview();
  renderGameStatus();
}

function renderPower(enabled) {
  $power.checked = enabled;
  $powerStatus.classList.toggle("on", enabled);
  $powerStatus.classList.toggle("off", !enabled);
  $powerStatusText.textContent = enabled ? t("status_on") : t("status_off");
  $infoPanel.hidden = !enabled;
  $offNote.hidden = enabled;
  if (!enabled) {
    browser.storage.local.get(["completedAllAt", "autoOffEnabled"]).then((cfg) => {
      const justCompleted = cfg.autoOffEnabled && cfg.completedAllAt
        && Date.now() - cfg.completedAllAt < 24 * 60 * 60 * 1000;
      $offNote.textContent = justCompleted ? t("off_note_completed") : t("off_note");
    });
  }
}

async function renderInfo() {
  const cfg = await browser.storage.local.get(["lastClaimAt", "lastClaimText"]);
  const rel = relativeTime(cfg.lastClaimAt);
  $lastClaim.textContent = rel ? `${cfg.lastClaimText || "-"} (${rel})` : t("not_claimed_yet");

  const channels = await findWatchingChannels();
  $watchingChannel.textContent = channels.length ? channels.join(", ") : "-";
  $watchingChannelHint.hidden = channels.length <= 1;
}

function renderGamesPreview() {
  const list = parseWatchList($gamesList.value);
  $gamesPreview.textContent = list.length
    ? list.map((g, i) => `${i + 1}. ${g.pinnedChannel ? `@${g.channel}` : `${g.input} → ${g.slug}`}`).join("   ")
    : "";
}

function badgeEl(text, cls) {
  const span = document.createElement("span");
  span.className = cls ? `g-badge ${cls}` : "g-badge";
  span.textContent = text;
  return span;
}

function gameRowEl(game, index, isWatching, badge, detail, waitUntil, campaignNames) {
  const row = document.createElement("div");
  row.className = isWatching ? "game-status-row current" : "game-status-row";

  const nameLine = document.createElement("div");
  nameLine.className = "g-name";
  const nameSpan = document.createElement("span");
  // show Twitch's canonical name when we've resolved one and it differs
  const canonical = game.displayName && game.displayName !== game.input ? game.displayName : null;
  // a pinned channel has no canonical game name to swap in - show the
  // channel plus whatever game it's currently been observed playing, if known
  const label = canonical || (game.pinnedChannel && game.pinnedGameName
    ? `${game.input} (${game.pinnedGameName})`
    : game.input);
  nameSpan.textContent = `${index + 1}. ${label}`;
  nameLine.appendChild(nameSpan);
  if (badge) nameLine.appendChild(badge);
  row.appendChild(nameLine);

  if (canonical) {
    const alias = document.createElement("div");
    alias.className = "g-detail";
    alias.textContent = t("row_typed_as", { input: game.input });
    row.appendChild(alias);
  }

  // a pinned channel is tracked through the campaign(s) that name it: say which
  if (campaignNames && campaignNames.length) {
    const camp = document.createElement("div");
    camp.className = "g-detail";
    camp.textContent = t("row_campaign", { name: campaignNames.join(", ") });
    row.appendChild(camp);
  }

  const detailLine = document.createElement("div");
  detailLine.className = "g-detail";
  detailLine.textContent = detail;
  row.appendChild(detailLine);

  // manual "don't start auto-watch before this date/time" - useful for a game
  // whose next drop campaign is announced but not open yet (Twitch's dashboard
  // only lists campaigns that have already started, but the drop's release
  // time is usually known), or just to delay a game you don't want farmed yet.
  row.appendChild(waitControlEl(game, waitUntil));

  return row;
}

// The "watch from" picker: a month-grid calendar the user clicks a day in
// (date shown as DD/MM/YYYY), plus a free-text HH:MM field they type into.
// Both are ordinary popup DOM. The old build used <input type="date"> and a
// row of <select>s; Firefox opens the native date panel *behind* the
// browserAction popup, and the 24x12 time selects were too long to scroll -
// so the calendar here is drawn inline in the row (it can never render
// "behind" anything) and the time is typed, not picked.
function waitControlEl(game, waitUntil) {
  const box = document.createElement("div");
  box.className = "g-wait-box";

  const wrap = document.createElement("div");
  wrap.className = "g-wait";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", t("row_wait_aria"));

  const label = document.createElement("span");
  label.textContent = t("row_start_from");
  wrap.appendChild(label);

  const pad = (n) => String(n).padStart(2, "0");
  const locale = i18nLocale(LANG);
  const initial = waitUntil ? new Date(waitUntil) : null;
  const hasInitial = !!initial && !Number.isNaN(initial.getTime());

  // the day the user has selected (null until they pick one), and the month
  // the grid is currently showing
  let sel = hasInitial
    ? { y: initial.getFullYear(), m: initial.getMonth(), d: initial.getDate() }
    : null;
  const viewFrom = hasInitial ? initial : new Date();
  let viewY = viewFrom.getFullYear();
  let viewM = viewFrom.getMonth();

  // --- date field: click to toggle the calendar ---
  const dateField = document.createElement("button");
  dateField.type = "button";
  dateField.className = "g-date-field";
  dateField.setAttribute("aria-label", t("wait_date_aria"));
  const paintDateField = () => {
    dateField.textContent = sel
      ? `${pad(sel.d)}/${pad(sel.m + 1)}/${sel.y}`
      : t("wait_pick_date");
    dateField.classList.toggle("set", !!sel);
  };
  paintDateField();

  const atSep = document.createElement("span");
  atSep.className = "g-wait-sep";
  atSep.textContent = t("wait_at");

  // --- time field: free text, typed not picked ---
  const timeField = document.createElement("input");
  timeField.type = "text";
  timeField.className = "g-time";
  timeField.maxLength = 8;
  timeField.placeholder = t("wait_time_ph");
  timeField.setAttribute("aria-label", t("wait_time_aria"));
  if (hasInitial && (initial.getHours() || initial.getMinutes())) {
    timeField.value = `${pad(initial.getHours())}:${pad(initial.getMinutes())}`;
  }

  // Forgiving about how the time is typed, so neither a 24-hour nor a
  // 12-hour habit is wrong. Case-insensitive, optional space before am/pm:
  //   "14:30" "1430" "14" "24:00"     -> 24-hour (24:00 == 00:00)
  //   "2:30pm" "2.30 pm" "2pm" "12am" -> 12-hour (12am -> 00:00, 12pm -> 12:00)
  // -> {h, mi} | "empty" | null (unparseable)
  const parseTime = () => {
    let raw = timeField.value.trim().toLowerCase();
    if (!raw) return "empty";
    let mer = null;
    const ap = raw.match(/([ap])\.?\s?m\.?$/);
    if (ap) { mer = ap[1]; raw = raw.slice(0, ap.index).trim(); }
    const m = raw.match(/^(\d{1,2})(?:[:.h\s]?(\d{2}))?$/);
    if (!m) return null;
    let h = Number(m[1]);
    const mi = m[2] != null ? Number(m[2]) : 0;
    if (mi > 59) return null;
    if (mer) {
      if (h < 1 || h > 12) return null;
      h = mer === "a" ? (h === 12 ? 0 : h) : (h === 12 ? 12 : h + 12);
    } else if (h === 24 && mi === 0) {
      h = 0;
    } else if (h > 23) {
      return null;
    }
    return { h, mi };
  };

  const commit = async () => {
    if (!sel) {
      // no date chosen -> no gate; drop any stored one
      if (waitUntil) await setGameWaitUntil(game.slug, null);
      return;
    }
    const time = parseTime();
    timeField.classList.toggle("invalid", time === null);
    if (time === null) return; // keep the stored gate until they fix the time
    const { h, mi } = time === "empty" ? { h: 0, mi: 0 } : time;
    // echo back the parsed time in one canonical 24-hour form, so whatever
    // shorthand was typed ("2pm", "1430") the user sees exactly what stuck
    if (time !== "empty") timeField.value = `${pad(h)}:${pad(mi)}`;
    // clamp the day to the chosen month (e.g. 31 -> 30 / 28) instead of the
    // Date constructor silently rolling over into the next month
    const maxDay = new Date(sel.y, sel.m + 1, 0).getDate();
    const day = Math.min(sel.d, maxDay);
    const ts = new Date(sel.y, sel.m, day, h, mi, 0, 0).getTime();
    if (!Number.isNaN(ts)) await setGameWaitUntil(game.slug, ts);
  };
  timeField.addEventListener("change", commit);
  timeField.addEventListener("blur", commit);

  // --- calendar, drawn inline below the row ---
  const cal = document.createElement("div");
  cal.className = "g-cal";
  cal.hidden = true;

  const wdFmt = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
  const monthFmt = new Intl.DateTimeFormat(locale, { month: "long" });

  const renderCal = () => {
    cal.replaceChildren();

    const head = document.createElement("div");
    head.className = "g-cal-head";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "g-cal-nav";
    prev.textContent = "‹";
    prev.setAttribute("aria-label", t("wait_cal_prev"));
    prev.addEventListener("click", () => {
      if (--viewM < 0) { viewM = 11; viewY--; }
      renderCal();
    });
    const title = document.createElement("span");
    // year shown as a plain Gregorian number so it matches the DD/MM/YYYY field
    title.textContent = `${monthFmt.format(new Date(viewY, viewM, 1))} ${viewY}`;
    const next = document.createElement("button");
    next.type = "button";
    next.className = "g-cal-nav";
    next.textContent = "›";
    next.setAttribute("aria-label", t("wait_cal_next"));
    next.addEventListener("click", () => {
      if (++viewM > 11) { viewM = 0; viewY++; }
      renderCal();
    });
    head.append(prev, title, next);
    cal.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "g-cal-grid";

    // weekday header, week starting Sunday (2023-01-01 was a Sunday)
    for (let i = 0; i < 7; i++) {
      const wd = document.createElement("div");
      wd.className = "g-cal-wd";
      wd.textContent = wdFmt.format(new Date(2023, 0, 1 + i));
      grid.appendChild(wd);
    }

    const firstDow = new Date(viewY, viewM, 1).getDay(); // 0 = Sunday
    const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    const now = new Date();

    for (let i = 0; i < firstDow; i++) {
      const blank = document.createElement("span");
      blank.className = "g-cal-day blank";
      grid.appendChild(blank);
    }
    for (let dn = 1; dn <= daysInMonth; dn++) {
      const day = document.createElement("button");
      day.type = "button";
      day.className = "g-cal-day";
      day.textContent = String(dn);
      if (now.getFullYear() === viewY && now.getMonth() === viewM && now.getDate() === dn) {
        day.classList.add("today");
      }
      if (sel && sel.y === viewY && sel.m === viewM && sel.d === dn) {
        day.classList.add("selected");
      }
      day.addEventListener("click", async () => {
        sel = { y: viewY, m: viewM, d: dn };
        paintDateField();
        renderCal();
        cal.hidden = true;
        await commit();
      });
      grid.appendChild(day);
    }
    cal.appendChild(grid);
  };

  dateField.addEventListener("click", () => {
    if (cal.hidden) renderCal();
    cal.hidden = !cal.hidden;
  });

  wrap.append(dateField, atSep, timeField);

  if (waitUntil) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "g-wait-clear";
    clearBtn.textContent = t("row_clear");
    clearBtn.addEventListener("click", async () => {
      await setGameWaitUntil(game.slug, null);
    });
    wrap.appendChild(clearBtn);
  }

  box.append(wrap, cal);
  return box;
}

async function renderGameStatus() {
  const cfg = await browser.storage.local.get([
    "watchList", "autoWatchEnabled", "watchPhase", "watchTabs",
    "invalidSlugs", "campaignProgress", "priorityMode", "emptyUntil",
    "openCampaigns", "gameWaitUntil", "claimHealth", "claimNotLinked",
  ]);
  const watchList = cfg.watchList || [];
  const openCampaigns = cfg.openCampaigns || null;
  const gameWaitUntil = cfg.gameWaitUntil || {};
  // slug -> retry-after timestamp (see background.js's INVALID_SLUG_RETRY_MS) -
  // tolerate old array-shaped data from before that change
  const invalidSlugs = cfg.invalidSlugs && !Array.isArray(cfg.invalidSlugs) ? cfg.invalidSlugs : {};
  const campaignProgress = cfg.campaignProgress || {};
  const watchTabs = cfg.watchTabs || {};
  const emptyUntil = cfg.emptyUntil || {};
  const priorityMode = cfg.priorityMode || "list-order";

  $allDoneBanner.hidden = cfg.watchPhase !== "all-done";
  // every recent claim was rejected by Twitch (content.js's verifyClaim): tell
  // the user to claim by hand / check the session instead of leaving them to
  // wonder why nothing is ever claimed
  // Twitch refusing Drops for the whole session (background.js's integrityFlag,
  // kept in storage.session): says so plainly and hides the vaguer streak warning
  let integrityFlag = null;
  try { integrityFlag = (await browser.storage.session.get("integrityFlag")).integrityFlag || null; } catch { /* no session storage */ }
  $integrityWarning.hidden = !integrityFlag;
  if (integrityFlag) $integrityWarning.textContent = t("integrity_warning");
  const claimStreak = (cfg.claimHealth && cfg.claimHealth.streak) || 0;
  $claimWarning.hidden = !!integrityFlag || claimStreak < CLAIM_WARN_STREAK;
  if (!$claimWarning.hidden) $claimWarning.textContent = t("claim_fail_warning", { n: claimStreak });
  // a claim refused because the game account is not connected: one line per game/reward
  $notLinkedWarnings.replaceChildren();
  for (const e of Array.isArray(cfg.claimNotLinked) ? cfg.claimNotLinked : []) {
    const box = document.createElement("div");
    box.className = "claim-warning";
    box.append(t("claim_not_linked_warning", { game: e.game || e.key }));
    const link = document.createElement("button");
    link.type = "button";
    link.className = "link";
    link.textContent = t("claim_open_campaigns");
    link.addEventListener("click", () => browser.tabs.create({ url: "https://www.twitch.tv/drops/campaigns" }));
    box.append(link);
    $notLinkedWarnings.append(box);
  }
  // Firefox has no way for an extension to keep the machine awake (no
  // browser.power API, and Screen Wake Lock API rejects on a background tab
  // - verified live, not assumed) - the only real mitigation is the OS
  // sleep setting, so surface that whenever there's actually a watch tab
  // open to lose.
  $sleepWarning.hidden = !(cfg.autoWatchEnabled && Object.keys(watchTabs).length > 0);

  $gameStatusList.replaceChildren();
  if (watchList.length === 0) {
    $gameStatusEmpty.hidden = false;
    return;
  }
  $gameStatusEmpty.hidden = true;

  const ocFresh = openCampaigns && openCampaigns.fetchedAt
    && Date.now() - openCampaigns.fetchedAt < 6 * 60 * 60 * 1000;

  watchList.forEach((game, i) => {
    const invalid = (invalidSlugs[game.slug] || 0) > Date.now();
    const progress = campaignProgress[game.slug];
    const isWatching = !!(cfg.autoWatchEnabled && watchTabs[game.slug]);
    const isCooling = (emptyUntil[game.slug] || 0) > Date.now();
    const waitUntil = gameWaitUntil[game.slug] || null;
    const isWaiting = waitUntil && waitUntil > Date.now();
    // campaign annotation written by background.js's annotateWatchListFromCampaigns
    const campaign = game.campaign || null;
    const ocEntry = openCampaigns && openCampaigns.bySlug && openCampaigns.bySlug[game.slug];
    const hasOpenCampaign = !!(campaign && campaign.open) || !!(ocEntry && ocEntry.active);
    // a pinned channel is trusted by virtue of being pinned - never flagged
    // "no open drop" just because the /drops/campaigns snapshot doesn't (yet)
    // know what game it's playing, see lacksOpenCampaign in background.js
    const noOpenCampaign = !game.pinnedChannel && ocFresh && !hasOpenCampaign;

    let badge = null;
    let detail = t("detail_no_progress");

    if (isWaiting) {
      badge = badgeEl(t("badge_waiting_until", { date: formatDateTime(waitUntil) }), "warn");
      detail = t("detail_waiting_until", { date: formatDateTime(waitUntil) });
    } else if (noOpenCampaign) {
      badge = badgeEl(t("badge_no_open_drop"), "warn");
      const endTxt = (campaign && campaign.endAt) || (ocEntry && ocEntry.endAt);
      detail = endTxt
        ? t("detail_no_open_drop_end", { date: formatDate(endTxt) })
        : t("detail_no_open_drop");
    } else if (invalid) {
      badge = badgeEl(t("badge_not_found"), "invalid");
      const retryMin = Math.max(0, Math.round(((invalidSlugs[game.slug] || 0) - Date.now()) / 60000));
      detail = t("detail_not_found", { slug: game.slug, min: retryMin });
    } else if (progress && progress.accountNotConnected) {
      badge = badgeEl(t("badge_need_link"), "warn");
      detail = t("detail_need_link");
    } else if (progress && progress.allComplete) {
      badge = badgeEl(t("badge_all_claimed"), "done");
      detail = t("detail_pieces", { claimed: progress.claimed, total: progress.total });
    } else if (progress && progress.expired) {
      badge = badgeEl(t("badge_expired"), "done");
    } else {
      const parts = [];
      if (progress && progress.total > 0) {
        parts.push(t("detail_pieces", { claimed: progress.claimed, total: progress.total }));
      }
      if (progress && progress.timeRemainingMin != null) {
        parts.push(t("detail_time_remaining", { n: progress.timeRemainingMin }));
      }
      const campEnd = (campaign && campaign.endAt) || (ocEntry && ocEntry.endAt) ||
        (progress && typeof progress.expiresAt === "number" ? progress.expiresAt : null);
      if (hasOpenCampaign && campEnd) parts.push(t("detail_drop_open_until", { date: formatDate(campEnd) }));
      if (priorityMode === "expiry" && !campEnd) {
        parts.push(t("detail_no_expiry_known"));
      }
      // a pinned channel without a matching inventory card yet (a card only
      // appears once minutes start accruing): unknown - not "nothing to do",
      // and still being watched
      detail = parts.length ? parts.join(" · ")
        : (game.pinnedChannel ? t("detail_pinned_unknown") : t("detail_tracking"));

      // ViewerDropsDashboard's self.isAccountConnected can be stale - if the
      // /drops/inventory page is actually showing an in-progress drop card
      // for this game (progress.total > 0), the account IS linked, so don't
      // contradict that with a "connect your account" warning
      const inventoryConfirmsLinked = progress && progress.total > 0;
      if (campaign && campaign.open && campaign.accountConnected === false && !inventoryConfirmsLinked) {
        badge = badgeEl(t("badge_account_not_linked"), "warn");
        detail += t("detail_account_not_linked_suffix");
      } else if (hasOpenCampaign && !isWatching) {
        badge = badgeEl(t("badge_drop_open"), "open");
      }
    }

    // a pinned channel matched to a campaign but streaming another game earns
    // nothing - not "watching" (and its tab holds no quota slot, see autoWatchTick)
    if (cfg.autoWatchEnabled && !isWaiting && !invalid && entryPlaysWrongGame(game, progress)) {
      badge = badgeEl(t("badge_other_game"), "warn");
    }

    if (!badge) {
      if (isWatching) badge = badgeEl(t("badge_watching"));
      else if (isCooling) badge = badgeEl(t("badge_queued_no_live"), "warn");
      else if (cfg.autoWatchEnabled) badge = badgeEl(t("badge_queued"));
    }

    $gameStatusList.appendChild(gameRowEl(game, i, isWatching, badge, detail, waitUntil,
      game.pinnedChannel && progress ? progress.campaignNames : null));
  });
}

// populate the language picker once (each option labelled in its own script)
for (const { code, label } of I18N_LANGS) {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = label;
  $uiLang.appendChild(opt);
}

// ---- load saved values ----
(async () => {
  const cfg = await browser.storage.local.get([
    "enabled", "watchListRaw", "autoWatchEnabled", "tabQuota", "priorityMode",
    "autoOffEnabled", "uiLang",
  ]);

  LANG = i18nResolveLang(cfg.uiLang, navigator.language);
  $uiLang.value = LANG;
  document.documentElement.lang = i18nLocale(LANG);
  applyI18n(document, LANG);

  renderPower(cfg.enabled ?? true);
  await renderInfo();

  $gamesList.value = cfg.watchListRaw || "";
  $autoWatch.checked = cfg.autoWatchEnabled ?? false;
  $tabQuota.value = cfg.tabQuota || DEFAULT_TAB_QUOTA;
  $priorityMode.value = cfg.priorityMode === "expiry" ? "expiry" : "list-order";
  $autoOff.checked = cfg.autoOffEnabled ?? false;
  renderGamesPreview();
  await renderGameStatus();
  // if the background has since resolved canonical Twitch names for the
  // typed games, show those in the textarea (no storage.onChanged fires on a
  // fresh popup open, so do it once here too)
  await reconcileGamesTextarea();
})();

$gamesList.addEventListener("input", renderGamesPreview);

// language picker - persist and re-render immediately (no "save" needed)
$uiLang.addEventListener("change", async () => {
  LANG = i18nResolveLang($uiLang.value, navigator.language);
  await browser.storage.local.set({ uiLang: LANG });
  applyLanguage();
});

// main switch - takes effect immediately, no need to press "save"
$power.addEventListener("change", async () => {
  await browser.storage.local.set({ enabled: $power.checked });
  renderPower($power.checked);
});

// rebuild the games textarea from the background-resolved canonical names,
// so a typo like "msf" becomes "MARVEL Strike Force" once matched. Only when
// the user isn't mid-edit, and only if it actually differs.
async function reconcileGamesTextarea() {
  if (document.activeElement === $gamesList) return;
  const cfg = await browser.storage.local.get(["watchList", "watchListRaw"]);
  const list = cfg.watchList || [];
  if (list.length === 0) return;
  const rebuilt = list.map((g) => g.displayName || g.input).join("\n");
  if (rebuilt !== (cfg.watchListRaw || "") || rebuilt !== $gamesList.value) {
    $gamesList.value = rebuilt;
    renderGamesPreview();
    await browser.storage.local.set({ watchListRaw: rebuilt });
  }
}

// the popup can stay open while things change in the background -> keep it live
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "session") {
    if (changes.integrityFlag) renderGameStatus();
    return;
  }
  if (area !== "local") return;
  if (changes.uiLang && changes.uiLang.newValue && changes.uiLang.newValue !== LANG) {
    LANG = i18nResolveLang(changes.uiLang.newValue, navigator.language);
    $uiLang.value = LANG;
    applyLanguage();
    return;
  }
  if (changes.enabled) renderPower(changes.enabled.newValue ?? true);
  if (changes.lastClaimAt || changes.lastClaimText || changes.watchTabs) renderInfo();
  if (
    changes.watchList || changes.watchTabs || changes.autoWatchEnabled ||
    changes.watchPhase || changes.invalidSlugs || changes.campaignProgress ||
    changes.priorityMode || changes.emptyUntil ||
    changes.openCampaigns || changes.gameWaitUntil || changes.claimHealth || changes.claimNotLinked
  ) {
    renderGameStatus();
  }
  if (changes.watchList) reconcileGamesTextarea();
});

// sends background.js's in-memory log ring buffer to a small relay (see
// REPORT_BUG_URL in background.js) that creates a GitHub issue from it -
// one click, no file to attach, no GitHub token anywhere in this
// extension's own source. The buffer is still also written to a local file
// automatically after a channel is dropped (see maybeAutoExportDebugLog in
// background.js) - this button is just the on-demand path, not the only
// place the log data goes.
$reportBug.addEventListener("click", async () => {
  $reportBug.disabled = true;
  $reportBugStatus.textContent = t("report_bug_working");
  try {
    const res = await browser.runtime.sendMessage({ type: "reportBug" });
    $reportBugStatus.textContent = res && res.ok
      // a big log goes out as several issues (one per part) - show the first
      // one's URL plus how many more there are
      ? t("report_bug_done", { url: (res.url || "?") + (res.parts > 1 ? ` (+${res.parts - 1})` : "") })
      : t("report_bug_failed", { err: (res && res.error) || "?" });
  } catch (e) {
    $reportBugStatus.textContent = t("report_bug_failed", { err: e });
  } finally {
    $reportBug.disabled = false;
  }
});

document.getElementById("save").addEventListener("click", async () => {
  const watchListRaw = $gamesList.value;
  const watchList = parseWatchList(watchListRaw);
  // parseWatchList starts every pinned channel from scratch; the game it was
  // seen playing is learned from its page (and only re-reported when it
  // changes), so carry it over for channels that stay on the list
  const prevList = (await browser.storage.local.get("watchList")).watchList || [];
  for (const g of watchList) {
    const prev = g.pinnedChannel && prevList.find((p) => p.slug === g.slug);
    if (prev) {
      if (prev.gameSlug) g.gameSlug = prev.gameSlug;
      if (prev.pinnedGameName) g.pinnedGameName = prev.pinnedGameName;
    }
  }
  const quota = Math.max(1, Math.min(10, parseInt($tabQuota.value, 10) || DEFAULT_TAB_QUOTA));
  $tabQuota.value = quota;

  await browser.storage.local.set({
    watchListRaw,
    watchList,
    autoWatchEnabled: $autoWatch.checked,
    tabQuota: quota,
    priorityMode: $priorityMode.value === "expiry" ? "expiry" : "list-order",
    autoOffEnabled: $autoOff.checked,
  });
  await renderGameStatus();
  $status.textContent = t("saved");
  setTimeout(() => ($status.textContent = ""), 2000);
});
