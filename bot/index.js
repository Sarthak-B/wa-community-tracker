// WhatsApp Community Tracker - reader bot
// Runs on GitHub Actions, started by the schedule or by the dashboard's Start tracking button.
// Logs into WhatsApp Web (saved session), reads the messages YOUR account sent in each tracked
// community group, collects reads / reactions / replies and uploads them to the tracker Worker.
// It reports every step live to the dashboard. It never sends anything on WhatsApp.
//
//   MODE=login  -> link the WhatsApp account (pairing code or QR shown on the dashboard), then sync
//   MODE=sync   -> normal run (default)

const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const ChatFactory = require('whatsapp-web.js/src/factories/ChatFactory');

const env = process.env;
const T0 = Date.now();
// Written as soon as WhatsApp accepts the login. The workflow saves the session whenever this file
// exists, even if the sync afterwards fails or times out, so a fresh link is never thrown away.
const LINKED_MARKER = '.linked_ok';
const markLinked = () => { try { fs.writeFileSync(LINKED_MARKER, new Date().toISOString()); } catch {} };
const unmarkLinked = () => { try { fs.unlinkSync(LINKED_MARKER); } catch {} };
const MODE = (env.MODE || 'sync').toLowerCase();
const TRACKER_URL = (env.TRACKER_URL || '').replace(/\/+$/, '');
const INGEST_TOKEN = env.INGEST_TOKEN || '';
const MAX_MESSAGES = Number(env.MAX_MESSAGES_PER_GROUP || 150);
const GROUP_FILTER = env.GROUP_NAME_FILTER ? new RegExp(env.GROUP_NAME_FILTER, 'i') : null;
const PAIR_PHONE = (env.PAIR_PHONE || '').replace(/\D/g, '');
const RUN_ID = env.GITHUB_RUN_ID || null;
const EVENT = env.GITHUB_EVENT_NAME || 'manual';
const HARD_TIMEOUT_MS = Number(env.HARD_TIMEOUT_MIN || 21) * 60 * 1000;
// Stop starting new groups after this long; groups not reached are read first next run.
const READ_BUDGET_MS = Number(env.READ_BUDGET_MIN || 13) * 60 * 1000;
const UPLOAD_EVERY = 5; // save results to the dashboard every 5 groups
// In announcement-only groups only admins can post, so count every admin post as a team message.
// Read counts are only available for messages sent from the linked number itself.
const COUNT_ADMIN_POSTS = (env.COUNT_ADMIN_POSTS || 'true') !== 'false';
const SYSTEM_TYPES = new Set(['notification', 'e2e_notification', 'gp2', 'revoked', 'notification_template', 'call_log', 'protocol']);
const LOGIN_TIMEOUT_MS = 6 * 60 * 1000;
// Stop reading this long before the hard timeout, leaving time to upload and save the session.
const SAFETY_MARGIN_MS = 4 * 60 * 1000;
const LOOKBACK_OVERRIDE = Number(env.LOOKBACK_DAYS) || null;
// Groups are read newest community first. One not read for this many hours is read first anyway (0 = off).
const STALE_HOURS = env.STALE_HOURS === undefined || env.STALE_HOURS === '' ? 24 : Number(env.STALE_HOURS) || 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!TRACKER_URL || !INGEST_TOKEN) {
  console.error('TRACKER_URL and INGEST_TOKEN must be set (GitHub repo secrets).');
  process.exit(1);
}

