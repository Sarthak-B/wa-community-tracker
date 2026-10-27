# WhatsApp Community Tracker

Tracks every message we post to our WhatsApp communities and ranks the communities from best to weakest:

| Number | Where it comes from |
|---|---|
| Messages sent, reads, delivered | WhatsApp "Message info", read by the bot every 6 hours. Reads/delivered only exist for posts sent **from the linked number** |
| Replies & reactions | Read by the bot (replies = messages that quote ours) |
| Link clicks | Our own short links (e.g. `go.flexifunnels.com/funnel-agent-access-k7`), one per community, counted when clicked |
| Members | Group size, read by the bot |

Everything runs on a **Cloudflare Worker + D1 database** (short links, API, dashboard) and a **GitHub Actions** job (the WhatsApp reader). Both fit in free tiers at normal use; see "GitHub minutes" below.

```
 GitHub Actions (every 6h)                 Cloudflare Worker (always on)
 ┌──────────────────────────┐   upload   ┌──────────────────────────────┐
 │ bot/  whatsapp-web.js    │ ─────────▶ │ /api/ingest   -> D1 database │
 │ reads our sent messages  │            │ /<code>       -> logs click, │
 │ reads, reactions, replies│ ◀───────── │                  redirects   │
 └──────────────────────────┘  Start btn │ /             -> dashboard   │
                                         └──────────────────────────────┘
```

---

## 1. Deploy the Worker (one time, ~10 min)

You need a free Cloudflare account and Node.js 22+.

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create wa_tracker          # copy the database_id it prints
```

Paste that id into `worker/wrangler.toml` (`database_id = "..."`), then:

```bash
npm run db:init                            # creates the tables
npx wrangler secret put ADMIN_PASSWORD     # dashboard password - make it long, the page is public
npx wrangler secret put INGEST_TOKEN       # long random string, the bot uses it
npx wrangler secret put HASH_SALT          # any random string
npm run deploy
```

It prints your URL, e.g. `https://wa-community-tracker.<you>.workers.dev`. Open it and log in.

**Use our own domain for links (recommended):** short links on `go.flexifunnels.com` get more clicks than `workers.dev` ones. If flexifunnels.com is on Cloudflare:
1. In `wrangler.toml` uncomment the `routes` line **and** `SHORT_BASE = "https://go.flexifunnels.com"`.
2. `npm run deploy`.

Without `SHORT_BASE`, links are built on whatever address the dashboard is open on, so opening it on workers.dev would still give workers.dev links.

Generate random strings with: `openssl rand -hex 24`

**Already deployed an older version?** Just deploy this one. The Worker adds the new `deleted_at` column to the links table by itself.

### Worker settings (`[vars]` in wrangler.toml)
| Name | Default | What it does |
|---|---|---|
| `TZ_OFFSET_MINUTES` | 330 | Time zone for the per-day charts (IST) |
| `FALLBACK_URL` | https://sb.flexifunnels.com | Where deleted, unknown or mistyped links send visitors |
| `SHORT_BASE` | dashboard address | Domain new short links are built on |
| `GH_BRANCH` | main | Branch the Start button runs the workflow on. Set it if your default branch is `master` |
| `GH_WORKFLOW` | whatsapp-sync.yml | Workflow file name |

## 2. Set up the GitHub repo

1. Push this folder to a **private** GitHub repo.
2. Settings → Secrets and variables → Actions → **Secrets**:
   - `TRACKER_URL`: the Worker URL from step 1 (no trailing slash)
   - `INGEST_TOKEN`: same value you set on the Worker
   - `SESSION_KEY`: another random string (encrypts the saved WhatsApp login)
3. Optional, same page → **Variables**:
   - `LOOKBACK_DAYS`: how many days back to re-check messages (default 14; read counts keep rising for a few days)
   - `GROUP_NAME_FILTER`: only if auto-detection misses your communities. A regex on group names, e.g. `FlexiFunnels|Creators|Course Sellers`
   - `MAX_MESSAGES_PER_GROUP`: messages loaded per group each run (default 150)
   - `COUNT_ADMIN_POSTS`: `false` to count only posts from the linked number (default `true` = every admin post in announcement groups)

## 3. Link the WhatsApp account (one time)

Use an account that is an **admin in every community**. We recommend a second admin number rather than the main business number (see Risks below).

Easiest: press **Start tracking** on the dashboard (needs the one-click setup below). Or from GitHub:

1. GitHub → Actions → **WhatsApp community sync** → Run workflow
2. mode = `login`, pair_phone = the number with country code, digits only (e.g. `919876543210`)
3. Open the running job's log. Within about a minute it prints **PAIRING CODE: XXXX-XXXX**
4. On that phone: WhatsApp → Settings → Linked devices → Link a device → *Link with phone number instead* → enter the code (you have 6 minutes)
5. The job waits 45 s for chats to load, runs a first sync, keeps the new session open at least 60 s, then saves it encrypted. The session is saved even if that first sync fails or runs out of time.

