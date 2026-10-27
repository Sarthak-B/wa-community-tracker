// WhatsApp Community Tracker - Cloudflare Worker
//   GET  /                 dashboard
//   GET  /l/:code          tracked short link (logs click, redirects)
//   *    /api/...          dashboard API (Bearer ADMIN_PASSWORD)
//   POST /api/ingest       bot upload (Bearer INGEST_TOKEN)

import DASHBOARD_HTML from './dashboard.html';

const BOT_UA = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|twitter|linkedin|discord|skype|curl|wget|python|axios|node-fetch|go-http|headless|okhttp/i;
const CODE_RE = /\/l\/([A-Za-z0-9]{4,16})/g;
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
      if (path === '/health') return json({ ok: true });

      if (path === '/api/ingest' && request.method === 'POST') {
        if (!authorized(request, env.INGEST_TOKEN)) return json({ error: 'unauthorized' }, 401);
        return json(await ingest(await request.json(), env));
      }
      if (path.startsWith('/api/')) {
        if (!authorized(request, env.ADMIN_PASSWORD)) return json({ error: 'unauthorized' }, 401);
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
async function handleRedirect(code, request, env, ctx) {
  const link = await env.DB.prepare('SELECT destination FROM links WHERE code = ?').bind(code).first();
  if (!link) return new Response('This link does not exist.', { status: 404 });
  const ua = request.headers.get('user-agent') || '';
  const ip = request.headers.get('cf-connecting-ip') || '';
  const isBot = !ua || BOT_UA.test(ua) || request.method === 'HEAD';
  ctx.waitUntil((async () => {
    const visitor = await sha256(`${env.HASH_SALT || 'salt'}|${ip}|${ua}`);
    await env.DB.prepare('INSERT INTO clicks (code, clicked_at, visitor_hash, country, device, is_bot) VALUES (?,?,?,?,?,?)')
      .bind(code, now(), visitor, (request.cf && request.cf.country) || null, /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'desktop', isBot ? 1 : 0)
      .run();
  })());
  return Response.redirect(link.destination, 302);
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
  return { links: results };
}
async function createLinks(body, env, origin) {
  const campaign = String(body.campaign || '').trim();
  let destination = String(body.destination || '').trim();
  const ids = Array.isArray(body.community_ids) ? body.community_ids : [];
  if (!campaign) throw new Error('Campaign name is required');
  if (!/^https?:\/\//i.test(destination)) throw new Error('Destination must start with http:// or https://');
  if (!ids.length) throw new Error('Pick at least one community');
  const created = [];
  const stmts = [];
  for (const id of ids) {
    const comm = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(id).first();
    if (!comm) continue;
    const dest = new URL(destination);
    if (body.add_utm !== false) {
      dest.searchParams.set('utm_source', 'whatsapp');
      dest.searchParams.set('utm_medium', 'community');
      dest.searchParams.set('utm_campaign', slugify(campaign));
      dest.searchParams.set('utm_content', comm.id);
    }
    const code = randomCode();
    stmts.push(env.DB.prepare('INSERT INTO links (code, community_id, campaign, destination, created_at) VALUES (?,?,?,?,?)')
      .bind(code, comm.id, campaign, dest.toString(), now()));
    created.push({ code, community_id: comm.id, community: comm.name, short_url: `${origin}/l/${code}`, destination: dest.toString() });
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { campaign, links: created };
}

// ---------- bot ingest ----------
async function ingest(body, env) {
  const t = now();
  const chatToCommunity = {};
  for (const c of body.communities || []) {
    if (!c.wa_chat_id || !c.name) continue;
    let row = await env.DB.prepare('SELECT id FROM communities WHERE wa_chat_id = ?').bind(c.wa_chat_id).first();
    if (!row) row = await env.DB.prepare('SELECT id FROM communities WHERE lower(name) = lower(?) AND wa_chat_id IS NULL').bind(c.name).first();
    if (row) {
      await env.DB.prepare('UPDATE communities SET wa_chat_id = ?, member_count = ?, updated_at = ? WHERE id = ?')
        .bind(c.wa_chat_id, Number(c.members) || 0, t, row.id).run();
      chatToCommunity[c.wa_chat_id] = row.id;
    } else {
      const id = await uniqueSlug(env, slugify(c.name));
      await env.DB.prepare('INSERT INTO communities (id, name, wa_chat_id, member_count, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .bind(id, c.name, c.wa_chat_id, Number(c.members) || 0, t, t).run();
      chatToCommunity[c.wa_chat_id] = id;
    }
  }

  const known = new Set((await env.DB.prepare('SELECT code FROM links').all()).results.map(r => r.code));
  const stmts = [];
  for (const m of body.messages || []) {
    const communityId = chatToCommunity[m.wa_chat_id];
    if (!communityId || !m.id) continue;
    const codes = [...new Set([...String(m.body || '').matchAll(CODE_RE)].map(x => x[1]).filter(c => known.has(c)))];
    stmts.push(env.DB.prepare(`
      INSERT INTO messages (id, community_id, sent_at, body, link_codes, delivered, reads, reactions, replies, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        body = excluded.body, link_codes = excluded.link_codes,
        delivered = MAX(messages.delivered, excluded.delivered), reads = MAX(messages.reads, excluded.reads),
        reactions = excluded.reactions, replies = MAX(messages.replies, excluded.replies), updated_at = excluded.updated_at`)
      .bind(m.id, communityId, Number(m.sent_at) || t, String(m.body || '').slice(0, 2000), codes.join(','),
        Number(m.delivered) || 0, Number(m.reads) || 0, Number(m.reactions) || 0, Number(m.replies) || 0, t));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await env.DB.prepare('INSERT INTO sync_runs (ran_at, status, groups, messages, note) VALUES (?,?,?,?,?)')
    .bind(t, String(body.status || 'ok'), (body.communities || []).length, stmts.length, body.note ? String(body.note).slice(0, 500) : null).run();
  return { ok: true, communities: Object.keys(chatToCommunity).length, messages: stmts.length };
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
