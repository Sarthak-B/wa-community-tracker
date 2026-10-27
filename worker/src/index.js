// WhatsApp Community Tracker - Cloudflare Worker
//   GET  /                 dashboard
//   GET  /l/:code          tracked short link (logs click, redirects)
//   *    /api/...          dashboard API (Bearer ADMIN_PASSWORD)
//   POST /api/ingest       bot upload (Bearer INGEST_TOKEN)

import DASHBOARD_HTML from './dashboard.html';

const BOT_UA = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|twitter|linkedin|discord|skype|curl|wget|python|axios|node-fetch|go-http|headless|okhttp/i;
// matches both link styles: tracker.../l/CODE and yourpage.com/...?wa=CODE
// finds link codes in message text (tracker.../CODE, tracker.../l/CODE or ?wa=CODE); only known codes are kept
const CODE_RE = /(?:\/l\/|\/|[?&]wa=)([A-Za-z0-9][A-Za-z0-9-]{2,63})/g;
const RESERVED = new Set(['dashboard', 'health', 'h', 't.js', 'api', 'l', 'favicon.ico', 'robots.txt']);
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
const now = () => Math.floor(Date.now() / 1000);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/' || path === '/dashboard') {
        return new Response(DASHBOARD_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      if (path.startsWith('/l/')) return handleRedirect(path.slice(3), request, env, ctx);
      if (path === '/h') return handleHit(url.searchParams.get('c') || '', request, env, ctx);
      if (path === '/t.js') return new Response(trackingScript(url.origin), { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });
      if (path === '/health') return json({ ok: true });
      if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      // short links: /<page-slug>-<tag>  e.g. /funnel-agent-access-k7
      if (/^\/[A-Za-z0-9][A-Za-z0-9-]{2,63}$/.test(path) && !RESERVED.has(path.slice(1))) return handleRedirect(path.slice(1), request, env, ctx);

      if (path === '/api/ingest' && request.method === 'POST') {
        if (!authorized(request, env.INGEST_TOKEN)) return json({ error: 'unauthorized' }, 401);
        return json(await ingest(await request.json(), env));
      }
      // --- endpoints the bot calls ---
      if (path.startsWith('/api/bot/')) {
        if (!authorized(request, env.INGEST_TOKEN)) return json({ error: 'unauthorized' }, 401);
        if (path === '/api/bot/config' && request.method === 'GET') {
          const { results } = await env.DB.prepare('SELECT wa_chat_id, updated_at FROM communities WHERE wa_chat_id IS NOT NULL').all();
          return json({ ...(await getConfig(env)), last_read: Object.fromEntries(results.map(r => [r.wa_chat_id, r.updated_at])) });
        }
        if (path === '/api/bot/status' && request.method === 'POST') return json(await botStatus(await request.json(), env));
        return json({ error: 'not found' }, 404);
      }
      if (path.startsWith('/api/')) {
        if (!authorized(request, env.ADMIN_PASSWORD)) return json({ error: 'unauthorized' }, 401);
        // --- one-click tracking control ---
        if (path === '/api/tracking' && request.method === 'GET') return json(await trackingState(env));
        if (path === '/api/tracking/start' && request.method === 'POST') return json(await startTracking(await request.json(), env));
        if (path === '/api/tracking/pause' && request.method === 'POST') return json(await setConfig(env, { enabled: false }));
        if (path === '/api/tracking/groups' && request.method === 'POST') {
          const b = await request.json();
          return json(await setConfig(env, { tracked_ids: Array.isArray(b.tracked_ids) && b.tracked_ids.length ? b.tracked_ids : null }));
        }
        if (path === '/api/stats' && request.method === 'GET') return json(await stats(url, env));
        if (path === '/api/communities' && request.method === 'GET') return json(await listCommunities(env));
        if (path === '/api/communities' && request.method === 'POST') return json(await addCommunity(await request.json(), env));
        if (path === '/api/links' && request.method === 'GET') return json(await listLinks(env));
        if (path === '/api/links' && request.method === 'POST') return json(await createLinks(await request.json(), env, url.origin));
        if (path.startsWith('/api/links/') && request.method === 'DELETE') {
          await env.DB.prepare('DELETE FROM links WHERE code = ?').bind(path.split('/').pop()).run();
          return json({ ok: true });
        }
        return json({ error: 'not found' }, 404);
      }
      return new Response('Not found', { status: 404 });
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

// ---------- helpers ----------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function authorized(request, secret) {
  if (!secret) return false;
  const h = request.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'community';
}
function randomCode(len = 6) {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => abc[b % abc.length]).join('');
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}
async function uniqueSlug(env, base) {
  let slug = base, n = 2;
  while (await env.DB.prepare('SELECT 1 FROM communities WHERE id = ?').bind(slug).first()) slug = `${base}-${n++}`;
  return slug;
}

