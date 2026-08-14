/**
 * popup.js - main on/off switch + status, game watch-list, auto-watch,
 * tab quota / priority, auto-off settings.
 * toSlug/parseWatchList/channelFromUrl/directoryUrl come from shared.js.
 */

const DEFAULT_AUTO_OFF_HOURS = 3;
const DEFAULT_TAB_QUOTA = 3;

function relativeTime(ts) {
  if (!ts) return null;
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} h ago`;
  return `${Math.round(diffHr / 24)} d ago`;
}

function formatDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

const $autoOff = document.getElementById("autooff");
const $autoOffHours = document.getElementById("autooffHours");
const $status = document.getElementById("status");

function renderPower(enabled) {
  $power.checked = enabled;
  $powerStatus.classList.toggle("on", enabled);
  $powerStatus.classList.toggle("off", !enabled);
  $powerStatusText.textContent = enabled ? "กำลังทำงาน" : "ปิดอยู่";
  $infoPanel.hidden = !enabled;
  $offNote.hidden = enabled;
}

async function renderInfo() {
  const cfg = await browser.storage.local.get(["lastClaimAt", "lastClaimText"]);
  const rel = relativeTime(cfg.lastClaimAt);
  $lastClaim.textContent = rel ? `${cfg.lastClaimText || "-"} (${rel})` : "ยังไม่เก็บ";

  const channels = await findWatchingChannels();
  $watchingChannel.textContent = channels.length ? channels.join(", ") : "-";
  $watchingChannelHint.hidden = channels.length <= 1;
}

function renderGamesPreview() {
  const list = parseWatchList($gamesList.value);
  $gamesPreview.textContent = list.length
    ? list.map((g, i) => `${i + 1}. ${g.input} → ${g.slug}`).join("   ")
    : "";
}

function badgeEl(text, cls) {
  const span = document.createElement("span");
  span.className = cls ? `g-badge ${cls}` : "g-badge";
  span.textContent = text;
  return span;
}

function gameRowEl(game, index, isWatching, badge, detail) {
  const row = document.createElement("div");
  row.className = isWatching ? "game-status-row current" : "game-status-row";

  const nameLine = document.createElement("div");
  nameLine.className = "g-name";
  const nameSpan = document.createElement("span");
  nameSpan.textContent = `${index + 1}. ${game.input}`;
  nameLine.appendChild(nameSpan);
  if (badge) nameLine.appendChild(badge);
  row.appendChild(nameLine);

  const detailLine = document.createElement("div");
  detailLine.className = "g-detail";
  detailLine.textContent = detail;
  row.appendChild(detailLine);

  return row;
}

async function renderGameStatus() {
  const cfg = await browser.storage.local.get([
    "watchList", "autoWatchEnabled", "watchPhase", "watchTabs",
    "invalidSlugs", "campaignProgress", "priorityMode", "emptyUntil",
  ]);
  const watchList = cfg.watchList || [];
  const invalidSlugs = cfg.invalidSlugs || [];
  const campaignProgress = cfg.campaignProgress || {};
  const watchTabs = cfg.watchTabs || {};
  const emptyUntil = cfg.emptyUntil || {};
  const priorityMode = cfg.priorityMode || "list-order";

  $allDoneBanner.hidden = cfg.watchPhase !== "all-done";
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

  watchList.forEach((game, i) => {
    const invalid = invalidSlugs.includes(game.slug);
    const progress = campaignProgress[game.slug];
    const isWatching = !!(cfg.autoWatchEnabled && watchTabs[game.slug]);
    const isCooling = (emptyUntil[game.slug] || 0) > Date.now();

    let badge = null;
    let detail = "ยังไม่มีข้อมูลความคืบหน้า";

    if (invalid) {
      badge = badgeEl("ไม่พบเกมนี้", "invalid");
      detail = `หาหมวดหมู่ "${game.slug}" บน Twitch ไม่เจอ - ตรวจชื่อเกมอีกครั้ง`;
    } else if (progress && progress.accountNotConnected) {
      badge = badgeEl("ต้องเชื่อมบัญชี", "warn");
      detail = "ไปที่หน้า inventory แล้วเชื่อมบัญชีเกมนี้ก่อน ถึงจะนับ drop ได้";
    } else if (progress && progress.allComplete) {
      badge = badgeEl("เก็บครบแล้ว", "done");
      detail = `${progress.claimed}/${progress.total} ชิ้น`;
    } else if (progress && progress.expired) {
      badge = badgeEl("หมดอายุ", "done");
    } else {
      const parts = [];
      if (progress && progress.total > 0) parts.push(`${progress.claimed}/${progress.total} ชิ้น`);
      if (progress && progress.timeRemainingMin != null) parts.push(`เหลือดูอีก ~${progress.timeRemainingMin} นาที`);
      if (priorityMode === "expiry") {
        const d = progress && formatDate(progress.expiresAt);
        parts.push(d ? `หมดอายุ ${d}` : "ไม่รู้วันหมดอายุ (ใช้ลำดับที่ใส่แทน)");
      }
      detail = parts.length ? parts.join(" · ") : "กำลังติดตามความคืบหน้า...";
    }

    if (!badge) {
      if (isWatching) badge = badgeEl("กำลังดู");
      else if (isCooling) badge = badgeEl("รอคิว (ไม่มีคนไลฟ์)", "warn");
      else if (cfg.autoWatchEnabled) badge = badgeEl("รอคิว");
    }

    $gameStatusList.appendChild(gameRowEl(game, i, isWatching, badge, detail));
  });
}

// ---- load saved values ----
(async () => {
  const cfg = await browser.storage.local.get([
    "enabled", "watchListRaw", "autoWatchEnabled", "tabQuota", "priorityMode",
    "autoOffEnabled", "autoOffHours",
  ]);

  renderPower(cfg.enabled ?? true);
  await renderInfo();

  $gamesList.value = cfg.watchListRaw || "";
  $autoWatch.checked = cfg.autoWatchEnabled ?? false;
  $tabQuota.value = cfg.tabQuota || DEFAULT_TAB_QUOTA;
  $priorityMode.value = cfg.priorityMode === "expiry" ? "expiry" : "list-order";
  $autoOff.checked = cfg.autoOffEnabled ?? false;
  $autoOffHours.value = cfg.autoOffHours || DEFAULT_AUTO_OFF_HOURS;
  renderGamesPreview();
  await renderGameStatus();
})();

$gamesList.addEventListener("input", renderGamesPreview);

// main switch - takes effect immediately, no need to press "save"
$power.addEventListener("change", async () => {
  await browser.storage.local.set({ enabled: $power.checked });
  renderPower($power.checked);
});

// the popup can stay open while things change in the background -> keep it live
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled) renderPower(changes.enabled.newValue ?? true);
  if (changes.lastClaimAt || changes.lastClaimText || changes.watchTabs) renderInfo();
  if (
    changes.watchList || changes.watchTabs || changes.autoWatchEnabled ||
    changes.watchPhase || changes.invalidSlugs || changes.campaignProgress ||
    changes.priorityMode || changes.emptyUntil
  ) {
    renderGameStatus();
  }
});

document.getElementById("save").addEventListener("click", async () => {
  const watchListRaw = $gamesList.value;
  const watchList = parseWatchList(watchListRaw);
  const hours = Math.max(1, Math.min(72, parseInt($autoOffHours.value, 10) || DEFAULT_AUTO_OFF_HOURS));
  const quota = Math.max(1, Math.min(10, parseInt($tabQuota.value, 10) || DEFAULT_TAB_QUOTA));
  $autoOffHours.value = hours;
  $tabQuota.value = quota;

  await browser.storage.local.set({
    watchListRaw,
    watchList,
    autoWatchEnabled: $autoWatch.checked,
    tabQuota: quota,
    priorityMode: $priorityMode.value === "expiry" ? "expiry" : "list-order",
    autoOffEnabled: $autoOff.checked,
    autoOffHours: hours,
  });
  await renderGameStatus();
  $status.textContent = "บันทึกแล้ว ✓";
  setTimeout(() => ($status.textContent = ""), 2000);
});
