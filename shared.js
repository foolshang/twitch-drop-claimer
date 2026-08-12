/**
 * shared.js - loaded first in every context (content script, background,
 * popup) so game-name <-> slug conversion stays identical everywhere.
 */

const ALIASES = {
  // Path of Exile
  "poe": "path-of-exile",
  "poe1": "path-of-exile",
  "poe2": "path-of-exile-2",
  "path of exile": "path-of-exile",
  "path of exile 2": "path-of-exile-2",
  // a few other popular games (add more as needed)
  "dota2": "dota-2",
  "lol": "league-of-legends",
  "wow": "world-of-warcraft",
  "gtav": "grand-theft-auto-v",
  "cs2": "counter-strike-2",
  "d4": "diablo-iv",
  "diablo 4": "diablo-iv",
  "ff14": "final-fantasy-xiv-online",
  "ffxiv": "final-fantasy-xiv-online",
  "r6": "tom-clancys-rainbow-six-siege",
};

function toSlug(input) {
  const key = (input || "").trim().toLowerCase();
  if (!key) return "";
  if (ALIASES[key]) return ALIASES[key];
  return key
    .replace(/['’:]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// paths that are not channel names
const RESERVED_PATHS = new Set([
  "directory", "drops", "search", "settings", "subscriptions", "wallet",
  "inventory", "friends", "videos", "downloads", "jobs", "turbo", "p",
]);

function channelFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!/(^|\.)twitch\.tv$/.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 1 && !RESERVED_PATHS.has(parts[0].toLowerCase())) {
      return parts[0];
    }
  } catch {
    // ignore
  }
  return null;
}

// "poe2, Diablo 4\n path of exile" -> [{input, slug}], de-duplicated by slug,
// order preserved (priority = list order)
function parseWatchList(raw) {
  const lines = (raw || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const list = [];
  for (const input of lines) {
    const slug = toSlug(input);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    list.push({ input, slug });
  }
  return list;
}

function directoryUrl(slug) {
  return `https://www.twitch.tv/directory/category/${slug}?filter=drops`;
}
