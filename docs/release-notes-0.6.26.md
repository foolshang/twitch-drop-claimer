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
- Pinned channels ("@streamer" lines, or just paste a twitch.tv channel link): a channel can sit next to a game entry for the same game (for example "Rust" and "@streamer"), each with its own tab and its own progress. Progress is tracked per campaign.
- A pinned channel that is offline keeps its tab but no longer takes up a tab slot, so games that can earn drops use the slots meanwhile (at most 5 such tabs). When it goes live it takes a slot - after it has been live for 2 minutes, and without flapping back and forth. The popup says "offline - waiting to go live", "live - waiting for a free tab slot" or "checking the channel...".
- A pinned channel that goes live while its tab still shows the offline page (Twitch shows a "Live Now" card there instead of the player) is now caught: the tab is reloaded into the player and started.
- A pinned channel that matches no campaign and plays a game without drops no longer holds a slot, and a pinned channel playing a different game than its campaign shows "playing another game - not earning drops". A row shows the game a channel is playing only while it really is playing it ("last seen: ..." otherwise).
- The popup says when Twitch accepted a claim but your game account is not linked yet (the reward is yours on Twitch; link the account to get it in-game), instead of treating it as a failure. Warnings show "game - reward", never internal ids.
- The popup tells you when Twitch is rejecting Drops for your session (clear the twitch.tv cookies and log in again), and when a game account is not connected, instead of retrying claims forever.
- The popup warns about watch-list lines that cannot be used (for example a game name with no Latin letters - type its English name).

FIXED
- Fresh install: the extension now really starts (a missing "on" setting was read as off in several places).
- The extension's watch tabs could end up in your own Firefox window, and after an unclean shutdown it could mistake one of YOUR windows for its own. It now only ever uses its own tagged window and leaves yours alone.
- A fully claimed campaign could show "done" with 4/5; it now reads 5/5 and is marked done only when the Claimed list (or Twitch's own data) confirms it.
- Auto-claim: each reward has its own claim state, so one reward Twitch refuses no longer holds up the others; the channel-points "Claim Bonus" chest is never clicked (this extension is for drops only); the close button of a drop notification is never clicked; "Last claimed" shows the reward's name.
- The inventory tab of the extension is reloaded reliably (rows no longer stay stuck until you refresh the page by hand).
- A single failed "integrity check" answer from Twitch that recovers a second later is ignored; the session is only treated as flagged when it keeps failing.
- A temporarily blocked game name is no longer counted as "finished" (it could switch the extension off for good).
- Settings: Save keeps what the extension had worked out for your games; background updates no longer overwrite what you are typing or close the "watch from" calendar; "24:00" means the end of the day; accented names (for example Pokemon) match their campaign.
- Switching the extension off while it is opening a tab no longer leaves a tab playing; moving between Twitch pages is handled; many smaller fixes for other UI languages (progress lines, viewer counts, the quality menu, dates) and for stale per-tab state.
- Far fewer automatic page reloads for offline pinned channels (they back off 3, 6, 10, then 15 minutes), and the debug log is much shorter and always includes the window events that explain where a tab was opened.

BUG REPORTS
- The "send bug report" button now also works behind a stricter reporting service (per-client limits; one report always counts once even when sent in parts). It still sends only the debug log text, the version and the UI language.
