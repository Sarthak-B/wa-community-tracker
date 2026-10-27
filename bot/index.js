// WhatsApp Community Tracker - reader bot
// Runs on GitHub Actions, started by the schedule or by the dashboard's Start tracking button.
// Logs into WhatsApp Web (saved session), reads the messages YOUR account sent in each tracked
// community group, collects reads / reactions / replies and uploads them to the tracker Worker.
// It reports every step live to the dashboard. It never sends anything on WhatsApp.
//
//   MODE=login  -> link the WhatsApp account (pairing code or QR shown on the dashboard), then sync
//   MODE=sync   -> normal run (default)

const { Client, LocalAuth } = require('whatsapp-web.js');
const ChatFactory = require('whatsapp-web.js/src/factories/ChatFactory');

const env = process.env;
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
  try { await client.destroy(); } catch {}
  process.exit(code);
}

// ---------- main ----------
let config = { enabled: true, tracked_ids: null, lookback_days: 14 };
let client;

(async () => {
  try { config = { ...config, ...(await api('/api/bot/config')) }; }
  catch (e) { log('Could not read dashboard settings, using defaults:', e.message); }

  if (EVENT === 'schedule' && !config.enabled) {
    log('Tracking is paused on the dashboard. Nothing to do.');
    process.exit(0);
  }

  log(`Starting in ${MODE} mode (${EVENT})`);
  await status('starting', { message: MODE === 'login' ? 'Opening WhatsApp Web to link your account' : 'Opening WhatsApp Web' });

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth', clientId: 'tracker' }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] },
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
      finish(1, { status: 'logged_out', note: 'WhatsApp is not linked - press Start tracking on the dashboard to link it', communities: [], messages: [] },
        'logged_out', { message: 'WhatsApp is not linked. Press Start tracking to link it.' });
    }
  });
  client.on('code', async code => {
    log(`PAIRING CODE: ${code}`);
    await status('pairing', { code, message: 'Enter this code in WhatsApp on your phone' });
  });
  client.on('authenticated', async () => { authenticated = true; log('Authenticated'); await status('connected', { message: 'WhatsApp linked. Loading your chats…' }); });
  client.on('auth_failure', m => finish(1, { status: 'logged_out', note: 'Auth failure: ' + m, communities: [], messages: [] }, 'logged_out', { message: 'WhatsApp refused the login. Press Start tracking to link again.' }));

  client.on('ready', async () => {
    authenticated = true;
    log('WhatsApp ready');
    const readyAt = Date.now();
    try {
      await status('connected', { message: 'Connected. Loading chats…' });
      await sleep(MODE === 'login' ? 45000 : 15000); // a fresh link needs longer to load chats
      const report = await collect();
      // keep a freshly linked session open at least 60s so it is fully saved
      const wait = 60000 - (Date.now() - readyAt);
      if (wait > 0) await sleep(wait);
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
  const picked = Array.isArray(config.tracked_ids) && config.tracked_ids.length ? new Set(config.tracked_ids) : null;

  const list = groups.map(g => {
    const md = g.groupMetadata || {};
    const auto = GROUP_FILTER ? GROUP_FILTER.test(g.name || '') : isCommunityAnnouncementGroup(g);
    const tracked = picked ? picked.has(g.id._serialized) : auto;
    const members = (md.participants || []).length || Number(md.size) || 0;
    return { chat: g, id: g.id._serialized, name: g.name || '(no name)', members, auto, tracked };
  }).sort((a, b) => (b.tracked - a.tracked) || (b.members - a.members));

  log(`Found ${groups.length} groups. (tracked = *)`);
  for (const g of list) log(`  ${g.tracked ? '*' : ' '} ${g.name}  [members=${g.members}]`);
  // groups read longest ago (or never) go first, so big lists are covered across several runs
  const lastRead = config.last_read || {};
  const tracked = list.filter(g => g.tracked).sort((a, b) => (lastRead[a.id] || 0) - (lastRead[b.id] || 0));
  await status('reading', {
    message: tracked.length ? `Reading ${tracked.length} groups` : 'No groups selected. Choose groups on the dashboard.',
    progress: { done: 0, total: tracked.length },
    groups: list.map(({ id, name, members, auto, tracked }) => ({ id, name, members, auto, tracked })),
  });

  const since = Math.floor(Date.now() / 1000) - Number(config.lookback_days || 14) * 86400;
  const started = Date.now();
  let communities = [], messages = [];
  let doneGroups = 0, totalMessages = 0;

  for (const [i, g] of tracked.entries()) {
    if (Date.now() - started > READ_BUDGET_MS) { log(`Time budget reached after ${i} groups; the rest are read next run`); break; }
    const chat = g.chat;
    const md = chat.groupMetadata || {};
    let name = g.name;
    if (md.parentGroup && md.defaultSubgroup) {
      try {
        const parent = await client.getChatById(md.parentGroup._serialized || md.parentGroup);
        if (parent && parent.name) name = parent.name;
      } catch {}
    }
    communities.push({ wa_chat_id: g.id, name, members: g.members });

    let all = [];
    try { all = await chat.fetchMessages({ limit: MAX_MESSAGES }); } catch (e) { log(`  ! could not read ${name}: ${e.message || e}`); }
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
      try { await api('/api/ingest', { partial: true, status: 'ok', communities, messages }); communities = []; messages = []; }
      catch (e) { log('Partial upload failed, will retry at the end:', e.message); }
    }
    await status('reading', { message: `Read ${name}`, progress: { done: doneGroups, total: tracked.length } });
  }

  const left = tracked.length - doneGroups;
  const summary = `Checked ${totalMessages} messages in ${doneGroups} groups` + (left ? `. ${left} groups will be read in the next runs (tip: untick groups you don't need in Choose groups)` : '');
  await status('uploading', { message: 'Saving results', progress: { done: doneGroups, total: tracked.length } });
  return { status: 'ok', communities, messages, totals: { groups: doneGroups, messages: totalMessages, tracked: tracked.length }, summary };
}
