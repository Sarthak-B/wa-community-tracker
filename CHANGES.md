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