// ---------- short links ----------
function logClick(code, request, env, ctx) {
  const ua = request.headers.get('user-agent') || '';
  const ip = request.headers.get('cf-connecting-ip') || '';
  const isBot = !ua || BOT_UA.test(ua) || request.method === 'HEAD';
  ctx.waitUntil((async () => {
    const visitor = await sha256(`${env.HASH_SALT || 'salt'}|${ip}|${ua}`);
    await env.DB.prepare('INSERT INTO clicks (code, clicked_at, visitor_hash, country, device, is_bot) VALUES (?,?,?,?,?,?)')
      .bind(code, now(), visitor, (request.cf && request.cf.country) || null, /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'desktop', isBot ? 1 : 0)
      .run();
  })());
}

// Short redirect links: tracker/l/CODE -> logs the click, then sends the visitor on
// Never shows an error to a visitor: unknown/deleted links and database hiccups go to FALLBACK_URL.
async function handleRedirect(code, request, env, ctx) {
  const fallback = env.FALLBACK_URL || 'https://sb.flexifunnels.com';
  let link = null;
  try { link = await env.DB.prepare('SELECT destination FROM links WHERE code = ?').bind(code).first(); }
  catch (e) { return Response.redirect(fallback, 302); }
  if (!link) return Response.redirect(fallback, 302);
  try { logClick(code, request, env, ctx); } catch (e) {}
  return new Response(null, { status: 302, headers: { location: link.destination, 'cache-control': 'no-store' } });
}

