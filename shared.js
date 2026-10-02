/**
 * shared.js - loaded first in every context (content script, background,
 * popup) so game-name <-> slug conversion stays identical everywhere.
 */

// bump this string on every meaningful source edit, and say the expected
// value out loud when asking for a fresh test - lets whoever's testing
// confirm from the background console alone that Firefox is actually running
// this exact source tree, not a stale reload/cached build/old .xpi.
const BUILD_MARKER = "2026-10-02-r5";

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

// ---- inventory campaigns -> watch-list entries (0.6.17) ---------------------
// A game can have several campaigns at once: one for everybody ("Rust Isles
// General Drops": no channel restriction) and many that only count on named
// channels ("Rust Isles Tac Gloves": allow.channels = [itsryanhiga, welyn]).
// Their inventory cards share the game's boxart, so the card's game says
// nothing about WHICH campaign it is. What does (real captures, 2026-10-01):
//   - the card's title link `/drops/campaigns?dropID=<campaign id>` and, for a
//     restricted campaign, the channel links of its "including /a and /b" hint;
//   - the Inventory GQL's dropCampaignsInProgress[] (inject.js
//     `inventoryCampaigns` signal): id, name, status, game and the complete
//     allow.channels (null for an unrestricted campaign).
// Entries then own cards like this (a "card" is what content.js's
// parseInventoryCampaigns reports, `meta` the GQL record of its campaign id):
//   a game entry ("Rust")        - cards of that game that are NOT restricted;
//   a pinned entry ("@streamer") - cards of ACTIVE campaigns whose allowed
//                                  channels include that channel (any number:
//                                  it is done only when all of them are). The
//                                  game the channel happens to be playing
//                                  right now plays no part in WHICH campaigns
//                                  those are - only in whether it is earning
//                                  them (entryPlaysWrongGame).
// A card that cannot be told apart is never lent to an entry it may not
// belong to - the entry just has no progress yet ("unknown", still watched).

// the game an entry is about: its slug, or for a pinned channel the game it was
// last seen playing (null until known; legacy entries rewritten by 0.6.16 and
// older keep the game slug in `slug`)
function entryGameSlug(g) {
  if (!g) return null;
  if (!g.pinnedChannel) return g.slug || null;
  if (g.gameSlug) return g.gameSlug;
  return g.slug && !String(g.slug).startsWith("channel:") ? g.slug : null;
}

const lcChannel = (s) => String(s || "").trim().replace(/^@/, "").toLowerCase();

// lower-case logins of the channels a card's campaign is restricted to ([] =
// not restricted): the GQL record of its campaign id when known, else the
// channel links the card itself shows
function cardChannels(card, meta) {
  const list = meta ? meta.channels : (card && card.channels);
  return Array.isArray(list) ? list.map(lcChannel).filter(Boolean) : [];
}

// every slug the card's game can be known by
function cardGameSlugs(card, meta, gameSlugMap) {
  const out = new Set();
  if (card && card.slug) out.add(card.slug);
  if (meta) {
    if (meta.gameName) out.add(toSlug(meta.gameName));
    if (meta.gameId && gameSlugMap && gameSlugMap[meta.gameId]) out.add(gameSlugMap[meta.gameId]);
  }
  return out;
}

// is the card's campaign over? Twitch's own status when the GQL record is
// there, else the card's "no longer available" text - but a game whose GQL
// campaigns include an ACTIVE one is never called expired by text alone (the
// real capture of two same-game cards, one ended and one current)
function cardIsExpired(card, meta, activeSlugs) {
  if (meta && meta.status) return meta.status !== "ACTIVE";
  if (!card || !card.expired) return false;
  return !(activeSlugs && card.slug && activeSlugs.has(card.slug));
}

// ctx: { metaById, gameSlugMap, activeSlugs } - all optional
function entryOwnsCard(g, card, ctx = {}) {
  const meta = card && card.campaignId && ctx.metaById ? ctx.metaById[card.campaignId] || null : null;
  const channels = cardChannels(card, meta);
  const games = cardGameSlugs(card, meta, ctx.gameSlugMap);
  if (g.pinnedChannel) {
    if (!channels.includes(lcChannel(g.channel))) return false;
    return !cardIsExpired(card, meta, ctx.activeSlugs); // only ACTIVE campaigns count
  }
  return channels.length === 0 && games.has(g.slug);
}