// ---------- talking to the dashboard ----------
async function api(path, body) {
  const res = await fetch(TRACKER_URL + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}
async function status(stage, extra = {}) {
  try { await api('/api/bot/status', { stage, mode: MODE, run_id: RUN_ID, ...extra }); }
  catch (e) { log('(could not report status:', e.message + ')'); }
}

let finished = false;
async function finish(code, report, finalStage, extra = {}) {
  if (finished) return;
  finished = true;
  if (report) {
    try {
      const r = await api('/api/ingest', report);
      log('Upload:', JSON.stringify(r));
    } catch (e) { log('Upload failed:', e.message); code = 1; finalStage = 'error'; extra = { message: 'Could not upload results: ' + e.message }; }
  }
  if (finalStage) await status(finalStage, extra);
  // a freshly linked session must stay open ~60s so WhatsApp finishes saving it, even when the sync failed
  if (MODE === 'login' && readyAt) {
    const wait = 60000 - (Date.now() - readyAt);
    if (wait > 0) { log(`Keeping the new session open ${Math.ceil(wait / 1000)}s so it is saved`); await sleep(wait); }
  }
  try { await client.destroy(); } catch {}
  process.exit(code);
}

// ---------- main ----------
let config = { enabled: true, tracked_ids: null, lookback_days: 14 };
let client;
let readyAt = 0;

(async () => {
  try { config = { ...config, ...(await api('/api/bot/config')) }; }
  catch (e) { log('Could not read dashboard settings, using defaults:', e.message); }
  if (LOOKBACK_OVERRIDE) config.lookback_days = LOOKBACK_OVERRIDE;

  if (EVENT === 'schedule' && !config.enabled) {
    log('Tracking is paused on the dashboard. Nothing to do.');
    process.exit(0);
  }

  log(`Starting in ${MODE} mode (${EVENT})`);
  await status('starting', { message: MODE === 'login' ? 'Opening WhatsApp Web to link your account' : 'Opening WhatsApp Web' });

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth', clientId: 'tracker' }),
    authTimeoutMs: 300000,
    // CHROME_PATH = the Chrome already installed on GitHub's runner (saves downloading Chromium every run)
    puppeteer: { headless: true, protocolTimeout: 600000, ...(env.CHROME_PATH ? { executablePath: env.CHROME_PATH } : {}), args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] },
    ...(MODE === 'login' && PAIR_PHONE ? { pairWithPhoneNumber: { phoneNumber: PAIR_PHONE, showNotification: true } } : {}),
  });

  setTimeout(() => { log('Hard timeout reached'); finish(1, { status: 'error', note: 'Bot timed out', communities: [], messages: [] }, 'error', { message: 'The run took too long and was stopped. Try again.' }); }, HARD_TIMEOUT_MS);

  let authenticated = false;
  if (MODE === 'login') {
    setTimeout(() => {
      if (!authenticated) finish(1, null, 'error', { message: 'The code was not entered in time. Press Start tracking to get a new one.' });
    }, LOGIN_TIMEOUT_MS);
  }

  let lastQr = 0;
  client.on('qr', async qr => {
    if (MODE === 'login') {
      if (PAIR_PHONE) return; // pairing-code flow, QR not needed
      log('QR code ready - scan it from the dashboard');
      if (Date.now() - lastQr > 5000) { lastQr = Date.now(); await status('qr', { qr, message: 'Scan this QR code with WhatsApp' }); }
    } else {
      log('Session is not logged in.');
      unmarkLinked();
      finish(1, { status: 'logged_out', note: 'WhatsApp is not linked - press Start tracking on the dashboard to link it', communities: [], messages: [] },
        'logged_out', { message: 'WhatsApp is not linked. Press Start tracking to link it.' });
    }
  });
  client.on('code', async code => {
    log(`PAIRING CODE: ${code}`);
    await status('pairing', { code, message: 'Enter this code in WhatsApp on your phone' });
  });
  client.on('authenticated', async () => { authenticated = true; markLinked(); log('Authenticated'); await status('connected', { message: 'WhatsApp linked. Loading your chats…' }); });
  client.on('auth_failure', m => (unmarkLinked(), finish(1, { status: 'logged_out', note: 'Auth failure: ' + m, communities: [], messages: [] }, 'logged_out', { message: 'WhatsApp refused the login. Press Start tracking to link again.' })));

  client.on('ready', async () => {
    authenticated = true;
    markLinked();
    log('WhatsApp ready');
    readyAt = Date.now();
    try {
      await status('connected', { message: 'Connected. Loading chats…' });
      await sleep(MODE === 'login' ? 45000 : 15000); // a fresh link needs longer to load chats
      const report = await collect();
      await finish(0, report, 'done', {
        message: report.summary,
        progress: { done: report.totals.groups, total: report.totals.tracked },
      });
    } catch (e) {
      log('Sync error:', e && (e.stack || e.message || e));
      await finish(1, { status: 'error', note: e.message, communities: [], messages: [] }, 'error', { message: 'Something went wrong while reading messages: ' + e.message });
    }
  });

  client.initialize().catch(e => finish(1, { status: 'error', note: 'Init failed: ' + e.message, communities: [], messages: [] }, 'error', { message: 'Could not open WhatsApp Web: ' + e.message }));
})();

function isCommunityAnnouncementGroup(chat) {
  const md = chat.groupMetadata || {};
  if (md.isParentGroup) return false;
  return !!(md.defaultSubgroup || (md.parentGroup && md.announce));
}

