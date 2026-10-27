# WhatsApp Community Tracker

Tracks every message we post to our WhatsApp communities and ranks the communities from best to weakest:

| Number | Where it comes from |
|---|---|
| Messages sent, reads, delivered | WhatsApp "Message info", read by the bot every 3 hours |
| Replies & reactions | Read by the bot (replies = messages that quote ours) |
| Link clicks | Our own short links (`/l/abc123`), one per community, counted when clicked |
| Members | Group size, read by the bot |

Everything runs on free tiers: a **Cloudflare Worker + D1 database** (short links, API, dashboard) and a **GitHub Actions** job (the WhatsApp reader).

```
 GitHub Actions (every 3h)                 Cloudflare Worker (always on)
 ┌─────────────────────────┐   upload    ┌──────────────────────────────┐
 │ bot/  whatsapp-web.js   │ ──────────▶ │ /api/ingest   -> D1 database │
 │ reads our sent messages │             │ /l/<code>     -> logs click, │
 │ reads, reactions, replies│            │                 redirects    │
 └─────────────────────────┘             │ /             -> dashboard   │
                                         └──────────────────────────────┘
```

---

## 1. Deploy the Worker (one time, ~10 min)

You need a free Cloudflare account and Node.js 20+.

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create wa_tracker          # copy the database_id it prints
```

Paste that id into `worker/wrangler.toml` (`database_id = "..."`), then:

```bash
npm run db:init                            # creates the tables
npx wrangler secret put ADMIN_PASSWORD     # dashboard password
npx wrangler secret put INGEST_TOKEN       # long random string, the bot uses it
npx wrangler secret put HASH_SALT          # any random string
npm run deploy
```

It prints your URL, e.g. `https://wa-community-tracker.<you>.workers.dev`. Open it and log in.

**Use our own domain for links (recommended):** short links like `go.flexifunnels.com/l/abc123` get more clicks than `workers.dev` ones. If flexifunnels.com is on Cloudflare, uncomment the `routes` line in `wrangler.toml` and deploy again.

Generate random strings with: `openssl rand -hex 24`

## 2. Set up the GitHub repo

1. Push this folder to a **private** GitHub repo.
2. Settings → Secrets and variables → Actions → **Secrets**:
   - `TRACKER_URL`: the Worker URL from step 1 (no trailing slash)
   - `INGEST_TOKEN`: same value you set on the Worker
   - `SESSION_KEY`: another random string (encrypts the saved WhatsApp login)
3. Optional, same page → **Variables**:
   - `LOOKBACK_DAYS`: how many days back to re-check messages (default 14; read counts keep rising for a few days)
   - `GROUP_NAME_FILTER`: only if auto-detection misses your communities. A regex on group names, e.g. `FlexiFunnels|Creators|Course Sellers`

## 3. Link the WhatsApp account (one time)

Use an account that is an **admin in every community**. We recommend a second admin number rather than the main business number (see Risks below).

1. GitHub → Actions → **WhatsApp community sync** → Run workflow
2. mode = `login`, pair_phone = the number with country code, digits only (e.g. `919876543210`)
3. Open the running job's log. Within about a minute it prints **PAIRING CODE: XXXX-XXXX**
4. On that phone: WhatsApp → Settings → Linked devices → Link a device → *Link with phone number instead* → enter the code
5. The job waits 60 s, then saves the encrypted session. Done.

From now on it runs every 3 hours by itself. Run it manually with mode = `sync` to test straight away. The log lists every group found, with `*` next to the tracked ones.

If the dashboard ever shows **"WhatsApp logged out"**, repeat step 3. WhatsApp also unlinks all linked devices if the main phone itself is not used for about 14 days, so keep that phone active.

## 4. Daily use

1. Dashboard → **Link builder** → campaign name + destination URL → tick the communities → **Create links**
2. Paste each community's own link into the message for that community (**Copy all** gives you a list)
3. Post as usual. Clicks count immediately; reads/replies appear after the next sync.

Tabs:
- **Community leaderboard**: ranks communities by overall score, clicks, click rate, read rate or engagement. Top 3 get a green badge; the bottom 2 are flagged "Needs attention".
- **Campaigns**: the same post across communities side by side, with the best and weakest community for each campaign.
- **Messages**: every message we sent, with reads, reactions, replies and clicks.

### How the score works
Overall score = 50% clicks per 100 members + 30% read rate + 20% (replies + reactions) per 100 members. Each part is compared to the best community (best = 100). Per-member rates keep a 600-member community comparable with a 3,000-member one.

## Limits and risks

- **Unofficial automation.** whatsapp-web.js drives WhatsApp Web. That goes against WhatsApp's terms, and WhatsApp can ban accounts for it. This bot only reads, never sends, so the risk is low but not zero. Use a secondary admin number.
- **Read receipts** come from WhatsApp's message info. In very large groups, or for members who have read receipts turned off, WhatsApp shows fewer readers than actually read, so treat reads as a relative signal between communities.
- **Clicks** only count when the tracked link is used. WhatsApp link-preview fetches and bots are filtered out. "Unique" = distinct device/network per link (IP addresses are hashed, never stored).
- **Members can't reply** in announcement-only groups, so "replies" there will mostly be 0. Reactions still work.
- If WhatsApp changes WhatsApp Web, update the library: `cd bot && npm install whatsapp-web.js@latest` and commit the lockfile.

## Local testing

```bash
cd worker
printf 'ADMIN_PASSWORD=demo\nINGEST_TOKEN=test\nHASH_SALT=x\n' > .dev.vars
npx wrangler d1 execute wa_tracker --local --file=schema.sql
npx wrangler dev          # http://localhost:8787
```