// the campaigns the Inventory GQL says an entry has in progress (for "is every
// one of them accounted for"): same rules as entryOwnsCard on the GQL records
function entryExpectedCampaignIds(g, ctx = {}) {
  const out = [];
  for (const meta of Object.values(ctx.metaById || {})) {
    if (!meta || meta.status !== "ACTIVE") continue;
    const channels = cardChannels(null, meta);
    const games = cardGameSlugs(null, meta, ctx.gameSlugMap);
    if (g.pinnedChannel) {
      if (!channels.includes(lcChannel(g.channel))) continue;
    } else if (channels.length > 0 || !games.has(g.slug)) {
      continue;
    }
    out.push(meta.id);
  }
  return out;
}

// the progress record of an entry from the cards it owns. "Done" needs EVERY
// owned active card complete (and, when the GQL tells which campaigns the entry
// has in progress, every one of those to have a card); "expired" only when
// every owned card is expired. A card that is not complete is never hidden
// behind one that is.
function aggregateEntryProgress(cards, expectedIds) {
  if (!cards || cards.length === 0) return null;
  const expiredOf = (c) => !!c.expiredFinal;
  const active = cards.filter((c) => !expiredOf(c));
  const use = active.length ? active : cards;
  const complete = (c) => c.total > 0 && c.claimed >= c.total && !c.accountNotConnected;
  const seen = new Set(cards.map((c) => c.campaignId).filter(Boolean));
  const covered = !(expectedIds || []).some((id) => !seen.has(id));
  const known = use.every((c) => c.timeRemainingMin != null || complete(c));
  const expiries = use.map((c) => c.expiresAt).filter((t) => typeof t === "number");
  // the games of the campaigns still to be earned (all of them once every card is complete)
  const pending = use.filter((c) => !complete(c));
  const earn = pending.length ? pending : use;
  const uniq = (list) => [...new Set(list.filter(Boolean))];
  return {
    label: use[0].label,
    claimed: use.reduce((n, c) => n + c.claimed, 0),
    total: use.reduce((n, c) => n + c.total, 0),
    accountNotConnected: use.some((c) => c.accountNotConnected),
    expired: active.length === 0,
    allComplete: active.length > 0 && active.every(complete) && covered,
    expiresAt: expiries.length ? Math.min(...expiries) : null,
    timeRemainingMin: known ? use.reduce((n, c) => n + (c.timeRemainingMin || 0), 0) : null,
    campaignNames: use.map((c) => c.campaignName || (c.campaignId ? c.campaignId : null)).filter(Boolean),
    campaignIds: cards.map((c) => c.campaignId).filter(Boolean),
    // every tier's reward name (duplicates kept) - what the Claimed section must list once the cards are gone
    tierNames: use.flatMap((c) => (c.tiers || []).map((t) => t.name).filter(Boolean)),
    unnamedTiers: use.reduce((n, c) => n + (c.tiers || []).filter((t) => !t.name).length, 0),
    campaignGameSlugs: uniq(earn.flatMap((c) => c.gameSlugs || [])),
    campaignGameNames: uniq(earn.flatMap((c) => c.gameNames || [])),
  };
}

// A pinned channel whose matched campaigns are for a game other than the one the
// channel is streaming right now (seen live, 0.6.17: "@mrwobblestwitch" playing
// I'm Only Sleeping while matched to the Rust campaign "Rust Isles Facemask"):
// watching it earns nothing, so it is not "watching" - its tab stays only to see
// the channel come back, and does not hold a quota slot meanwhile. False when
// the entry is not pinned, has no matched campaign yet (it then watches whatever
// the channel plays), is finished, or either game is unknown.
function entryPlaysWrongGame(g, progress) {
  if (!g || !g.pinnedChannel || !progress || progress.allComplete || progress.expired) return false;
  const now = entryGameSlug(g);
  const slugs = progress.campaignGameSlugs || [];
  if (!now || slugs.length === 0 || slugs.includes(now)) return false;
  const names = progress.campaignGameNames || [];
  if (g.pinnedGameName && names.includes(normalizeGameName(g.pinnedGameName))) return false;
  return true;
}

// Is a campaign whose card left "In Progress" really done? It is when the Claimed
// section lists every reward of its tiers - one entry per tier, so a reward name
// that appears on two tiers needs two entries (the same one-for-one matching
// content.js applies to a visible card). `claimedMap`: name -> count from the
// Claimed section. Unknown names or an unreadable section never confirm.
function claimedConfirmsEntry(progress, claimedMap) {
  if (!claimedMap || !progress || !Array.isArray(progress.tierNames) || progress.tierNames.length === 0 || progress.unnamedTiers > 0) {
    return { confirmed: false, missing: [] };
  }
  const need = new Map();
  for (const name of progress.tierNames) need.set(name, (need.get(name) || 0) + 1);
  const missing = [];
  for (const [name, count] of need) if ((claimedMap.get(name) || 0) < count) missing.push(name);
  return { confirmed: missing.length === 0, missing };
}
