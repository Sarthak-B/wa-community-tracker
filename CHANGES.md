# Changes (2026-10-28)

## Fixes
- **New WhatsApp link no longer lost.** The bot writes `bot/.linked_ok` as soon as WhatsApp accepts the login; the workflow saves the session whenever that file exists, even if the first sync fails or times out. A logged-out run never overwrites the last good session. A fresh link is kept open 60 s before closing, on success or error. Reading stops 4 min before the hard timeout so there is always time to upload and save.
- **Score: read rate counts less and no longer punishes communities.** New weights: 60% clicks per 100 members, 25% replies + reactions per 100 members, 15% read rate (`WEIGHTS` in dashboard.html). A community with no posts from the linked number has no read rate ("–") and is scored on clicks + engagement only, instead of getting 0.
- **Choose groups:** unticking everything now means "track nothing". The Automatic button saves "automatic", so communities joined later are picked up.
- **Deleting a link keeps its clicks in the stats** (soft delete via new `links.deleted_at`; the Worker adds the column to existing databases itself).
- **Re-link during a running sync** is queued instead of ignored.
- Short links work in any letter case; community names refresh when renamed on WhatsApp; a wrong saved password is cleared instead of sticking.

- **Newest community first.** The bot reads and uploads the most recently made community first, then goes further back (uses the parent community's creation date). Safety net: a group not read for `STALE_HOURS` (default 24) goes first so older ones still get covered. The dashboard's group list is also shown newest first.

## Workflow
- Uses the runner's preinstalled Chrome (no Chromium download each run; saves minutes). Falls back to downloading if missing.
- Node 22, `actions/checkout@v5`, `actions/setup-node@v5`, `permissions: contents: read`.
- `LOOKBACK_DAYS`, `MAX_MESSAGES_PER_GROUP`, `COUNT_ADMIN_POSTS` repo variables are now passed to the bot.

## Config / docs
- wrangler.toml: existing `SHORT_BASE`, `FALLBACK_URL` and database id kept; `GH_BRANCH` documented (commented); GH secrets listed. `wrangler.sb.toml` untouched.
- README rewritten to match the code (6-hour schedule, link format, all settings, score, GitHub minutes, token expiry).

# Changes (2026-10-28, later): newest communities first, fair scores for new ones
- **Real community age.** The bot now uploads each community's WhatsApp creation date (`created`). The Worker stores it in the new `communities.wa_created_at` column (added to the live database automatically, no SQL to run). The first sync after deploying also backfills the date for every group in Choose groups, not only the ones read that run. Fallbacks: a date in the group name ("18 OCT 2026 | …"), then the date the tracker first saw it (always sorted last, since it says nothing about real age).
- **Newest first everywhere:** leaderboard (new "Show: Newest community first / Best to weakest" switch, remembered per browser), bar chart, Campaigns columns, Messages community filter, Link builder ticks, Choose groups. The `#` column always keeps the performance rank.
- **New communities are visible straight away:** any ticked community shows on the leaderboard even with no posts yet, with a "New · N days" tag for 7 days and "Started <date> · last post <date>" under its name.
- **Fair score for new communities:** clicks per 100 members are divided by the number of tracked links, and replies + reactions per 100 members by the number of posts, so a 3-day-old community is not out-ranked just for having fewer posts. Fewer than 2 posts and 2 links in the period = "Too early to rank" (no score, never marked Needs attention).

# Update 7 (2026-10-28): links on sb.flexifunnels.com, no duplicate communities
- **Links now look like your page:** `https://sb.flexifunnels.com/funnel-agent-replay-3b` (your page address + a 2-letter ending per community). The `sb` worker runs on the route `sb.flexifunnels.com/*`: it answers only tracked links (`/<page>-<tag>`), and passes every other request straight to FlexiFunnels unchanged. Database problems also fall through to the real page, so the site never shows a tracker error. Needs flexifunnels.com on Cloudflare with the `sb` record proxied. `SITE_HOSTS` (wrangler.sb.toml) lists the addresses this applies to; `SHORT_BASE` (both configs) is where new links are made.
- Links for a page with no path are now `wa-<tag>` (was a random code) so they also work on the site address.
- Old links on `sb.flexicommunities.workers.dev` and `/l/...` keep working (`workers_dev = true`).
- **No more duplicate communities.** A community's main (parent) group, which only holds admins, is never tracked by the bot, hidden from Choose groups and from the Link builder, and only shown on the leaderboard if its old links got clicks (labelled "Community main group").
- **Update 7b: relay.** flexifunnels.com lives in a different Cloudflare account than the tracker, so a route can't be added from here. `relay/relay.js` is deployed in the domain's account on `sb.flexifunnels.com/*`: tracked links are handed to the tracker (`TRACKER` = https://sb.flexicommunities.workers.dev), everything else goes to FlexiFunnels. It passes the visitor's IP and country with a shared `RELAY_KEY` (secret on both workers), so unique clicks and countries stay correct. The tracker marks real tracked redirects with `x-tracked: 1`; unknown codes and tracker outages show the normal page. Query strings after a tracked link (e.g. `?fbclid=`) no longer stop it being counted.

# Update 8 (2026-10-28): free short address on Cloudflare Pages (replaces 7/7b's sb.flexifunnels.com plan)
- No access to flexifunnels.com's Cloudflare account, so new links use a free Pages address in the tracker's own account, e.g. `https://flexisb.pages.dev/funnel-agent-replay-3b`. `pages/_worker.js` hands tracked links to the `sb` worker with the visitor's IP and country (`RELAY_KEY`, same secret on both); everything else goes to https://sb.flexifunnels.com. The relay/ folder from 7b was removed.
- `SHORT_BASE` in wrangler.toml is the Pages address (filled in during setup). If it still holds the PAGES_NAME placeholder, the dashboard keeps making sb.flexicommunities.workers.dev links instead of broken ones.
- Kept from update 7: community main (parent) groups are never tracked and hidden from Choose groups / Link builder; links are always `<page>-<tag>`; a `?…` after a link no longer stops it being counted.

# Update 9 (2026-10-28): links that keep working
- **Hiding never breaks a link.** The link list's ✕ is now **Hide**: the link leaves the list but keeps redirecting and counting clicks, since it may already be posted. "Show hidden links" lists them again with **Unhide**.
- **Smart fallback.** If the tracker or its database can't be reached, a link like `/funnel-agent-replay-3b` sends the visitor to `https://sb.flexifunnels.com/funnel-agent-replay` (the page it was made for) instead of the homepage. Only that click goes uncounted. Applies in both the Pages short-link worker and the tracker.
- Old random-code links (e.g. `sRbWJc`) also work on the pages.dev address; `/dashboard`, `/health` and `/api` can never be reached through it.

# Update 10 (2026-10-28): message composer + auto-send
- **Message composer** (top of Link builder): paste a message once, optionally attach a JPG/PNG/WEBP, MP4 or PDF (max 16 MB, message = caption, max 1,024 characters), tick communities, **Make messages**. Every link in the message gets its own tracked link per community (same link twice in a message = same tracked link); links that are already tracker links are left alone. One copy per community, with Copy, Mark posted, Retry and status. Earlier batches are listed under "Earlier messages".
- **Auto-send**: the bot posts each community's own copy, one at a time, with a random 30-90 s pause (repo variables `SEND_GAP_MIN` / `SEND_GAP_MAX`), max 40 per run (`MAX_SENDS_PER_RUN`, the rest continue in a follow-up run). WhatsApp's 5-chat forward limit doesn't apply: every message is a new message, not a forward. It checks the number is an admin of announcement groups first. Each message is claimed before sending, so it is never sent twice; a message the bot was sending when a run died is marked "Check WhatsApp", never resent automatically. "Stop sending" cancels what hasn't gone out.
- Every run (scheduled sync, Sync now, link, send) sends queued messages first, so a scheduled sync can't knock a send out of GitHub's queue. Workflow: new `send` mode, job limit 60 min (bot extends its own timeout to 55 min only when messages are queued), session restored for every mode except login.
- New tables `sends`, `media`, `media_chunks` are created automatically (no SQL to run). Media older than 30 days that no unsent message needs is deleted.
- Risk: automated posting through WhatsApp Web is against WhatsApp's terms and can get the linked number banned. Use the second admin number, never the main business number.

# Update 11 (2026-10-28): formatting editor in the message composer
- The message box is now a small editor with **B**, *I*, ~S~, monospace, bullet list, numbered list, quote and Clear (shortcuts ⌘B, ⌘I, ⌘⇧X, ⌘E). Formatting is sent with WhatsApp's own markers: *bold*, _italic_, ~strike~, ```mono```; lines starting "- ", "1. " or "> " show as lists / quotes in WhatsApp. Spaces at the edge of a selection are kept outside the markers (WhatsApp ignores "* text *").
- Pasting an existing WhatsApp message turns its *markers* into visible formatting (plain text only, no stray styles from other apps); what is sent is identical to what was pasted.
- "How it will look on WhatsApp" preview (applies WhatsApp's own rules, so e.g. 2*3*4 stays plain) and the exact text that is sent. Each community's copy is shown formatted; Copy message copies the markers, so pasting into WhatsApp keeps the formatting.

# Update 12 (2026-10-28): simple "Send a message" for anyone
- Link builder tab renamed **Send message & links**. The composer is now 4 numbered steps (name, message, optional file, communities) and **Create messages**; results show **Send to all N** / **Send it**, **Copy**, **I posted it**, **Try again**, **Stop**. Toolbar trimmed to Bold, Italic, Strike, List (⌘B / ⌘I still work; pasted WhatsApp *markers* still become formatting). UTM tags always on. All texts and error messages rewritten in plain words.
- The old link-only form is now "Only need links?".
- wrangler.toml SHORT_BASE set to https://flexisb.pages.dev.

# Update 13 (2026-10-28): reliable sending, number safety, one form, progress on every tab
- **Fix for "Data passed to getter must include an id property".** The bot no longer uses the library's `sendMessage` (which marks the chat as seen first and re-reads the sent message after; both break on current WhatsApp Web). It sends through WhatsApp Web directly. After any unclear error it looks in the group for the message (each community's copy is unique by its link) and counts it as sent if it is there, so nothing is ever posted twice. A failed send is retried once without the link preview, only if the message is not in the group.
- **Safety for the WhatsApp number:** random 45-120 s pause between communities (minimum 20 s even if the variables are set lower), a 2-5 s "typing…" before each message, at most 20 per run and 40 per 24 hours (`MAX_SENDS_PER_RUN`, `MAX_SENDS_PER_DAY`), and after 2 problems in a row sending stops and the rest are marked "Not sent" for a person to look at (`STOP_AFTER_FAILS`). WhatsApp errors are shown in plain words.
- **One form:** "Send a message" now has a page-link field (step 2). The link is swapped for each community's own link wherever it appears in the message, added at the end if it isn't there, or given on its own if there is no message (links only). The separate link-only form is gone; the link list stays below.
- **Search** in Pick communities; "Select all" becomes "Select these" while searching; picked count shown.
- **Progress bar at the top of every tab** while messages are going out (count, what the bot is doing, View, Stop), then a done / problems summary for 15 minutes.

# Update 14 (2026-10-28): photos / videos / PDFs send again
- **Root cause of "Data passed to getter must include an id property" on messages with a file:** current WhatsApp Web no longer fills in the file's `filehash` while preparing media, and whatsapp-web.js (1.34.7, and its latest code on GitHub) uses that empty value as a lookup key, which crashes. The bot now replaces the library's media step with the same code plus the missing hash, calculated the way WhatsApp does (SHA-256 of the prepared file, base64). Text-only messages were never affected by this step.
- A media error now says so in plain words ("WhatsApp didn't accept the photo/file… post this one yourself"); media sends are not retried without link preview (that isn't the cause there).
- **Duplicate communities:** a community's main (parent) group is now also recognised when WhatsApp doesn't mark it, by checking which group the others point to as their parent. After the next sync it disappears from Pick communities.
- GitHub runs are named by what they do: "Sending messages", "Sync now", "Linking WhatsApp", "Scheduled sync".

# Update 15 (2026-10-28): live clicks
- Clicks were always saved the moment they happen; the dashboard now fetches them every 15 seconds by itself (`GET /api/live`), so no sync or Refresh is needed for clicks. A **Live** pill in the header shows it's on (click to pause; flashes "+N new clicks"). When new clicks arrive, the leaderboard, campaigns, KPIs and link list refresh too (at most every 15 s).
- New **Live clicks** card at the top of the leaderboard: the last 15 clicks (time, community, campaign, country, phone/computer) and counts for the last hour and today (with unique people). Link-preview fetchers and bots are still left out.
- Updates pause while the dashboard tab is hidden, so an open tab in the background costs nothing. Reads, reactions and replies still come from the WhatsApp sync (WhatsApp only gives those to the bot).
- New index `idx_clicks_time` on clicks(clicked_at), created automatically.
