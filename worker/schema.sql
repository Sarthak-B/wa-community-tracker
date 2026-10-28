-- WhatsApp Community Tracker - D1 schema
-- Apply with:  npx wrangler d1 execute wa_tracker --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS communities (
  id            TEXT PRIMARY KEY,          -- short slug, used in links
  name          TEXT NOT NULL,
  wa_chat_id    TEXT UNIQUE,               -- WhatsApp announcement-group id (filled by the bot)
  member_count  INTEGER DEFAULT 0,
  wa_created_at INTEGER,                   -- when the community was made on WhatsApp (sent by the bot); orders the dashboard newest first
  created_at    INTEGER NOT NULL,          -- when the tracker first saw it
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  code          TEXT PRIMARY KEY,          -- the /<code> part of the short link
  community_id  TEXT NOT NULL,
  campaign      TEXT NOT NULL,
  destination   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER                    -- set when removed on the dashboard; old clicks stay in the stats
);
-- Existing databases get deleted_at added automatically by the Worker (ensureSchema).
CREATE INDEX IF NOT EXISTS idx_links_comm ON links(community_id);
CREATE INDEX IF NOT EXISTS idx_links_campaign ON links(campaign);

CREATE TABLE IF NOT EXISTS clicks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL,
  clicked_at    INTEGER NOT NULL,          -- unix seconds
  visitor_hash  TEXT NOT NULL,             -- salted hash of IP + user agent (no raw IPs stored)
  country       TEXT,
  device        TEXT,                      -- mobile / desktop
  is_bot        INTEGER DEFAULT 0          -- link-preview fetchers & crawlers, excluded from stats
);
CREATE INDEX IF NOT EXISTS idx_clicks_code ON clicks(code, clicked_at);
CREATE INDEX IF NOT EXISTS idx_clicks_time ON clicks(clicked_at);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,          -- WhatsApp message id
  community_id  TEXT NOT NULL,
  sent_at       INTEGER NOT NULL,
  body          TEXT,
  link_codes    TEXT DEFAULT '',           -- comma separated tracked-link codes found in the message
  delivered     INTEGER DEFAULT 0,
  reads         INTEGER DEFAULT 0,
  reactions     INTEGER DEFAULT 0,
  replies       INTEGER DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_comm ON messages(community_id, sent_at);

CREATE TABLE IF NOT EXISTS sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at        INTEGER NOT NULL,
  status        TEXT NOT NULL,             -- ok / logged_out / error
  groups        INTEGER DEFAULT 0,
  messages      INTEGER DEFAULT 0,
  note          TEXT
);

-- Settings and live bot status for the dashboard's Start tracking button
CREATE TABLE IF NOT EXISTS kv (
  key           TEXT PRIMARY KEY,
  value         TEXT,
  updated_at    INTEGER
);