From now on it runs every 6 hours by itself (05:47, 11:47, 17:47, 23:47 IST; GitHub sometimes starts scheduled runs late). Run it manually with mode = `sync` to test straight away. The log lists every group found, with `*` next to the tracked ones.

If the dashboard ever shows **"WhatsApp got disconnected"**, link again. WhatsApp also unlinks all linked devices if the main phone itself is not used for about 14 days, so keep that phone active.

## 4. Daily use

1. Dashboard → **Link builder** → campaign name + destination URL → tick the communities → **Create links**
2. Paste each community's own link into the message for that community (**Copy all** gives you a list)
3. Post as usual. Clicks count immediately; reads/replies appear after the next sync.

Tabs:
- **Community leaderboard**: ranks communities by overall score, clicks, click rate, read rate or engagement. Top 3 get a green badge; the bottom 2 are flagged "Needs attention".
- **Campaigns**: the same post across communities side by side, with the best and weakest community for each campaign.
- **Messages**: every message we sent, with reads, reactions, replies and clicks. Reads show "–" for posts from another admin number.

Deleting a link stops it working (clicks go to `FALLBACK_URL`), but the clicks it already got stay in the stats.

### How the score works
Overall score = **60%** unique clicks per 100 members + **25%** (replies + reactions) per 100 members + **15%** read rate. Each part is compared to the best community (best = 100). Per-member rates keep a 600-member community comparable with a 3,000-member one.

Read rate has the smallest share because WhatsApp only gives read info for posts sent from the linked number, and undercounts in big groups. A community with no posts from the linked number in the period has no read rate; it is scored on clicks and engagement only instead of getting 0. Change the weights in `WEIGHTS` in `worker/src/dashboard.html`.

## One-click tracking from the dashboard

The dashboard has a **Start tracking** button that links WhatsApp, runs the sync and shows live progress, the pairing code (or QR), and the groups found. You don't need to open GitHub for daily use.

One-time setup, so the dashboard can start the GitHub job:

1. Create a fine-grained GitHub token: github.com/settings/personal-access-tokens/new. Choose *Only select repositories* (this repo), then under Repository permissions set **Actions: Read and write**. Pick a long expiry; when it expires the dashboard shows "Can't reach GitHub" and you add a new one the same way.
2. Add it to the Worker:

```bash
cd worker
npx wrangler secret put GH_TOKEN      # paste the token
npx wrangler secret put GH_REPO       # e.g. Sarthak-B/wa-community-tracker
npm run deploy
```

On the dashboard you can then: **Start tracking** (link WhatsApp + first sync), **Sync now**, **Choose groups**, **Pause**, and **Re-link WhatsApp**. Scheduled runs skip themselves while tracking is paused. Re-link pressed during a running sync is queued and starts right after it.

**Choose groups:** tick exactly the groups you want (unticking everything means nothing is tracked), or press **Automatic** to let the bot pick the community announcement groups itself. Automatic also picks up communities you join later.

## GitHub minutes

Private repos get 2,000 free Actions minutes a month. The job uses the Chrome already installed on GitHub's runner (no Chromium download) and usually takes 3–10 minutes, so 4 runs a day is roughly 400–1,200 minutes. With many groups each run can reach the 25-minute cap; check Settings → Billing if you add lots of groups or sync manually often.

## Limits and risks

- **Unofficial automation.** whatsapp-web.js drives WhatsApp Web. That goes against WhatsApp's terms, and WhatsApp can ban accounts for it. This bot only reads, never sends, so the risk is low but not zero. Each run also connects from a different GitHub server IP. Use a secondary admin number.
- **Read receipts** come from WhatsApp's message info and only for posts from the linked number. In very large groups, or for members who have read receipts turned off, WhatsApp shows fewer readers than actually read, so treat reads as a relative signal between communities.
- **Clicks** only count when the tracked link is used. WhatsApp link-preview fetches and bots are filtered out. "Unique" = distinct device/network per link (IP addresses are hashed, never stored), so people sharing one mobile-network IP with the same phone and browser can count once, and one person switching Wi-Fi/mobile data can count twice.
- **Members can't reply** in announcement-only groups, so "replies" there will mostly be 0. Reactions still work.
- If WhatsApp changes WhatsApp Web, update the library: `cd bot && npm install whatsapp-web.js@latest` and commit the lockfile.
- The "next automatic sync" time on the dashboard is worked out from the cron in the workflow. If you change the cron, change `nextScheduled()` in `worker/src/dashboard.html` too.

## Local testing

```bash
cd worker
printf 'ADMIN_PASSWORD=demo\nINGEST_TOKEN=test\nHASH_SALT=x\n' > .dev.vars
npx wrangler d1 execute wa_tracker --local --file=schema.sql
npx wrangler dev          # http://localhost:8787
```
