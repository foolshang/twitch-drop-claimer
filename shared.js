/**
 * shared.js - loaded first in every context (content script, background,
 * popup) so game-name <-> slug conversion stays identical everywhere.
 */

// bump this string on every meaningful source edit, and say the expected
// value out loud when asking for a fresh test - lets whoever's testing
// confirm from the background console alone that Firefox is actually running
// this exact source tree, not a stale reload/cached build/old .xpi.
const BUILD_MARKER = "2026-09-10-r1";

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
  // Twitch shows this game as "Rainbow Six Siege" now, but the directory
  // category slug still keeps the legacy "tom-clancys-" prefix - confirmed
  // live 2026-09-01: /directory/category/rainbow-six-siege renders blank
  // (no h1, 0 cards), /directory/category/tom-clancys-rainbow-six-siege is
  // the real one ("Rainbow Six Siege - Twitch", 30 cards). So the
  // displayName -> toSlug path (used by the open-campaign resolver too) has
  // to be redirected here.
  "r6": "tom-clancys-rainbow-six-siege",
  "r6s": "tom-clancys-rainbow-six-siege",
  "rainbow six": "tom-clancys-rainbow-six-siege",
  "rainbow six siege": "tom-clancys-rainbow-six-siege",
  "rainbow 6 siege": "tom-clancys-rainbow-six-siege",
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

function searchUrl(term) {
  return `https://www.twitch.tv/search?term=${encodeURIComponent(term)}`;
}

// loose key for comparing game names across the typo/spacing/punctuation
// differences between what a user types and Twitch's own displayName
// ("Tom Clancy's The Division 2" -> "tomclancysthedivision2")
function normalizeGameName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Given a user's typed game name and the list of games that currently have
// an OPEN drop campaign ([{ slug, displayName, ... }] from background.js's
// openCampaigns snapshot), return the campaign entry that game name resolves
// to, or null. Deliberately loose on the name - once matched, Twitch's own
// displayName/slug is the source of truth - but never loose enough to bind
// the wrong game:
//   1. slug / alias equality (shared toSlug)
//   2. exact normalized displayName equality
//   3. one normalized name fully contains the other, the shorter is >= 4
//      chars, AND exactly one campaign matches that way (no ambiguous pick)
function matchOpenCampaign(input, campaigns) {
  if (!input || !Array.isArray(campaigns) || campaigns.length === 0) return null;
  const inSlug = toSlug(input);
  const inNorm = normalizeGameName(input);
  if (!inNorm) return null;

  let hit = campaigns.find((c) => c.slug && c.slug === inSlug);
  if (hit) return hit;

  hit = campaigns.find((c) => normalizeGameName(c.displayName) === inNorm);
  if (hit) return hit;

  const contained = campaigns.filter((c) => {
    const cn = normalizeGameName(c.displayName);
    if (!cn) return false;
    const [short, long] = cn.length < inNorm.length ? [cn, inNorm] : [inNorm, cn];
    return short.length >= 4 && long.includes(short);
  });
  return contained.length === 1 ? contained[0] : null;
}
