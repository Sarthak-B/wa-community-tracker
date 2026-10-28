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
    // Running on your real site's address (e.g. sb.flexifunnels.com, see SITE_HOSTS): only tracked links are
    // handled here, everything else goes straight through to FlexiFunnels untouched.
    if (siteHosts(env).has(url.hostname.toLowerCase())) return handleSiteRequest(request, url, env, ctx);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (env.DB && path !== '/' && path !== '/dashboard' && path !== '/t.js' && path !== '/health') await ensureSchema(env);
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
          const q = await env.DB.prepare("SELECT COUNT(*) AS n FROM sends WHERE status = 'queued'").first();
          return json({ ...(await getConfig(env)), queued_sends: q ? q.n : 0, last_read: Object.fromEntries(results.map(r => [r.wa_chat_id, r.updated_at])) });
        }
        if (path === '/api/bot/status' && request.method === 'POST') return json(await botStatus(await request.json(), env));
        if (path === '/api/bot/sends' && request.method === 'GET') return json(await botSends(env));
        if (path === '/api/bot/sends/continue' && request.method === 'POST') return json(await continueSends(env));
        if (path === '/api/bot/sends/pause' && request.method === 'POST') return json(await pauseSends(await request.json(), env));
        if (/^\/api\/bot\/sends\/\d+$/.test(path) && request.method === 'POST') return json(await botSendUpdate(Number(path.split('/').pop()), await request.json(), env));
        if (path.startsWith('/api/bot/media/') && request.method === 'GET') return mediaResponse(decodeURIComponent(path.split('/').pop()), env);
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
          // automatic = null (bot picks community groups itself); otherwise exactly the ticked groups, even none
          return json(await setConfig(env, { tracked_ids: b.automatic ? null : (Array.isArray(b.tracked_ids) ? b.tracked_ids.map(String) : []) }));
        }
        if (path === '/api/stats' && request.method === 'GET') return json(await stats(url, env));
        if (path === '/api/live' && request.method === 'GET') return json(await live(url, env));
        if (path === '/api/communities' && request.method === 'GET') return json(await listCommunities(env));
        if (path === '/api/communities' && request.method === 'POST') return json(await addCommunity(await request.json(), env));
        if (path === '/api/links' && request.method === 'GET') return json(await listLinks(env));
        if (path === '/api/links' && request.method === 'POST') return json(await createLinks(await request.json(), env, url.origin));
        if (path.startsWith('/api/links/') && request.method === 'DELETE') {
          // "Hide": only removes the link from the dashboard list. It KEEPS WORKING for anyone who has it,
          // because it may already be posted in a community. Its clicks stay in the stats.
          await env.DB.prepare('UPDATE links SET deleted_at = ? WHERE code = ?').bind(now(), decodeURIComponent(path.split('/').pop())).run();
          return json({ ok: true });
        }
        // --- message composer & sending ---
        if (path === '/api/media' && request.method === 'POST') return json(await uploadMedia(request, env));
        if (path === '/api/compose' && request.method === 'POST') return json(await compose(await request.json(), env, url.origin));
        if (path === '/api/sends' && request.method === 'GET') return json(await listSends(url, env));
        if (path === '/api/sends/start' && request.method === 'POST') return json(await startSends(await request.json(), env));
        if (path === '/api/sends/cancel' && request.method === 'POST') return json(await cancelSends(await request.json(), env));
        if (path === '/api/sends/mark' && request.method === 'POST') return json(await markSend(await request.json(), env));
        if (path.startsWith('/api/media/') && request.method === 'GET') return mediaResponse(decodeURIComponent(path.split('/').pop()), env);
        if (/^\/api\/links\/[^/]+\/unhide$/.test(path) && request.method === 'POST') {
          await env.DB.prepare('UPDATE links SET deleted_at = NULL WHERE code = ?').bind(decodeURIComponent(path.split('/')[3])).run();
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
  const h = request.headers.get('authorization') || '';
  return authorizedValue(h.startsWith('Bearer ') ? h.slice(7) : '', secret);
}
function authorizedValue(token, secret) {
  if (!secret) return false;
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
// ---------- community age (newest first everywhere) ----------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "18 OCT 2026 | 7:30 PM - 10 Minute Webinar" -> unix seconds for 18 Oct 2026 (IST midnight); null if no date in the name
function dateFromName(name) {
  const m = /(\d{1,2})\s*[-\/ ]?\s*([A-Za-z]{3})[A-Za-z]*\.?\s*[-\/ ,]?\s*(20\d{2})/.exec(String(name || ''));
  if (!m || MONTHS[m[2].toLowerCase()] == null) return null;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  return Math.floor(Date.UTC(Number(m[3]), MONTHS[m[2].toLowerCase()], day) / 1000) - 330 * 60;
}
// best known "born" date: WhatsApp creation date > date in the group name > first time the tracker saw it
function communityBorn(c) {
  if (c.wa_created_at) return { born: c.wa_created_at, born_source: 'whatsapp' };
  const d = dateFromName(c.name);
  if (d) return { born: d, born_source: 'name' };
  return { born: c.created_at || 0, born_source: 'first_seen' };
}
// a real date (WhatsApp or name) always beats "first seen", which says nothing about how new a community is
const newestFirst = (a, b) => ((b.born_source !== 'first_seen') - (a.born_source !== 'first_seen')) || (b.born - a.born) || String(a.name).localeCompare(String(b.name));
const validCreated = v => { const n = Math.floor(Number(v) || 0); return n > 1104537600 && n < now() + 86400 ? n : null; }; // after 2005, not in the future

async function uniqueSlug(env, base) {
  let slug = base, n = 2;
  while (await env.DB.prepare('SELECT 1 FROM communities WHERE id = ?').bind(slug).first()) slug = `${base}-${n++}`;
  return slug;
}

// ---------- short links ----------
function logClick(code, request, env, ctx) {
  const ua = request.headers.get('user-agent') || '';
  // Clicks relayed from sb.flexifunnels.com (relay/ worker in the domain's Cloudflare account) carry the visitor's
  // real IP and country; they are only trusted when the shared RELAY_KEY matches.
  const relayed = env.RELAY_KEY && authorizedValue(request.headers.get('x-relay-key') || '', env.RELAY_KEY);
  const ip = (relayed && request.headers.get('x-relay-ip')) || request.headers.get('cf-connecting-ip') || '';
  const country = (relayed && request.headers.get('x-relay-country')) || (request.cf && request.cf.country) || null;
  const isBot = !ua || BOT_UA.test(ua) || request.method === 'HEAD';
  ctx.waitUntil((async () => {
    const visitor = await sha256(`${env.HASH_SALT || 'salt'}|${ip}|${ua}`);
    await env.DB.prepare('INSERT INTO clicks (code, clicked_at, visitor_hash, country, device, is_bot) VALUES (?,?,?,?,?,?)')
      .bind(code, now(), visitor, country, /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'desktop', isBot ? 1 : 0)
      .run();
  })());
}

// Short redirect links: tracker/l/CODE -> logs the click, then sends the visitor on
// Never shows an error to a visitor: unknown/deleted links and database hiccups go to FALLBACK_URL.
// Smart fallback: a link like funnel-agent-replay-3b names its page. If the database can't be reached,
// send the visitor to <FALLBACK_URL>/funnel-agent-replay instead of the homepage, so registrations still happen.
function slugFallback(code, fallback) {
  const m = /^([a-z0-9][a-z0-9-]*?)-[abcdefghjkmnpqrstuvwxyz23456789]{2,6}$/i.exec(String(code || ''));
  return m && m[1].toLowerCase() !== 'wa' ? fallback.replace(/\/+$/, '') + '/' + m[1].toLowerCase() : fallback;
}
async function handleRedirect(code, request, env, ctx) {
  const fallback = env.FALLBACK_URL || 'https://sb.flexifunnels.com';
  let link = null;
  // case-insensitive, so a link retyped as Funnel-Agent-Access-K7 still works; an exact match wins
  try { link = await env.DB.prepare('SELECT code, destination, deleted_at FROM links WHERE code = ? COLLATE NOCASE ORDER BY (code = ?) DESC LIMIT 1').bind(code, code).first(); }
  catch (e) { return Response.redirect(slugFallback(code, fallback), 302); }
  if (!link) return Response.redirect(fallback, 302);
  // a link hidden on the dashboard (deleted_at set) keeps working: it may already be posted in a community
  try { logClick(link.code, request, env, ctx); } catch (e) {}
  // x-tracked tells the relay this was a real tracked link (unknown codes go to the fallback without it)
  return new Response(null, { status: 302, headers: { location: link.destination, 'cache-control': 'no-store', 'x-tracked': '1' } });
}

// ---------- links on your own site's address (SITE_HOSTS) ----------
// A tracked link always ends in "-" + a 2-6 character tag made only of these letters (no l, i, o, 0, 1),
// e.g. /funnel-agent-replay-3b. Real page addresses almost never do, so normal page views skip the database.
const TAG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const SITE_CODE_RE = new RegExp(`^/([a-z0-9][a-z0-9-]{0,60}-[${TAG_CHARS}]{2,6})/?$`, 'i');
function siteHosts(env) {
  return new Set(String(env.SITE_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}
async function handleSiteRequest(request, url, env, ctx) {
  const m = (request.method === 'GET' || request.method === 'HEAD') && SITE_CODE_RE.exec(url.pathname);
  if (m && env.DB) {
    try {
      const link = await env.DB.prepare('SELECT code, destination FROM links WHERE code = ? COLLATE NOCASE ORDER BY (code = ?) DESC LIMIT 1').bind(m[1], m[1]).first();
      if (link) {
        try { logClick(link.code, request, env, ctx); } catch (e) {}
        return new Response(null, { status: 302, headers: { location: link.destination, 'cache-control': 'no-store' } });
      }
    } catch (e) { /* database hiccup: fall through to the real page */ }
  }
  return fetch(request); // the real FlexiFunnels page, exactly as before
}

// Direct links: yourpage.com/...?wa=CODE. The tracking snippet on the page calls /h?c=CODE.
// Link previews don't run page scripts, so they are never counted.
async function handleHit(code, request, env, ctx) {
  const headers = { 'content-type': 'image/gif', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (/^[A-Za-z0-9]{4,16}$/.test(code)) {
    const link = await env.DB.prepare('SELECT code FROM links WHERE code = ? AND deleted_at IS NULL').bind(code).first();
    if (link) logClick(code, request, env, ctx);
  }
  return new Response(GIF, { headers });
}

function trackingScript(origin) {
  return `(function(){try{var c=new URLSearchParams(location.search).get('wa');if(!c||!/^[A-Za-z0-9]{4,16}$/.test(c))return;var k='wa_hit_'+c;try{if(sessionStorage.getItem(k))return;sessionStorage.setItem(k,'1')}catch(e){}new Image().src='${origin}/h?c='+c+'&t='+Date.now()}catch(e){}})();`;
}

// ---------- communities & links ----------
async function listCommunities(env) {
  const [{ results }, groups] = await Promise.all([
    env.DB.prepare('SELECT id, name, wa_chat_id, member_count, wa_created_at, created_at, updated_at FROM communities').all(),
    kvGet(env, 'groups', { list: [] }),
  ]);
  // a community's main (parent) group only holds admins: never offer it in the Link builder
  const parents = new Set((groups.list || []).filter(g => g.parent).map(g => g.id));
  return { communities: results.filter(c => !parents.has(c.wa_chat_id)).map(c => ({ ...c, ...communityBorn(c) })).sort(newestFirst) };
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
           l.deleted_at IS NOT NULL AS hidden,
           COUNT(k.id) AS clicks, COUNT(DISTINCT k.visitor_hash) AS unique_clicks
    FROM links l
    LEFT JOIN communities c ON c.id = l.community_id
    LEFT JOIN clicks k ON k.code = l.code AND k.is_bot = 0
    GROUP BY l.code ORDER BY l.created_at DESC, c.name LIMIT 1000`).all();
  return { links: results, short_base: shortBase(env, null) };
}
function shortBase(env, origin) {
  // a SHORT_BASE still holding the setup placeholder would make broken links: use the link worker instead
  const base = env.SHORT_BASE && !/PAGES_NAME/.test(env.SHORT_BASE) ? env.SHORT_BASE : 'https://sb.flexicommunities.workers.dev';
  return (base || origin || '').replace(/\/+$/, '');
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
  const comms = new Map((await env.DB.prepare('SELECT id, name FROM communities').all()).results.map(r => [r.id, r]));
  const taken = new Set((await env.DB.prepare('SELECT code FROM links').all()).results.map(r => r.code.toLowerCase()));
  // short link = last part of the page address + a 2-3 character tag per community
  const pageSlug = (new URL(destination).pathname.split('/').filter(Boolean).pop() || '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const tagChars = TAG_CHARS;
  const newCode = () => {
    for (let len = 2; len <= 6; len++) for (let tries = 0; tries < 30; tries++) {
      const tag = Array.from(crypto.getRandomValues(new Uint8Array(len)), b => tagChars[b % tagChars.length]).join('');
      // always "<page>-<tag>" (or "wa-<tag>" for a page with no path), so the link also works on your own site's address
      const c = `${pageSlug || 'wa'}-${tag}`;
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
    const created = validCreated(c.created);
    if (id) {
      byName.delete(String(c.name).toLowerCase());
      // name is refreshed too, so a community renamed on WhatsApp is renamed here
      commStmts.push(env.DB.prepare('UPDATE communities SET name = ?, wa_chat_id = ?, member_count = ?, wa_created_at = COALESCE(?, wa_created_at), updated_at = ? WHERE id = ?')
        .bind(String(c.name), c.wa_chat_id, Number(c.members) || 0, created, t, id));
    } else {
      const base = slugify(c.name); id = base; let n = 2;
      while (usedIds.has(id)) id = `${base}-${n++}`;
      usedIds.add(id);
      commStmts.push(env.DB.prepare('INSERT INTO communities (id, name, wa_chat_id, member_count, wa_created_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind(id, c.name, c.wa_chat_id, Number(c.members) || 0, created, t, t));
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

  const [communities, msgAgg, clickAgg, linkAgg, links, codeClicks, messages, dailyClicks, dailyMsgs, lastSync, groupsKv] = await Promise.all([
    q('SELECT id, name, member_count, wa_chat_id, wa_created_at, created_at FROM communities'),
    q(`SELECT community_id, COUNT(*) AS messages, SUM(delivered) AS delivered, SUM(reads) AS reads,
              SUM(reactions) AS reactions, SUM(replies) AS replies,
              SUM(CASE WHEN link_codes IS NOT NULL AND link_codes != '' THEN 1 ELSE 0 END) AS link_posts,
              SUM(CASE WHEN delivered > 0 THEN 1 ELSE 0 END) AS read_posts,
              MAX(sent_at) AS last_post_at
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
    kvGet(env, 'groups', { list: [] }),
  ]);

  // groups currently ticked for tracking (from the bot's last group list); also a source of creation dates
  const groupInfo = new Map((groupsKv.list || []).map(g => [g.id, g]));
  const byId = Object.fromEntries(communities.map(c => {
    const g = c.wa_chat_id ? groupInfo.get(c.wa_chat_id) : null;
    const born = communityBorn({ ...c, wa_created_at: c.wa_created_at || validCreated(g && g.created) });
    return [c.id, {
      id: c.id, name: c.name, members: c.member_count || 0, connected: !!c.wa_chat_id,
      tracked: !!(g && g.tracked), parent: !!(g && g.parent), ...born,
      messages: 0, delivered: 0, reads: 0, reactions: 0, replies: 0, clicks: 0, unique_clicks: 0, links: 0,
      link_posts: 0, read_posts: 0, last_post_at: null,
    }];
  }));
  for (const r of msgAgg) Object.assign(byId[r.community_id] || {}, { messages: r.messages, delivered: r.delivered || 0, reads: r.reads || 0, reactions: r.reactions || 0, replies: r.replies || 0,
    link_posts: r.link_posts || 0, read_posts: r.read_posts || 0, last_post_at: r.last_post_at || null });
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
    communities: Object.values(byId).sort(newestFirst), // newest community first
    campaigns: Object.values(camp).sort((a, b) => b.created_at - a.created_at),
    messages: msgOut,
    daily_clicks: dailyClicks,
    daily_messages: dailyMsgs,
  };
}

// ---------- live clicks (the dashboard asks every 15 s; clicks are saved the moment they happen) ----------
async function live(url, env) {
  const t = now();
  const since = Math.min(t, Number(url.searchParams.get('since')) || t - 3600);
  const tzMin = Number(env.TZ_OFFSET_MINUTES || 330);
  const dayStart = Math.floor((t + tzMin * 60) / 86400) * 86400 - tzMin * 60; // midnight, local time
  const [counts, recent] = await Promise.all([
    env.DB.prepare(`SELECT SUM(clicked_at > ?) AS fresh, SUM(clicked_at > ?) AS last_hour, SUM(clicked_at >= ?) AS today,
        COUNT(DISTINCT CASE WHEN clicked_at >= ? THEN visitor_hash END) AS today_unique
      FROM clicks WHERE is_bot = 0 AND clicked_at >= ?`).bind(since, t - 3600, dayStart, dayStart, Math.min(since, t - 3600, dayStart)).first(),
    env.DB.prepare(`SELECT k.id, k.clicked_at, k.country, k.device, l.code, l.campaign, l.community_id, c.name AS community
      FROM clicks k JOIN links l ON l.code = k.code LEFT JOIN communities c ON c.id = l.community_id
      WHERE k.is_bot = 0 ORDER BY k.clicked_at DESC, k.id DESC LIMIT 15`).all(),
  ]);
  return { now: t, fresh: counts.fresh || 0, last_hour: counts.last_hour || 0, today: counts.today || 0, today_unique: counts.today_unique || 0, recent: recent.results };
}

// ---------- one-click tracking: settings, bot status, GitHub control ----------
// Brings an already-deployed database up to date (runs once per Worker instance, costs ~2 queries).
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)').run();
  const cols = (await env.DB.prepare('PRAGMA table_info(links)').all()).results.map(r => r.name);
  if (cols.length && !cols.includes('deleted_at')) {
    try { await env.DB.prepare('ALTER TABLE links ADD COLUMN deleted_at INTEGER').run(); } catch (e) { /* added by a parallel request */ }
  }
  // message composer: one row per community copy of a message; media stored in ~1 MB chunks
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, campaign TEXT, community_id TEXT NOT NULL,
      wa_chat_id TEXT, body TEXT NOT NULL, media_key TEXT, status TEXT NOT NULL DEFAULT 'draft', error TEXT,
      wa_message_id TEXT, created_at INTEGER NOT NULL, queued_at INTEGER, sent_at INTEGER, updated_at INTEGER)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS sends_status ON sends(status, queued_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS sends_batch ON sends(batch_id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS media (key TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, chunks INTEGER, created_at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS media_chunks (key TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB, PRIMARY KEY (key, idx))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_clicks_time ON clicks(clicked_at)'), // live click feed
  ]);
  const ccols = (await env.DB.prepare('PRAGMA table_info(communities)').all()).results.map(r => r.name);
  if (ccols.length && !ccols.includes('wa_created_at')) {
    try { await env.DB.prepare('ALTER TABLE communities ADD COLUMN wa_created_at INTEGER').run(); } catch (e) { /* added by a parallel request */ }
  }
  schemaReady = true;
}
const kvTable = ensureSchema;
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
    const list = body.groups.slice(0, 500).map(g => ({ id: String(g.id), name: String(g.name || ''), members: Number(g.members) || 0, auto: !!g.auto, tracked: !!g.tracked, parent: !!g.parent, created: validCreated(g.created) }))
      .sort((a, b) => (b.created || 0) - (a.created || 0)); // newest first in Choose groups
    await kvSet(env, 'groups', { at: now(), list });
    // backfill creation dates for every community already in the database, in one go (not only the groups read this run)
    const created = new Map(list.filter(g => g.created).map(g => [g.id, g.created]));
    if (created.size) {
      const rows = (await env.DB.prepare('SELECT id, wa_chat_id, wa_created_at FROM communities WHERE wa_chat_id IS NOT NULL').all()).results;
      const stmts = rows.filter(r => created.has(r.wa_chat_id) && r.wa_created_at !== created.get(r.wa_chat_id))
        .map(r => env.DB.prepare('UPDATE communities SET wa_created_at = ? WHERE id = ?').bind(created.get(r.wa_chat_id), r.id));
      for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    }
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
  // the message batch being sent now, or the one that finished in the last 15 minutes (top-of-page progress bar)
  let sending = null;
  try {
    sending = await env.DB.prepare(`SELECT batch_id, MIN(campaign) AS campaign, COUNT(*) AS total,
        SUM(status = 'sent') + SUM(status = 'posted') AS done, SUM(status IN ('queued','sending')) AS pending,
        SUM(status IN ('failed','unknown')) AS failed, MAX(updated_at) AS updated_at
      FROM sends WHERE batch_id = (SELECT batch_id FROM sends WHERE status IN ('queued','sending') OR (queued_at IS NOT NULL AND updated_at >= ?)
        ORDER BY (status IN ('queued','sending')) DESC, updated_at DESC LIMIT 1)
      AND (queued_at IS NOT NULL OR status IN ('sent','posted','failed','unknown'))
      GROUP BY batch_id`).bind(now() - 900).first();
  } catch (e) { /* sends table not created yet */ }
  return { configured: !!gh, sending: sending || null, config: { ...config, phone: config.phone ? config.phone.replace(/\d(?=\d{4})/g, '•') : '' },
    status, groups, linked: !!linked.linked, run, run_error, last_sync: lastSync || null };
}

