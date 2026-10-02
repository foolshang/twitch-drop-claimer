Release notes for 0.6.19 - paste into the AMO "Release notes" field (plain text, no markup needed).

----------------------------------------------------------------------

0.6.19

FIXED
- The extension's watch tabs could end up in your own Firefox window (the same tabs as the extension's separate watch window). The extension now only ever opens its tabs in its own, verified watch window - and does nothing for a moment rather than falling back to the window you are using.
- After Firefox was shut down uncleanly (Windows restarting after an update, a power cut, shutting Windows down with Firefox still open) and restored its windows, the extension could mistake one of YOUR windows for its own, or open a second watch window next to the restored one. It now recognises its own window reliably and leaves every other window alone. See "New permission" below.
- A campaign you had fully claimed could show "done" with the count 4/5. The count now reads 5/5, and a campaign is only marked done once the Claimed list confirms its rewards. If the last reward is not listed yet it shows "probably done - not confirmed" and keeps its tab open; after 30 minutes without the card coming back it is accepted as done and the debug log says so.

- Claims: every reward on the inventory now has its own claim key (campaign + reward name), so one reward Twitch refuses no longer holds up the others.
- The channel-points "Claim Bonus" chest in the chat is no longer clicked at all - this extension is for drops only. It only clicks drop claim buttons: the drop notification, the chat callout, and claim buttons inside a campaign card on the inventory page.
- The debug log no longer fills with the same line every minute: repeated progress/pinned lines are written when they change, plus a short summary every 15 minutes, and window/session events are kept in a small separate section that is attached to every bug report.

ALSO IN THE 0.6.16 - 0.6.18 LINE (if you are updating from an older version)
- A "@channel" entry can sit next to a game entry for the same game (for example "Rust" and "@streamer"), each with its own tab and its own progress; progress is tracked per campaign.
- A pinned channel that streams a different game than its campaign's shows "playing another game - not earning drops" and does not take up a tab slot.
- The extension tells you when Twitch is rejecting Drops for your session (clear the twitch.tv cookies and log in again) and when a game account is not connected, instead of retrying claims forever.

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
