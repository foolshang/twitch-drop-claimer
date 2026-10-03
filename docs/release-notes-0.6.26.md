Release notes for 0.6.26 - paste into the AMO "Release notes" field (plain text, no markup needed).
Covers everything since the last listed release, 0.6.15.

----------------------------------------------------------------------

0.6.26

NEW PERMISSION: "Access recently closed tabs" (the "sessions" permission)
When you update, Firefox will ask you to approve this permission. That sentence is Firefox's standard wording for the whole permission category; the extension uses one small part of it:

What it is used for: the extension keeps its tabs in a window of its own. When it creates that window it puts a small tag ("dropClaimerWatch") on it with sessions.setWindowValue, and it later checks whether a window carries that tag with sessions.getWindowValue. After an unclean Firefox shutdown the tag comes back with the restored window, so the extension can tell its own window from yours. Window ids are renumbered every time Firefox starts, so the tag is the only reliable way; before, the extension had to guess from how a window's tabs looked, which could be wrong.

What it never does:
- It never reads your list of recently closed tabs or windows, and never restores any tab or window.
- It never reads your browsing history or tab history.
- It never writes to, closes or changes your own windows - for a window without the tag it only asks whether the tag is there, and a window without the tag is left completely alone.
- Nothing leaves your computer because of it.

If you decline: Firefox keeps the previous version of the extension and leaves the update waiting; you can accept it later from the add-ons page. The previous version keeps working with the old guessing described above.

Full details: https://github.com/foolshang/twitch-drop-claimer#the-sessions-permission

NEW
- Pinned channels ("@streamer" lines or a pasted twitch.tv link) can sit next to a game entry for the same game, each with its own tab and progress. Offline ones keep their tab but take no tab slot; one that goes live behind its offline page (Twitch's "Live Now" card) is reloaded into the player.
- The popup tells you when Twitch accepted a claim but your game account is not linked (link it to get the reward in-game), and when Twitch rejects Drops for your session (clear the twitch.tv cookies and log in again).

FIXED
- A fresh install now really starts; watch tabs no longer end up in your own window.
- Campaigns show 5/5 when fully claimed, confirmed by Twitch's own data too.
- Auto-claim: per-reward state; the "Claim Bonus" chest and notification close buttons are never clicked; the inventory tab reloads reliably.
- Settings keep resolved game info and are not overwritten while you type; accented names (Pokémon) match.
- Many smaller fixes (fewer reloads of offline channels, page navigation, other UI languages, a shorter debug log).

BUG REPORTS
- The "send bug report" button sends only the debug log, the version and the UI language - never your Twitch login or tokens.
