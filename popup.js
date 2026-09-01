/**
 * popup.js - main on/off switch + status, game watch-list, auto-watch,
 * tab quota / priority, auto-off settings.
 * toSlug/parseWatchList/channelFromUrl/directoryUrl come from shared.js.
 */

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

// <input type="date"> <-> epoch-ms (local midnight) conversions
function tsToDateInput(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dateInputToTs(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
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
const $sleepWarning = document.getElementById("sleepWarning");
const $watchingChannel = document.getElementById("watchingChannel");
const $watchingChannelHint = document.getElementById("watchingChannelHint");
const $lastClaim = document.getElementById("lastClaim");

const $gamesList = document.getElementById("gamesList");
const $gamesPreview = document.getElementById("gamesPreview");
const $campaignsCheck = document.getElementById("campaignsCheck");
const $campaignsCheckStatus = document.getElementById("campaignsCheckStatus");
const $autoWatch = document.getElementById("autowatch");
const $tabQuota = document.getElementById("tabQuota");
const $priorityMode = document.getElementById("priorityMode");
const $gameStatusList = document.getElementById("gameStatusList");
const $gameStatusEmpty = document.getElementById("gameStatusEmpty");

const $autoOff = document.getElementById("autooff");
const $status = document.getElementById("status");

function renderPower(enabled) {
  $power.checked = enabled;
  $powerStatus.classList.toggle("on", enabled);
  $powerStatus.classList.toggle("off", !enabled);
  $powerStatusText.textContent = enabled ? "กำลังทำงาน" : "ปิดอยู่";
  $infoPanel.hidden = !enabled;
  $offNote.hidden = enabled;
  if (!enabled) {
    browser.storage.local.get(["completedAllAt", "autoOffEnabled"]).then((cfg) => {
      const justCompleted = cfg.autoOffEnabled && cfg.completedAllAt
        && Date.now() - cfg.completedAllAt < 24 * 60 * 60 * 1000;
      $offNote.textContent = justCompleted
        ? "🎉 เก็บ drop ครบทุกเกมแล้ว - ปิดสวิตช์ให้อัตโนมัติ เปิดใหม่ได้เมื่อมีเกม/แคมเปญใหม่"
        : "ปิดอยู่ - ไม่มีการสแกน/เก็บ drop ใดๆ";
    });
  }
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

function gameRowEl(game, index, isWatching, badge, detail, waitUntil) {
  const row = document.createElement("div");
  row.className = isWatching ? "game-status-row current" : "game-status-row";

  const nameLine = document.createElement("div");
  nameLine.className = "g-name";
  const nameSpan = document.createElement("span");
  // show Twitch's canonical name when we've resolved one and it differs
  const canonical = game.displayName && game.displayName !== game.input ? game.displayName : null;
  nameSpan.textContent = canonical
    ? `${index + 1}. ${canonical}`
    : `${index + 1}. ${game.input}`;
  nameLine.appendChild(nameSpan);
  if (badge) nameLine.appendChild(badge);
  row.appendChild(nameLine);

  if (canonical) {
    const alias = document.createElement("div");
    alias.className = "g-detail";
    alias.textContent = `พิมพ์ไว้: "${game.input}"`;
    row.appendChild(alias);
  }

  const detailLine = document.createElement("div");
  detailLine.className = "g-detail";
  detailLine.textContent = detail;
  row.appendChild(detailLine);

  // manual "don't start auto-watch before this date" - useful for a game
  // whose next drop campaign is announced but not open yet (Twitch's
  // dashboard only lists campaigns that have already started), or just to
  // delay a game you don't want farmed yet. Always available; the list is
  // tall enough (300px) that a few rows don't need scrolling and Firefox's
  // native date popup isn't clipped by the container.
  {
    const waitLine = document.createElement("div");
    waitLine.className = "g-wait";
    const waitLabel = document.createElement("span");
    waitLabel.textContent = "เริ่มดูตั้งแต่:";
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = tsToDateInput(waitUntil);
    dateInput.addEventListener("change", async () => {
      await setGameWaitUntil(game.slug, dateInputToTs(dateInput.value));
    });
    waitLine.appendChild(waitLabel);
    waitLine.appendChild(dateInput);
    if (waitUntil) {
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "g-wait-clear";
      clearBtn.textContent = "ล้าง";
      clearBtn.addEventListener("click", async () => {
        await setGameWaitUntil(game.slug, null);
      });
      waitLine.appendChild(clearBtn);
    }
    row.appendChild(waitLine);
  }

  return row;
}

async function renderGameStatus() {
  const cfg = await browser.storage.local.get([
    "watchList", "autoWatchEnabled", "watchPhase", "watchTabs",
    "invalidSlugs", "campaignProgress", "priorityMode", "emptyUntil",
    "openCampaigns", "gameWaitUntil",
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
    const noOpenCampaign = ocFresh && !hasOpenCampaign;

    let badge = null;
    let detail = "ยังไม่มีข้อมูลความคืบหน้า";

    if (isWaiting) {
      badge = badgeEl(`รอถึง ${formatDate(waitUntil)}`, "warn");
      detail = `ตั้งไว้ให้เริ่ม auto-watch เกมนี้วันที่ ${formatDate(waitUntil)}`;
    } else if (noOpenCampaign) {
      badge = badgeEl("ไม่มีดรอปเปิดตอนนี้", "warn");
      const endTxt = (campaign && campaign.endAt) || (ocEntry && ocEntry.endAt);
      detail = endTxt
        ? `Twitch ไม่มี drop campaign เปิดให้เกมนี้ (แคมเปญล่าสุดหมด ${formatDate(endTxt)}) - auto-watch ข้ามไว้ก่อน ตั้งวันเริ่มเองได้ด้านล่าง`
        : "Twitch ไม่มี drop campaign เปิดให้เกมนี้ตอนนี้ - auto-watch ข้ามไว้ก่อน ตั้งวันเริ่มเองได้ด้านล่าง";
    } else if (invalid) {
      badge = badgeEl("ไม่พบเกมนี้ (ชั่วคราว)", "invalid");
      const retryMin = Math.max(0, Math.round(((invalidSlugs[game.slug] || 0) - Date.now()) / 60000));
      detail = `หน้าหมวดหมู่ "${game.slug}" เพิ่งเด้งไปที่อื่น - จะลองใหม่อัตโนมัติใน ~${retryMin} นาที (ถ้าเจอบ่อยทั้งที่ชื่อเกมถูกอยู่แล้ว น่าจะเป็น bug ตอนตรวจ ไม่ใช่ชื่อผิดจริง แจ้งได้)`;
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
      const campEnd = (campaign && campaign.endAt) || (ocEntry && ocEntry.endAt) ||
        (progress && typeof progress.expiresAt === "number" ? progress.expiresAt : null);
      if (hasOpenCampaign && campEnd) parts.push(`ดรอปเปิดถึง ${formatDate(campEnd)}`);
      if (priorityMode === "expiry" && !campEnd) {
        parts.push("ไม่รู้วันหมดอายุ (ใช้ลำดับที่ใส่แทน)");
      }
      detail = parts.length ? parts.join(" · ") : "กำลังติดตามความคืบหน้า...";

      // ViewerDropsDashboard's self.isAccountConnected can be stale - if the
      // /drops/inventory page is actually showing an in-progress drop card
      // for this game (progress.total > 0), the account IS linked, so don't
      // contradict that with a "connect your account" warning
      const inventoryConfirmsLinked = progress && progress.total > 0;
      if (campaign && campaign.open && campaign.accountConnected === false && !inventoryConfirmsLinked) {
        badge = badgeEl("ยังไม่เชื่อมบัญชีเกม", "warn");
        detail += " · ต้องเชื่อมบัญชีเกมนี้กับ Twitch ก่อน ถึงจะนับ drop ได้";
      } else if (hasOpenCampaign && !isWatching) {
        badge = badgeEl("ดรอปเปิดอยู่", "open");
      }
    }

    if (!badge) {
      if (isWatching) badge = badgeEl("กำลังดู");
      else if (isCooling) badge = badgeEl("รอคิว (ไม่มีคนไลฟ์)", "warn");
      else if (cfg.autoWatchEnabled) badge = badgeEl("รอคิว");
    }

    $gameStatusList.appendChild(gameRowEl(game, i, isWatching, badge, detail, waitUntil));
  });
}

// ---- load saved values ----
(async () => {
  const cfg = await browser.storage.local.get([
    "enabled", "watchListRaw", "autoWatchEnabled", "tabQuota", "priorityMode",
    "autoOffEnabled",
  ]);

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
  if (area !== "local") return;
  if (changes.enabled) renderPower(changes.enabled.newValue ?? true);
  if (changes.lastClaimAt || changes.lastClaimText || changes.watchTabs) renderInfo();
  if (
    changes.watchList || changes.watchTabs || changes.autoWatchEnabled ||
    changes.watchPhase || changes.invalidSlugs || changes.campaignProgress ||
    changes.priorityMode || changes.emptyUntil ||
    changes.openCampaigns || changes.gameWaitUntil
  ) {
    renderGameStatus();
  }
  if (changes.watchList) reconcileGamesTextarea();
});

$campaignsCheck.addEventListener("click", async () => {
  $campaignsCheck.disabled = true;
  $campaignsCheckStatus.textContent = "กำลังเปิดหน้า All Campaigns เพื่อเช็ค...";
  try {
    const res = await browser.runtime.sendMessage({ type: "refreshCampaigns" });
    if (res && res.ok) {
      $campaignsCheckStatus.textContent =
        `เช็คแล้ว: มี drop เปิดอยู่ ${res.active} เกม (จากทั้งหมด ${res.total}) · เพิ่งอัปเดต`;
      await renderGameStatus();
      await reconcileGamesTextarea();
    } else {
      $campaignsCheckStatus.textContent = "เช็คไม่สำเร็จ - เปิดหน้า twitch.tv/drops/campaigns เองแล้วลองใหม่";
    }
  } catch (e) {
    $campaignsCheckStatus.textContent = "เช็คไม่สำเร็จ: " + e;
  } finally {
    $campaignsCheck.disabled = false;
  }
});

document.getElementById("save").addEventListener("click", async () => {
  const watchListRaw = $gamesList.value;
  const watchList = parseWatchList(watchListRaw);
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
  $status.textContent = "บันทึกแล้ว ✓";
  setTimeout(() => ($status.textContent = ""), 2000);
});