async function startTracking(body, env) {
  const gh = github(env);
  if (!gh) throw new Error('The Start button is not connected to GitHub yet. Add the GH_TOKEN and GH_REPO secrets to the Worker (see the setup guide).');
  const action = body.action === 'link' ? 'link' : 'sync';
  const run = await gh.latestRun();
  const busy = run && run.status !== 'completed';
  // a second sync is pointless, but a re-link is queued: GitHub starts it right after the current run
  if (busy && action === 'sync') return { ok: true, already_running: true, run };

  const cfg = await getConfig(env);
  let phone = String(body.phone || '').replace(/\D/g, '');
  if (action === 'link' && !phone && body.use_saved_phone !== false) phone = cfg.phone;
  await setConfig(env, { enabled: true, ...(phone ? { phone } : {}) });

  await gh.dispatch(action === 'link' ? { mode: 'login', pair_phone: phone } : { mode: 'sync' });
  await kvSet(env, 'bot_status', { stage: 'queued', mode: action === 'link' ? 'login' : 'sync', message: busy ? 'Waiting for the current sync to finish' : '', at: now() });
  return { ok: true, started: action, queued: !!busy };
}

// ---------- message composer: one message, a personal copy per community ----------
// Finds every link in a message, makes a tracked link per community for each, and stores one copy of the
// message per community (status draft). Copies are pasted by hand or sent by the bot (status queued).
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024; // WhatsApp's practical limit for media sent this way
const CHUNK = 1000000;                    // D1 rows stay under its 2 MB limit
const CAPTION_LIMIT = 1024;               // WhatsApp caption limit for images / videos / documents
const cleanUrl = u => u.replace(/[).,!?;:*_~'"\]]+$/, '');

function ownHosts(env) {
  const hosts = new Set(['sb.flexicommunities.workers.dev', 'wa-community-tracker.flexicommunities.workers.dev']);
  try { hosts.add(new URL(shortBase(env, null)).hostname); } catch (e) {}
  return hosts;
}

async function compose(body, env, origin) {
  const campaign = String(body.campaign || '').trim();
  let message = String(body.message || '').replace(/\r\n/g, '\n');
  const ids = Array.isArray(body.community_ids) ? body.community_ids.map(String) : [];
  // the page link to track: replaced wherever it appears in the message, added at the end if it doesn't,
  // or on its own when there is no message (links only)
  const link = cleanUrl(String(body.link || '').trim());
  if (!campaign) throw new Error('Give it a name (step 1)');
  if (link && !/^https?:\/\/[^\s]+$/i.test(link)) throw new Error('The link must start with https://');
  if (!message.trim() && !link) throw new Error('Add the page link or write a message');
  if (!ids.length) throw new Error('Pick at least one community');
  if (link) {
    const inMsg = [...message.matchAll(URL_IN_TEXT)].some(m => cleanUrl(m[0]) === link);
    if (!message.trim()) message = link;
    else if (!inMsg) message = message.replace(/\s+$/, '') + '\n\n' + link;
  }
  let media = null;
  if (body.media_key) {
    media = await env.DB.prepare('SELECT key, name, type, size FROM media WHERE key = ?').bind(String(body.media_key)).first();
    if (!media) throw new Error('The attached file was not found. Attach it again.');
    if (message.length > CAPTION_LIMIT) throw new Error(`With an image, video or PDF, WhatsApp allows up to ${CAPTION_LIMIT.toLocaleString('en-IN')} characters of text. This message has ${message.length.toLocaleString('en-IN')}.`);
  }
  const comms = new Map((await env.DB.prepare('SELECT id, name, wa_chat_id FROM communities').all()).results.map(r => [r.id, r]));
  const picked = ids.map(id => comms.get(id)).filter(Boolean);
  if (!picked.length) throw new Error('None of the ticked communities exist any more. Refresh the page.');

  // every distinct link in the message, except links that are already tracker links
  const own = ownHosts(env);
  const urls = [...new Set([...message.matchAll(URL_IN_TEXT)].map(m => cleanUrl(m[0])))]
    .filter(u => { try { return !own.has(new URL(u).hostname.toLowerCase()); } catch (e) { return false; } });

  // url -> community_id -> short link
  const map = {};
  for (const u of urls) {
    const r = await createLinks({ campaign, destination: u, community_ids: picked.map(c => c.id), add_utm: body.add_utm !== false }, env, origin);
    map[u] = Object.fromEntries(r.links.map(l => [l.community_id, l.short_url]));
  }
  const personalise = cid => message.replace(URL_IN_TEXT, m => {
    const u = cleanUrl(m);
    return map[u] && map[u][cid] ? map[u][cid] + m.slice(u.length) : m;
  });

  const batch = 'b' + now().toString(36) + randomCode(4);
  const t = now();
  const items = picked.map(c => ({ community_id: c.id, community: c.name, wa_chat_id: c.wa_chat_id || null, body: personalise(c.id) }));
  await env.DB.batch(items.map(it => env.DB.prepare('INSERT INTO sends (batch_id, campaign, community_id, wa_chat_id, body, media_key, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(batch, campaign, it.community_id, it.wa_chat_id, it.body, media ? media.key : null, 'draft', t, t)));
  return { batch_id: batch, ...(await listSends(new URL('http://x/?batch_id=' + batch), env)), links_found: urls };
}

async function listSends(url, env) {
  const batch = url.searchParams.get('batch_id');
  const cols = `s.id, s.batch_id, s.campaign, s.community_id, c.name AS community, s.wa_chat_id, s.body, s.media_key,
    m.name AS media_name, m.type AS media_type, s.status, s.error, s.created_at, s.queued_at, s.sent_at, s.updated_at`;
  if (batch) {
    const { results } = await env.DB.prepare(`SELECT ${cols} FROM sends s LEFT JOIN communities c ON c.id = s.community_id LEFT JOIN media m ON m.key = s.media_key WHERE s.batch_id = ? ORDER BY s.id`).bind(batch).all();
    return { batch_id: batch, items: results };
  }
  const { results } = await env.DB.prepare(`SELECT batch_id, MIN(campaign) AS campaign, MIN(created_at) AS created_at, COUNT(*) AS total,
      SUM(status = 'sent') AS sent, SUM(status = 'posted') AS posted, SUM(status IN ('queued','sending')) AS pending,
      SUM(status IN ('failed','unknown')) AS failed, MAX(media_key IS NOT NULL) AS has_media
    FROM sends GROUP BY batch_id ORDER BY created_at DESC LIMIT 30`).all();
  return { batches: results };
}

async function startSends(body, env) {
  const gh = github(env);
  if (!gh) throw new Error('Auto-send needs the Start button set up (GH_TOKEN and GH_REPO secrets).');
  const linked = await kvGet(env, 'linked', { linked: false });
  if (!linked.linked) throw new Error('WhatsApp is not linked. Link it on the dashboard first.');
  const batch = String(body.batch_id || '');
  const only = Array.isArray(body.ids) && body.ids.length ? body.ids.map(Number).filter(Boolean) : null;
  const t = now();
  const res = await env.DB.prepare(`UPDATE sends SET status = 'queued', error = NULL, queued_at = ?, updated_at = ?
      WHERE batch_id = ? AND wa_chat_id IS NOT NULL AND status IN ('draft','failed','cancelled')${only ? ` AND id IN (${only.map(() => '?').join(',')})` : ''}`)
    .bind(t, t, batch, ...(only || [])).run();
  const n = res.meta ? res.meta.changes : 0;
  if (!n) return { ok: true, queued: 0 };
  await setConfig(env, { enabled: true });
  // a run that is already going picks the queue up only if it hasn't passed its sending step, so always ask for one more;
  // GitHub runs it right after the current one (and every run, sync or send, sends queued messages first)
  await gh.dispatch({ mode: 'send' });
  await kvSet(env, 'bot_status', { stage: 'queued', mode: 'send', message: `Sending to ${n} communities starts in 1–2 minutes`, at: now() });
  return { ok: true, queued: n };
}
async function continueSends(env) {
  const gh = github(env);
  const q = await env.DB.prepare("SELECT COUNT(*) AS n FROM sends WHERE status = 'queued'").first();
  if (gh && q && q.n) { await gh.dispatch({ mode: 'send' }); return { ok: true, dispatched: true, left: q.n }; }
  return { ok: true, dispatched: false };
}
// the bot stopped after repeated problems: everything still waiting becomes "not sent" with the reason,
// so nobody's WhatsApp number keeps getting hammered and a person decides what to do
async function pauseSends(body, env) {
  const r = await env.DB.prepare("UPDATE sends SET status = 'failed', error = ?, updated_at = ? WHERE status = 'queued'")
    .bind(String(body.reason || 'Sending paused').slice(0, 300), now()).run();
  return { ok: true, paused: r.meta ? r.meta.changes : 0 };
}
async function cancelSends(body, env) {
  const res = await env.DB.prepare("UPDATE sends SET status = 'cancelled', updated_at = ? WHERE batch_id = ? AND status = 'queued'").bind(now(), String(body.batch_id || '')).run();
  return { ok: true, cancelled: res.meta ? res.meta.changes : 0 };
}
async function markSend(body, env) {
  // "Posted by hand" (or undo); never touches a message the bot is sending or has sent
  const to = body.undo ? 'draft' : 'posted';
  const from = body.undo ? "('posted')" : "('draft','failed','cancelled','unknown')";
  await env.DB.prepare(`UPDATE sends SET status = ?, sent_at = ?, updated_at = ? WHERE id = ? AND status IN ${from}`).bind(to, body.undo ? null : now(), now(), Number(body.id)).run();
  return { ok: true };
}

// --- bot side ---
async function botSends(env) {
  const t = now();
  // a run that died mid-send: we can't know if WhatsApp got it, so never resend automatically
  await env.DB.prepare("UPDATE sends SET status = 'unknown', error = 'Not sure if this one went out. Look in the community on WhatsApp: if it is there, click I posted it, otherwise Try again.', updated_at = ? WHERE status = 'sending' AND updated_at < ?")
    .bind(t, t - 1800).run();
  const { results } = await env.DB.prepare(`SELECT s.id, s.wa_chat_id, s.body, s.media_key, m.name AS media_name, m.type AS media_type, c.name AS community
      FROM sends s LEFT JOIN media m ON m.key = s.media_key LEFT JOIN communities c ON c.id = s.community_id
      WHERE s.status = 'queued' AND s.wa_chat_id IS NOT NULL ORDER BY s.queued_at, s.id LIMIT 200`).all();
  const day = await env.DB.prepare("SELECT COUNT(*) AS n FROM sends WHERE status = 'sent' AND sent_at >= ?").bind(t - 86400).first();
  return { sends: results, sent_last_24h: day ? day.n : 0 };
}
async function botSendUpdate(id, body, env) {
  const t = now();
  if (body.status === 'sending') {
    // claim it: only one run can move a message from queued to sending, so nothing is sent twice
    const r = await env.DB.prepare("UPDATE sends SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'queued'").bind(t, id).run();
    return { ok: true, go: !!(r.meta && r.meta.changes) };
  }
  const status = body.status === 'sent' ? 'sent' : 'failed';
  await env.DB.prepare("UPDATE sends SET status = ?, error = ?, wa_message_id = ?, sent_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'")
    .bind(status, status === 'failed' ? String(body.error || 'Failed').slice(0, 300) : null, body.wa_message_id ? String(body.wa_message_id) : null, status === 'sent' ? t : null, t, id).run();
  return { ok: true };
}

// --- media (image / video / PDF), stored in the database in chunks ---
async function uploadMedia(request, env) {
  const type = (request.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const name = decodeURIComponent(request.headers.get('x-file-name') || 'file').slice(0, 120);
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length) throw new Error('The file is empty');
  if (buf.length > MAX_MEDIA_BYTES) throw new Error('The file is larger than 16 MB. Compress it, or post it by hand.');
  if (!/^(image\/(jpeg|png|webp)|video\/(mp4|3gpp)|application\/pdf)$/.test(type)) throw new Error('Use a JPG, PNG or WEBP image, an MP4 video, or a PDF.');
  const key = 'm' + now().toString(36) + randomCode(6);
  const n = Math.ceil(buf.length / CHUNK);
  const stmts = [env.DB.prepare('INSERT INTO media (key, name, type, size, chunks, created_at) VALUES (?,?,?,?,?,?)').bind(key, name, type, buf.length, n, now())];
  for (let i = 0; i < n; i++) stmts.push(env.DB.prepare('INSERT INTO media_chunks (key, idx, data) VALUES (?,?,?)').bind(key, i, buf.slice(i * CHUNK, (i + 1) * CHUNK)));
  for (let i = 0; i < stmts.length; i += 5) await env.DB.batch(stmts.slice(i, i + 5));
  // tidy up: files from more than 30 days ago that no unsent message needs
  try {
    const old = now() - 30 * 86400;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM media_chunks WHERE key IN (SELECT key FROM media WHERE created_at < ? AND key NOT IN (SELECT media_key FROM sends WHERE media_key IS NOT NULL AND status IN ('draft','queued','sending')))").bind(old),
      env.DB.prepare("DELETE FROM media WHERE created_at < ? AND key NOT IN (SELECT media_key FROM sends WHERE media_key IS NOT NULL AND status IN ('draft','queued','sending'))").bind(old),
    ]);
  } catch (e) {}
  return { key, name, type, size: buf.length };
}
async function mediaResponse(key, env) {
  const m = await env.DB.prepare('SELECT name, type, size FROM media WHERE key = ?').bind(key).first();
  if (!m) return json({ error: 'not found' }, 404);
  const { results } = await env.DB.prepare('SELECT data FROM media_chunks WHERE key = ? ORDER BY idx').bind(key).all();
  const out = new Uint8Array(m.size); let off = 0;
  for (const r of results) { const d = new Uint8Array(r.data); out.set(d, off); off += d.length; }
  return new Response(out, { headers: { 'content-type': m.type, 'content-disposition': `inline; filename="${encodeURIComponent(m.name)}"`, 'x-file-name': encodeURIComponent(m.name), 'cache-control': 'no-store' } });
}