// WhatsApp Web's own "get all chats" fails completely if even one chat can't be read
// (e.g. a group you left or an odd community). This reads chats one by one and skips bad ones.
async function getGroupChats() {
  try {
    return (await client.getChats()).filter(c => c.isGroup);
  } catch (e) {
    log('Normal chat list failed (' + (e.message || e) + '), reading chats one by one instead');
  }
  const { chats, skipped, total } = await client.pupPage.evaluate(async () => {
    const out = []; let skipped = 0;
    const all = window.require('WAWebCollections').Chat.getModelsArray();
    for (const chat of all) {
      if (!chat.groupMetadata) continue;
      try {
        const m = await Promise.race([window.WWebJS.getChatModel(chat), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
        if (m) { out.push(m); continue; }
      } catch (e) {}
      try {
        const model = chat.serialize();
        model.isGroup = true;
        model.isMuted = false;
        model.formattedTitle = chat.formattedTitle;
        model.groupMetadata = chat.groupMetadata.serialize();
        model.isReadOnly = chat.groupMetadata.announce;
        model.lastMessage = null;
        delete model.msgs; delete model.msgUnsyncedButtonReplyMsgs; delete model.unsyncedButtonReplies;
        out.push(model);
      } catch (e) { skipped++; }
    }
    return { chats: out, skipped, total: all.length };
  });
  log(`Read ${chats.length} groups from ${total} chats (${skipped} could not be read and were skipped)`);
  return chats.map(c => ChatFactory.create(client, c)).filter(c => c && c.isGroup);
}

async function collect() {
  const groups = await getGroupChats();
  const me = client.info && client.info.wid && client.info.wid._serialized;
  // null = automatic (community announcement groups); a list = exactly those groups, even if empty
  const picked = Array.isArray(config.tracked_ids) ? new Set(config.tracked_ids) : null;

  // when each community was made: the parent community's creation time if known, else the group's own
  const creationById = {};
  for (const g of groups) creationById[g.id._serialized] = Number((g.groupMetadata || {}).creation) || 0;
  const createdAt = md => {
    const parentId = md.parentGroup && (md.parentGroup._serialized || md.parentGroup);
    return (parentId && creationById[parentId]) || Number(md.creation) || 0;
  };

  const list = groups.map(g => {
    const md = g.groupMetadata || {};
    const auto = GROUP_FILTER ? GROUP_FILTER.test(g.name || '') : isCommunityAnnouncementGroup(g);
    const tracked = picked ? picked.has(g.id._serialized) : auto;
    const members = (md.participants || []).length || Number(md.size) || 0;
    return { chat: g, id: g.id._serialized, name: g.name || '(no name)', members, auto, tracked, created: createdAt(md) };
  }).sort((a, b) => (b.tracked - a.tracked) || (b.created - a.created) || (b.members - a.members));

  log(`Found ${groups.length} groups, newest first. (tracked = *)`);
  for (const g of list) log(`  ${g.tracked ? '*' : ' '} ${g.name}  [members=${g.members}, made ${g.created ? new Date(g.created * 1000).toISOString().slice(0, 10) : '?'}]`);
  // Newest community first, then further back. Safety net: a group not read for STALE_HOURS
  // (or never read) jumps the queue, so old communities are never skipped forever when a run runs out of time.
  const lastRead = config.last_read || {};
  const staleBefore = Math.floor(Date.now() / 1000) - STALE_HOURS * 3600;
  const isStale = g => STALE_HOURS > 0 && (lastRead[g.id] || 0) < staleBefore;
  const tracked = list.filter(g => g.tracked).sort((a, b) => (isStale(b) - isStale(a)) || (b.created - a.created));
  const staleCount = tracked.filter(isStale).length;
  if (staleCount && staleCount < tracked.length) log(`${staleCount} groups not read in ${STALE_HOURS}h go first`);
  await status('reading', {
    message: tracked.length ? `Reading ${tracked.length} groups` : 'No groups selected. Choose groups on the dashboard.',
    progress: { done: 0, total: tracked.length },
    groups: list.map(({ id, name, members, auto, tracked, created }) => ({ id, name, members, auto, tracked, created })),
  });

  const since = Math.floor(Date.now() / 1000) - Number(config.lookback_days || 14) * 86400;
  const started = Date.now();
  let communities = [], messages = [];
  let doneGroups = 0, totalMessages = 0;

  for (const [i, g] of tracked.entries()) {
    if (Date.now() - started > READ_BUDGET_MS || Date.now() - T0 > HARD_TIMEOUT_MS - SAFETY_MARGIN_MS) { log(`Time budget reached after ${i} groups; the rest are read next run`); break; }
    const chat = g.chat;
    const md = chat.groupMetadata || {};
    let name = g.name;
    if (md.parentGroup && md.defaultSubgroup) {
      try {
        const parent = await client.getChatById(md.parentGroup._serialized || md.parentGroup);
        if (parent && parent.name) name = parent.name;
      } catch {}
    }
    // created = when the WhatsApp community was made (unix seconds), so the dashboard can show newest first
    communities.push({ wa_chat_id: g.id, name, members: g.members, created: g.created || null });

    let all = [];
    try { all = await chat.fetchMessages({ limit: MAX_MESSAGES }); } catch (e) { log(`  ! could not read ${name}: ${e.message || e}`); }
    await fixMessageIds(g.id, all);
    const recent = all.filter(m => m.timestamp >= since);
    const announce = !!(md.announce || chat.isReadOnly);
    const mine = recent.filter(m => !SYSTEM_TYPES.has(m.type) && (m.fromMe || (me && m.author === me) || (COUNT_ADMIN_POSTS && announce)));
    const byMe = mine.filter(m => m.fromMe).length;

    const replyCount = {};
    for (const m of recent) {
      if (m.fromMe) continue;
      const q = m._data && (m._data.quotedStanzaID || (m._data.quotedMsgId && m._data.quotedMsgId.id));
      if (q) replyCount[q] = (replyCount[q] || 0) + 1;
    }

    const newest = all.length ? new Date(Math.max(...all.map(m => m.timestamp)) * 1000).toISOString().slice(0, 10) : '-';
    log(`  ${name}: loaded ${all.length} (newest ${newest}), last ${config.lookback_days || 14} days ${recent.length}, counted ${mine.length} (${byMe} sent from this number)${announce ? ' [announcements]' : ''}`);
    for (const m of mine) {
      let delivered = 0, reads = 0, reactions = 0;
      try {
        const info = m.fromMe ? await m.getInfo() : null;
        if (info) {
          reads = (info.read || []).length + (info.played || []).length;
          delivered = (info.delivery || []).length + reads;
        }
      } catch {}
      try {
        if (m.hasReaction) {
          const rs = await m.getReactions();
          reactions = (rs || []).reduce((s, r) => s + (r.senders || []).length, 0);
        }
      } catch {}
      const body = m.body || (m._data && (m._data.caption || m._data.text)) || `[${m.type}]`;
      messages.push({ id: m.id._serialized, wa_chat_id: g.id, sent_at: m.timestamp, body, delivered, reads, reactions, replies: replyCount[m.id.id] || 0 });
      totalMessages++;
      await sleep(150);
    }
    doneGroups = i + 1;

    // save progress so nothing is lost if the run is stopped
    if (doneGroups % UPLOAD_EVERY === 0) {
      try { const r = await api('/api/ingest', { partial: true, status: 'ok', communities, messages }); log('Saved batch: sent ' + communities.length + ' groups / ' + messages.length + ' messages, dashboard replied ' + JSON.stringify(r)); communities = []; messages = []; }
      catch (e) { log('Partial upload failed, will retry at the end:', e.message); }
    }
    await status('reading', { message: `Read ${name}`, progress: { done: doneGroups, total: tracked.length } });
  }

  const left = tracked.length - doneGroups;
  const summary = `Checked ${totalMessages} messages in ${doneGroups} groups` + (left ? `. ${left} groups will be read in the next runs (tip: untick groups you don't need in Choose groups)` : '');
  await status('uploading', { message: 'Saving results', progress: { done: doneGroups, total: tracked.length } });
  return { status: 'ok', communities, messages, totals: { groups: doneGroups, messages: totalMessages, tracked: tracked.length }, summary };
}

// WhatsApp Web no longer hands over the full message id, which breaks saving messages and reading
// "Read by" info. Ask WhatsApp Web for the real ids and put them back on each message.
async function fixMessageIds(chatId, msgs) {
  if (!msgs.length || msgs.every(m => m.id && m.id._serialized)) return;
  let real = {};
  try {
    real = await client.pupPage.evaluate(async (cid) => {
      const chat = await window.WWebJS.getChat(cid, { getAsModel: false });
      const out = {};
      for (const m of chat.msgs.getModelsArray()) out[m.id.id] = m.id._serialized || m.id.toString();
      return out;
    }, chatId);
  } catch (e) { log('  (could not read message ids: ' + (e.message || e) + ')'); }
  const ser = w => !w ? '' : typeof w === 'string' ? w : (w._serialized || (w.user + '@' + w.server));
  for (const m of msgs) {
    if (!m.id) continue;
    if (!m.id._serialized) {
      m.id._serialized = real[m.id.id] || (m.id.fromMe + '_' + ser(m.id.remote) + '_' + m.id.id + (m.id.participant ? '_' + ser(m.id.participant) : ''));
    }
  }
}