// Direct links: yourpage.com/...?wa=CODE. The tracking snippet on the page calls /h?c=CODE.
// Link previews don't run page scripts, so they are never counted.
async function handleHit(code, request, env, ctx) {
  const headers = { 'content-type': 'image/gif', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (/^[A-Za-z0-9]{4,16}$/.test(code)) {
    const link = await env.DB.prepare('SELECT code FROM links WHERE code = ?').bind(code).first();
    if (link) logClick(code, request, env, ctx);
  }
  return new Response(GIF, { headers });
}

function trackingScript(origin) {
  return `(function(){try{var c=new URLSearchParams(location.search).get('wa');if(!c||!/^[A-Za-z0-9]{4,16}$/.test(c))return;var k='wa_hit_'+c;try{if(sessionStorage.getItem(k))return;sessionStorage.setItem(k,'1')}catch(e){}new Image().src='${origin}/h?c='+c+'&t='+Date.now()}catch(e){}})();`;
}

// ---------- communities & links ----------
async function listCommunities(env) {
  const { results } = await env.DB.prepare('SELECT id, name, wa_chat_id, member_count, updated_at FROM communities ORDER BY name').all();
  return { communities: results };
}
async function addCommunity(body, env) {
  const name = String(body.name || '').trim();
  if (!name) throw new Error('Community name is required');
  const existing = await env.DB.prepare('SELECT id FROM communities WHERE lower(name) = lower(?)').bind(name).first();
  if (existing) return { id: existing.id, existed: true };
  const id = await uniqueSlug(env, slugify(name));
  await env.DB.prepare('INSERT INTO communities (id, name, member_count, created_at, updated_at) VALUES (?,?,?,?,?)')
    .bind(id, name, Number(body.member_count) || 0, now(), now()).run();
  return { id };
}
async function listLinks(env) {
  const { results } = await env.DB.prepare(`
    SELECT l.code, l.community_id, c.name AS community, l.campaign, l.destination, l.created_at,
           COUNT(k.id) AS clicks, COUNT(DISTINCT k.visitor_hash) AS unique_clicks
    FROM links l
    LEFT JOIN communities c ON c.id = l.community_id
    LEFT JOIN clicks k ON k.code = l.code AND k.is_bot = 0
    GROUP BY l.code ORDER BY l.created_at DESC, c.name LIMIT 1000`).all();
  return { links: results, short_base: shortBase(env, null) };
}
function shortBase(env, origin) { return (env.SHORT_BASE || origin || '').replace(/\/+$/, ''); }
async function createLinks(body, env, origin) {
  const campaign = String(body.campaign || '').trim();
  let destination = String(body.destination || '').trim();
  const ids = Array.isArray(body.community_ids) ? body.community_ids : [];
  if (!campaign) throw new Error('Campaign name is required');
  if (!/^https?:\/\//i.test(destination)) throw new Error('Destination must start with http:// or https://');
  if (!ids.length) throw new Error('Pick at least one community');
  const created = [];
  const stmts = [];
  const comms = new Map((await env.DB.prepare('SELECT id, name FROM communities').all()).results.map(r => [r.id, r]));
  const taken = new Set((await env.DB.prepare('SELECT code FROM links').all()).results.map(r => r.code.toLowerCase()));
  // short link = last part of the page address + a 2-3 character tag per community
  const pageSlug = (new URL(destination).pathname.split('/').filter(Boolean).pop() || '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const tagChars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const newCode = () => {
    for (let len = 2; len <= 6; len++) for (let tries = 0; tries < 30; tries++) {
      const tag = Array.from(crypto.getRandomValues(new Uint8Array(len)), b => tagChars[b % tagChars.length]).join('');
      const c = pageSlug ? `${pageSlug}-${tag}` : tag + randomCode(3).toLowerCase();
      if (!taken.has(c) && !RESERVED.has(c)) { taken.add(c); return c; }
    }
    return randomCode(8);
  };
  const base = shortBase(env, origin);
  for (const id of ids) {
    const comm = comms.get(id);
    if (!comm) continue;
    const dest = new URL(destination);
    const direct = body.style === 'direct';
    if (body.add_utm !== false && !direct) {
      dest.searchParams.set('utm_source', 'whatsapp');
      dest.searchParams.set('utm_medium', 'community');
      dest.searchParams.set('utm_campaign', slugify(campaign));
      dest.searchParams.set('utm_content', comm.id);
    }
    const code = direct ? randomCode(5) : newCode();
    if (direct) dest.searchParams.set('wa', code);
    stmts.push(env.DB.prepare('INSERT INTO links (code, community_id, campaign, destination, created_at) VALUES (?,?,?,?,?)')
      .bind(code, comm.id, campaign, dest.toString(), now()));
    created.push({ code, community_id: comm.id, community: comm.name, short_url: direct ? dest.toString() : `${base}/${code}`, destination: dest.toString(), direct });
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { campaign, links: created };
}

// ---------- bot ingest ----------
async function ingest(body, env) {
  // Uses as few database calls as possible (Cloudflare's free plan allows ~50 per request).
  const t = now();
  const all = (await env.DB.prepare('SELECT id, name, wa_chat_id FROM communities').all()).results;
  const byChat = new Map(all.filter(r => r.wa_chat_id).map(r => [r.wa_chat_id, r.id]));
  const byName = new Map(all.filter(r => !r.wa_chat_id).map(r => [String(r.name).toLowerCase(), r.id]));
  const usedIds = new Set(all.map(r => r.id));
  const chatToCommunity = {};
  const commStmts = [];
  for (const c of body.communities || []) {
    if (!c.wa_chat_id || !c.name || chatToCommunity[c.wa_chat_id]) continue;
    let id = byChat.get(c.wa_chat_id) || byName.get(String(c.name).toLowerCase());
    if (id) {
      byName.delete(String(c.name).toLowerCase());
      commStmts.push(env.DB.prepare('UPDATE communities SET wa_chat_id = ?, member_count = ?, updated_at = ? WHERE id = ?')
        .bind(c.wa_chat_id, Number(c.members) || 0, t, id));
    } else {
      const base = slugify(c.name); id = base; let n = 2;
      while (usedIds.has(id)) id = `${base}-${n++}`;
      usedIds.add(id);
      commStmts.push(env.DB.prepare('INSERT INTO communities (id, name, wa_chat_id, member_count, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .bind(id, c.name, c.wa_chat_id, Number(c.members) || 0, t, t));
    }
    chatToCommunity[c.wa_chat_id] = id;
  }

  const known = new Set((await env.DB.prepare('SELECT code FROM links').all()).results.map(r => r.code));
  const msgStmts = [];
  for (const m of body.messages || []) {
    const communityId = chatToCommunity[m.wa_chat_id] || byChat.get(m.wa_chat_id);
    if (!communityId || !m.id) continue;
    const codes = [...new Set([...String(m.body || '').matchAll(CODE_RE)].map(x => x[1]).filter(c => known.has(c)))];
    msgStmts.push(env.DB.prepare(`
      INSERT INTO messages (id, community_id, sent_at, body, link_codes, delivered, reads, reactions, replies, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        body = excluded.body, link_codes = excluded.link_codes,
        delivered = MAX(messages.delivered, excluded.delivered), reads = MAX(messages.reads, excluded.reads),
        reactions = excluded.reactions, replies = MAX(messages.replies, excluded.replies), updated_at = excluded.updated_at`)
      .bind(m.id, communityId, Number(m.sent_at) || t, String(m.body || '').slice(0, 2000), codes.join(','),
        Number(m.delivered) || 0, Number(m.reads) || 0, Number(m.reactions) || 0, Number(m.replies) || 0, t));
  }
  const stmts = [...commStmts, ...msgStmts];
  if (!body.partial) {
    const totals = body.totals || {};
    stmts.push(env.DB.prepare('INSERT INTO sync_runs (ran_at, status, groups, messages, note) VALUES (?,?,?,?,?)')
      .bind(t, String(body.status || 'ok'), Number(totals.groups ?? (body.communities || []).length), Number(totals.messages ?? msgStmts.length),
        body.note ? String(body.note).slice(0, 500) : (body.summary ? String(body.summary).slice(0, 500) : null)));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  const result = { ok: true, communities: Object.keys(chatToCommunity).length, messages: msgStmts.length,
    received_messages: (body.messages || []).length, saved_in_db: (await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).n,
    sample: (body.messages || [])[0] ? { id: String(body.messages[0].id).slice(0, 80), wa_chat_id: body.messages[0].wa_chat_id, known_group: !!(chatToCommunity[body.messages[0].wa_chat_id] || byChat.get(body.messages[0].wa_chat_id)) } : null };
  await kvSet(env, 'last_ingest', { at: t, partial: !!body.partial, ...result });
  return result;
}

// ---------- stats ----------
async function stats(url, env) {
  const days = Number(url.searchParams.get('days') || 30);
  const from = days > 0 ? now() - days * 86400 : 0;
  const tz = `${Number(env.TZ_OFFSET_MINUTES || 330)} minutes`;
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then(r => r.results);

  const [communities, msgAgg, clickAgg, linkAgg, links, codeClicks, messages, dailyClicks, dailyMsgs, lastSync] = await Promise.all([
    q('SELECT id, name, member_count, wa_chat_id FROM communities'),
    q(`SELECT community_id, COUNT(*) AS messages, SUM(delivered) AS delivered, SUM(reads) AS reads,
              SUM(reactions) AS reactions, SUM(replies) AS replies
       FROM messages WHERE sent_at >= ? GROUP BY community_id`, from),
    q(`SELECT l.community_id, COUNT(*) AS clicks, COUNT(DISTINCT k.visitor_hash) AS unique_clicks
       FROM clicks k JOIN links l ON l.code = k.code
       WHERE k.is_bot = 0 AND k.clicked_at >= ? GROUP BY l.community_id`, from),
    q('SELECT community_id, COUNT(*) AS links FROM links WHERE created_at >= ? GROUP BY community_id', from),
    q('SELECT code, community_id, campaign, created_at FROM links'),
    q(`SELECT code, COUNT(*) AS clicks, COUNT(DISTINCT visitor_hash) AS unique_clicks
       FROM clicks WHERE is_bot = 0 AND clicked_at >= ? GROUP BY code`, from),
    q('SELECT * FROM messages WHERE sent_at >= ? ORDER BY sent_at DESC LIMIT 1000', from),
    q(`SELECT date(k.clicked_at, 'unixepoch', ?) AS day, l.community_id, COUNT(*) AS clicks
       FROM clicks k JOIN links l ON l.code = k.code
       WHERE k.is_bot = 0 AND k.clicked_at >= ? GROUP BY day, l.community_id ORDER BY day`, tz, from),
    q(`SELECT date(sent_at, 'unixepoch', ?) AS day, COUNT(*) AS messages, SUM(reads) AS reads
       FROM messages WHERE sent_at >= ? GROUP BY day ORDER BY day`, tz, from),
    env.DB.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').first(),
  ]);

  const byId = Object.fromEntries(communities.map(c => [c.id, {
    id: c.id, name: c.name, members: c.member_count || 0, connected: !!c.wa_chat_id,
    messages: 0, delivered: 0, reads: 0, reactions: 0, replies: 0, clicks: 0, unique_clicks: 0, links: 0,
  }]));
  for (const r of msgAgg) Object.assign(byId[r.community_id] || {}, { messages: r.messages, delivered: r.delivered || 0, reads: r.reads || 0, reactions: r.reactions || 0, replies: r.replies || 0 });
  for (const r of clickAgg) Object.assign(byId[r.community_id] || {}, { clicks: r.clicks, unique_clicks: r.unique_clicks });
  for (const r of linkAgg) if (byId[r.community_id]) byId[r.community_id].links = r.links;

  // campaign x community matrix
  const linkMap = Object.fromEntries(links.map(l => [l.code, l]));
  const clickMap = Object.fromEntries(codeClicks.map(c => [c.code, c]));
  const camp = {};
  const cell = (campaign, cid) => {
    camp[campaign] ??= { campaign, created_at: Infinity, cells: {} };
    return (camp[campaign].cells[cid] ??= { clicks: 0, unique_clicks: 0, reads: 0, messages: 0 });
  };
  for (const l of links) {
    const c = clickMap[l.code];
    if (l.created_at < from && !c) continue;
    const x = cell(l.campaign, l.community_id);
    camp[l.campaign].created_at = Math.min(camp[l.campaign].created_at, l.created_at);
    if (c) { x.clicks += c.clicks; x.unique_clicks += c.unique_clicks; }
  }

  const msgOut = messages.map(m => {
    const codes = m.link_codes ? m.link_codes.split(',') : [];
    let clicks = 0, unique = 0, campaign = null;
    for (const code of codes) {
      const c = clickMap[code];
      if (c) { clicks += c.clicks; unique += c.unique_clicks; }
      if (linkMap[code]) {
        campaign = campaign || linkMap[code].campaign;
        const x = cell(linkMap[code].campaign, m.community_id);
        x.reads += m.reads; x.messages += 1;
      }
    }
    return { id: m.id, community_id: m.community_id, sent_at: m.sent_at, body: m.body, campaign,
      delivered: m.delivered, reads: m.reads, reactions: m.reactions, replies: m.replies, clicks, unique_clicks: unique };
  });

  return {
    days, generated_at: now(), last_sync: lastSync || null,
    communities: Object.values(byId),
    campaigns: Object.values(camp).sort((a, b) => b.created_at - a.created_at),
    messages: msgOut,
    daily_clicks: dailyClicks,
    daily_messages: dailyMsgs,
  };
}

// ---------- one-click tracking: settings, bot status, GitHub control ----------
let kvReady = false;
async function kvTable(env) {
  if (kvReady) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)').run();
  kvReady = true;
}
async function kvGet(env, key, fallback = null) {
  await kvTable(env);
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
async function kvSet(env, key, value) {
  await kvTable(env);
  await env.DB.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), now()).run();
}

const DEFAULT_CONFIG = { enabled: false, tracked_ids: null, phone: '', lookback_days: 14 };
async function getConfig(env) { return { ...DEFAULT_CONFIG, ...(await kvGet(env, 'config', {})) }; }
async function setConfig(env, patch) {
  const cfg = { ...(await getConfig(env)), ...patch };
  await kvSet(env, 'config', cfg);
  return { ok: true, config: cfg };
}

async function botStatus(body, env) {
  const status = {
    stage: String(body.stage || 'unknown'),
    message: body.message ? String(body.message).slice(0, 500) : '',
    mode: body.mode || null,
    code: body.code || null,
    qr: body.qr || null,
    progress: body.progress || null,
    run_id: body.run_id || null,
    at: now(),
  };
  await kvSet(env, 'bot_status', status);
  if (status.stage === 'connected' || status.stage === 'done') await kvSet(env, 'linked', { linked: true, at: now() });
  if (status.stage === 'logged_out') await kvSet(env, 'linked', { linked: false, at: now() });
  if (Array.isArray(body.groups)) {
    await kvSet(env, 'groups', {
      at: now(),
      list: body.groups.slice(0, 500).map(g => ({ id: String(g.id), name: String(g.name || ''), members: Number(g.members) || 0, auto: !!g.auto, tracked: !!g.tracked })),
    });
  }
  return { ok: true };
}

function github(env) {
  if (!env.GH_TOKEN || !env.GH_REPO) return null;
  const base = (env.GH_API || 'https://api.github.com') + '/repos/' + env.GH_REPO + '/actions/workflows/' + (env.GH_WORKFLOW || 'whatsapp-sync.yml');
  const headers = {
    authorization: 'Bearer ' + env.GH_TOKEN,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'wa-community-tracker',
    'content-type': 'application/json',
  };
  return {
    async latestRun() {
      const res = await fetch(base + '/runs?per_page=1', { headers });
      if (!res.ok) throw new Error(`GitHub said ${res.status} when reading runs. Check GH_TOKEN and GH_REPO.`);
      const run = ((await res.json()).workflow_runs || [])[0];
      return run ? { id: run.id, status: run.status, conclusion: run.conclusion, event: run.event, html_url: run.html_url,
        created_at: Math.floor(Date.parse(run.created_at) / 1000), updated_at: Math.floor(Date.parse(run.updated_at) / 1000) } : null;
    },
    async dispatch(inputs) {
      const res = await fetch(base + '/dispatches', { method: 'POST', headers, body: JSON.stringify({ ref: env.GH_BRANCH || 'main', inputs }) });
      if (res.status !== 204) throw new Error(`GitHub refused to start the run (${res.status}): ${(await res.text()).slice(0, 200)}`);
    },
  };
}

async function trackingState(env) {
  const [config, status, groups, linked] = await Promise.all([
    getConfig(env), kvGet(env, 'bot_status'), kvGet(env, 'groups', { at: null, list: [] }), kvGet(env, 'linked', { linked: false }),
  ]);
  const gh = github(env);
  let run = null, run_error = null;
  if (gh) { try { run = await gh.latestRun(); } catch (e) { run_error = e.message; } }
  const lastSync = await env.DB.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').first();
  return { configured: !!gh, config: { ...config, phone: config.phone ? config.phone.replace(/\d(?=\d{4})/g, '•') : '' },
    status, groups, linked: !!linked.linked, run, run_error, last_sync: lastSync || null };
}

async function startTracking(body, env) {
  const gh = github(env);
  if (!gh) throw new Error('The Start button is not connected to GitHub yet. Add the GH_TOKEN and GH_REPO secrets to the Worker (see the setup guide).');
  const run = await gh.latestRun();
  if (run && run.status !== 'completed') return { ok: true, already_running: true, run };

  const cfg = await getConfig(env);
  const action = body.action === 'link' ? 'link' : 'sync';
  let phone = String(body.phone || '').replace(/\D/g, '');
  if (action === 'link' && !phone && body.use_saved_phone !== false) phone = cfg.phone;
  await setConfig(env, { enabled: true, ...(phone ? { phone } : {}) });

  await gh.dispatch(action === 'link' ? { mode: 'login', pair_phone: phone } : { mode: 'sync' });
  await kvSet(env, 'bot_status', { stage: 'queued', mode: action === 'link' ? 'login' : 'sync', message: '', at: now() });
  return { ok: true, started: action };
}
