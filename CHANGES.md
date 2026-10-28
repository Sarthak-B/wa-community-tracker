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
