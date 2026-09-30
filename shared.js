/**
 * shared.js - loaded first in every context (content script, background,
 * popup) so game-name <-> slug conversion stays identical everywhere.
 */

// bump this string on every meaningful source edit, and say the expected
// value out loud when asking for a fresh test - lets whoever's testing
// confirm from the background console alone that Firefox is actually running
// this exact source tree, not a stale reload/cached build/old .xpi.
const BUILD_MARKER = "2026-09-30-r3";

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

// "poe2, Diablo 4\n path of exile\n @favoritestreamer" -> [{input, slug}, ...],
// de-duplicated, order preserved (priority = list order, shared by games and
// pinned channels alike - one combined tabQuota, not a separate pool per type).
//
// A line starting with "@" pins a specific channel instead of a game: the
// user wants that exact channel watched (bypassing the directory's
// lowest-viewer auto-pick), whatever game it happens to be playing.
// `slug` starts out as a synthetic "channel:<name>" key (there's no real
// game slug yet - the channel might not even be live) so every existing
// per-slug storage map (watchTabs/watchMeta/campaignProgress/...) still has
// a stable, unique key to index by. Once background.js observes what game
// the pinned channel is actually streaming, it rewrites this entry's slug to
// the real category slug (see handleChannelPlayingGame) and everything
// downstream (inventory-progress matching, badges, isGameDone) treats it
// exactly like an ordinary typed-game entry from that point on.
function parseWatchList(raw) {
  const lines = (raw || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const list = [];
  for (const input of lines) {
    if (input.startsWith("@")) {
      const channel = input.slice(1).trim();
      if (!channel) continue;
      const key = "channel:" + channel.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ input, slug: key, channel, pinnedChannel: true });
      continue;
    }
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

function channelUrl(channel) {
  return `https://www.twitch.tv/${encodeURIComponent(channel)}`;
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

// ---- claim backoff --------------------------------------------------------
// A clicked claim button that is still there CLAIM_VERIFY_MS later means Twitch
// rejected the claim (seen live: every DropsPage_ClaimDropRewards answered
// "failed integrity check" and the button stayed, so it used to be re-clicked
// every few seconds for ever). The state is kept by background.js, per reward
// and shared by every tab (content.js asks before it clicks): a failure in a
// row waits CLAIM_BACKOFF_MS[failures - 1] before the next click, and
// CLAIM_MAX_FAILURES in a row stops that reward for the rest of the browser
// session (so 1 -> 5 -> 15 min, then stop). A success forgets the reward.
// State is a plain JSON object { f, next, stop } (f = failures in a row, next =
// earliest next click, stop = given up), so it can live in storage.session.
const CLAIM_VERIFY_MS = 12_000;
const CLAIM_BACKOFF_MS = [60_000, 300_000, 900_000];
const CLAIM_MAX_FAILURES = 4;
// consecutive rejected claims (across all rewards, no success in between)
// before the popup tells the user to claim by hand / check their session
const CLAIM_WARN_STREAK = 3;

function claimBackoffAllows(state, now) {
  if (!state) return true;
  if (state.stop) return false;
  return now >= (state.next || 0);
}

function claimBackoffAfterFailure(state, now) {
  const f = ((state && state.f) || 0) + 1;
  if (f >= CLAIM_MAX_FAILURES) return { f, next: 0, stop: true };
  return { f, next: now + CLAIM_BACKOFF_MS[Math.min(f - 1, CLAIM_BACKOFF_MS.length - 1)], stop: false };
}
