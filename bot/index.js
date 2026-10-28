// WhatsApp Community Tracker - reader bot
// Runs on GitHub Actions, started by the schedule or by the dashboard's Start tracking button.
// Logs into WhatsApp Web (saved session), reads the messages YOUR account sent in each tracked
// community group, collects reads / reactions / replies and uploads them to the tracker Worker.
// It reports every step live to the dashboard. It never sends anything on WhatsApp.
//
//   MODE=login  -> link the WhatsApp account (pairing code or QR shown on the dashboard), then sync
//   MODE=sync   -> normal run (default)
//   MODE=send   -> post the messages queued on the dashboard's message composer, then stop
// Every run (sync, send or login) first posts any queued messages, one community at a time.

const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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
// 21 min for a normal sync; 55 min when messages are waiting to be sent (the workflow allows 60)
let HARD_TIMEOUT_MS = Number(env.HARD_TIMEOUT_MIN || 21) * 60 * 1000;
const SEND_TIMEOUT_MS = Number(env.SEND_TIMEOUT_MIN || 55) * 60 * 1000;
// Sending: random pause between communities so WhatsApp doesn't see a burst of identical messages
// Safety for the WhatsApp number: random 45-120 s pause between communities, a "typing…" moment before each
// message, at most 20 per run and 40 per 24 hours, and a full stop after 2 problems in a row.
const SEND_GAP_MIN_S = Math.max(20, Number(env.SEND_GAP_MIN || 45));
const SEND_GAP_MAX_S = Math.max(SEND_GAP_MIN_S, Number(env.SEND_GAP_MAX || 120));
const MAX_SENDS_PER_RUN = Number(env.MAX_SENDS_PER_RUN || 20);
const MAX_SENDS_PER_DAY = Number(env.MAX_SENDS_PER_DAY || 40);
const STOP_AFTER_FAILS = Number(env.STOP_AFTER_FAILS || 2);
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
  if (MODE === 'send' || Number(config.queued_sends) > 0) HARD_TIMEOUT_MS = Math.max(HARD_TIMEOUT_MS, SEND_TIMEOUT_MS);

  if (EVENT === 'schedule' && !config.enabled && !(Number(config.queued_sends) > 0)) {
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
      const sent = await sendQueued();
      if (MODE === 'send') {
        const msg = !sent.total ? 'No messages were waiting to be sent'
          : sent.limit ? `Daily safety limit reached (${MAX_SENDS_PER_DAY} messages in 24 hours). The rest go out automatically later.`
          : sent.paused ? `Sending paused after ${STOP_AFTER_FAILS} problems in a row. ${sent.sent} sent. See Send message & links.`
          : `${sent.sent} of ${sent.total} sent` + (sent.failed ? `, ${sent.failed} with a problem` : '') + (sent.left ? `. ${sent.left} more go out in the next run` : '');
        return finish(0, null, 'done', { message: msg, mode: 'send' });
      }
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

// ---------- sending queued messages (message composer) ----------
// Each community gets its own copy of the message with its own tracked links. One at a time, with a random
// 30-90 s pause, only into groups where this number may post. A message is "claimed" before sending, so it is
// never sent twice, even if two runs overlap.
async function fetchMedia(job) {
  const res = await fetch(TRACKER_URL + '/api/bot/media/' + encodeURIComponent(job.media_key), { headers: { authorization: `Bearer ${INGEST_TOKEN}` } });
  if (!res.ok) throw new Error('Could not download the attached file (' + res.status + ')');
  const buf = Buffer.from(await res.arrayBuffer());
  return new MessageMedia(job.media_type || res.headers.get('content-type') || 'application/octet-stream', buf.toString('base64'), job.media_name || 'file');
}
// Sends one message straight through WhatsApp Web, without the library's two extra steps that break on
// current WhatsApp Web ("Data passed to getter must include an id property"): marking the chat as seen
// before sending, and re-reading the sent message afterwards. Each stage is named so an error says
// whether the message could already have gone out.
async function waSend(chatId, text, media, extra = {}) {
  const opts = {
    linkPreview: extra.linkPreview !== false, parseVCards: true, mentionedJidList: [], ignoreQuoteErrors: true, waitUntilMsgSent: false,
    ...(media ? { media: { mimetype: media.mimetype, data: media.data, filename: media.filename },
      caption: text, isCaptionByUser: true, sendMediaAsDocument: !/^(image|video)\//.test(media.mimetype) } : {}),
  };
  return client.pupPage.evaluate(async (chatId, content, opts) => {
    let stage = 'open';
    try {
      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat) return { error: 'The linked WhatsApp number is not in this group', stage };
      stage = 'send';
      const msg = await window.WWebJS.sendMessage(chat, content, opts);
      stage = 'after';
      let id = null;
      try { id = msg && msg.id ? (msg.id._serialized || String(msg.id)) : null; } catch (e) {}
      return { ok: true, id };
    } catch (e) {
      return { error: String((e && e.message) || e).slice(0, 300), stage };
    }
  }, chatId, media ? '' : text, opts);
}

// After an unclear error: did the message land anyway? Looks for a message from this number in the
// last 15 minutes whose text matches (each community's copy carries its own link, so this is exact).
async function alreadyInChat(chatId, text) {
  const want = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!want) return false;
  try {
    return await client.pupPage.evaluate(async (chatId, want) => {
      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat || !chat.msgs) return false;
      const since = Date.now() / 1000 - 900;
      return chat.msgs.getModelsArray().some(m => {
        const mine = m.id ? m.id.fromMe : m.isSentByMe;
        const body = String(m.body || m.caption || '').replace(/\s+/g, ' ').trim();
        return mine && (m.t || 0) >= since && body.slice(0, 200) === want;
      });
    }, chatId, want);
  } catch (e) { return false; }
}

async function showTyping(chatId, ms) {
  try { await client.pupPage.evaluate(async (chatId) => { await window.WWebJS.sendChatstate('typing', chatId); }, chatId); } catch (e) {}
  await sleep(ms);
  try { await client.pupPage.evaluate(async (chatId) => { await window.WWebJS.sendChatstate('stop', chatId); }, chatId); } catch (e) {}
}

// WhatsApp Web's own errors are technical; say what they mean
function plainError(e) {
  const m = String((e && e.message) || e);
  if (/getter must include an id|memoize|Evaluation failed|Protocol error|Target closed|Session closed/i.test(m)) return 'WhatsApp didn\'t accept this one (a glitch on WhatsApp\'s side). It was checked: it is not in the group. Click Try again later, or post it yourself.';
  if (/timed? ?out/i.test(m)) return 'WhatsApp took too long to answer. It was checked: it is not in the group. Click Try again later, or post it yourself.';
  if (/download the attached file/i.test(m)) return 'The attached file could not be loaded. Create the message again with the file, or post it yourself.';
  return m.slice(0, 300);
}

async function sendQueued() {
  let jobs = [], room = MAX_SENDS_PER_DAY;
  try {
    const r = await api('/api/bot/sends');
    jobs = r.sends || [];
    room = Math.max(0, MAX_SENDS_PER_DAY - Number(r.sent_last_24h || 0));
  } catch (e) { log('Could not read queued messages:', e.message); return { total: 0, sent: 0, failed: 0, left: 0 }; }
  if (!jobs.length) return { total: 0, sent: 0, failed: 0, left: 0 };
  if (!room) {
    log(`Daily limit of ${MAX_SENDS_PER_DAY} messages reached; the rest wait`);
    await status('sending', { mode: 'send', message: `Daily safety limit reached (${MAX_SENDS_PER_DAY} messages in 24 hours). The rest go out automatically later.` });
    return { total: jobs.length, sent: 0, failed: 0, left: jobs.length, limit: true };
  }
  const me = client.info && client.info.wid && client.info.wid._serialized;
  const total = jobs.length, todo = jobs.slice(0, Math.min(MAX_SENDS_PER_RUN, room));
  log(`Sending ${todo.length} of ${total} queued messages (daily room ${room})`);
  const mediaCache = {};
  let sent = 0, failed = 0, done = 0, inARow = 0, paused = false;
  for (const [i, job] of todo.entries()) {
    if (Date.now() - T0 > HARD_TIMEOUT_MS - SAFETY_MARGIN_MS - 3 * 60000) { log('Out of time; the rest are sent in the next run'); break; }
    if (i > 0) {
      const gap = Math.round(SEND_GAP_MIN_S + Math.random() * (SEND_GAP_MAX_S - SEND_GAP_MIN_S));
      await status('sending', { mode: 'send', message: `${sent} of ${todo.length} sent. Next one in ${gap}s (a pause keeps the number safe)`, progress: { done: i, total: todo.length, unit: 'messages' } });
      await sleep(gap * 1000);
    }
    let claim = null;
    try { claim = await api(`/api/bot/sends/${job.id}`, { status: 'sending' }); } catch (e) { log('  ! could not claim', job.id, e.message); }
    if (!claim || !claim.go) { log(`  - skipped ${job.community} (stopped or already taken)`); done = i + 1; continue; }
    await status('sending', { mode: 'send', message: `Sending to ${job.community}`, progress: { done: i, total: todo.length, unit: 'messages' } });
    let result = null;
    try {
      const chat = await client.getChatById(job.wa_chat_id).catch(() => null);
      if (chat) {
        const md = chat.groupMetadata || {};
        const mine = (md.participants || []).find(p => p.id && p.id._serialized === me);
        if (md.announce && mine && !mine.isAdmin && !mine.isSuperAdmin) throw new Error('The linked WhatsApp number is not an admin here, so it can\'t post. Make it admin, or post this one yourself.');
      }
      const media = job.media_key ? (mediaCache[job.media_key] || (mediaCache[job.media_key] = await fetchMedia(job))) : null;
      await showTyping(job.wa_chat_id, 2000 + Math.random() * 3000); // like a person typing
      result = await waSend(job.wa_chat_id, job.body, media);
      if (result.error && result.stage !== 'open') {
        // unclear whether it went out: look before calling it a failure, so nothing is ever posted twice
        await sleep(6000);
        if (await alreadyInChat(job.wa_chat_id, job.body)) { log(`  (error "${result.error}" but the message is in the group)`); result = { ok: true }; }
        else if (result.stage === 'send') {
          // not in the group: one careful retry without the link preview (the step most likely to trip)
          log(`  (send failed: ${result.error}; retrying once without link preview)`);
          await sleep(8000 + Math.random() * 7000);
          const again = await waSend(job.wa_chat_id, job.body, media, { linkPreview: false });
          if (!again.error) result = again;
          else { await sleep(6000); if (await alreadyInChat(job.wa_chat_id, job.body)) result = { ok: true }; }
        }
      }
      if (result.error) throw new Error(result.error);
      await api(`/api/bot/sends/${job.id}`, { status: 'sent', wa_message_id: result.id || null });
      sent++; inARow = 0; log(`  ✓ sent to ${job.community}`);
    } catch (e) {
      failed++; inARow++; log(`  ✗ ${job.community}: ${e.message || e}`);
      try { await api(`/api/bot/sends/${job.id}`, { status: 'failed', error: plainError(e) }); } catch {}
    }
    done = i + 1;
    if (inARow >= STOP_AFTER_FAILS) { paused = true; break; }
  }
  if (paused) {
    // protect the number: don't keep hammering WhatsApp; the rest wait for a person to look
    log(`${STOP_AFTER_FAILS} problems in a row: sending paused`);
    try { await api('/api/bot/sends/pause', { reason: `Not sent: sending paused after ${STOP_AFTER_FAILS} problems in a row, to keep the WhatsApp number safe. Fix the problem shown above, then click Try again.` }); } catch {}
    return { total, sent, failed, left: 0, paused: true };
  }
  const left = total - done;
  if (left > 0 && room - sent > 0) { try { await api('/api/bot/sends/continue', {}); log(`${left} messages left; asked for another run`); } catch (e) { log('Could not ask for another run:', e.message); } }
  return { total, sent, failed, left };
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
    // A community's main ("parent") group only holds the admins and nobody posts in it; members get posts in its
    // announcement group, which carries the same name. Tracking both made every community appear twice, so a
    // parent group is never tracked, even if it was ticked before.
    const parent = !!md.isParentGroup;
    const auto = !parent && (GROUP_FILTER ? GROUP_FILTER.test(g.name || '') : isCommunityAnnouncementGroup(g));
    const tracked = !parent && (picked ? picked.has(g.id._serialized) : auto);
    const members = (md.participants || []).length || Number(md.size) || 0;
    return { chat: g, id: g.id._serialized, name: g.name || '(no name)', members, auto, tracked, parent, created: createdAt(md) };
  }).sort((a, b) => (b.tracked - a.tracked) || (b.created - a.created) || (b.members - a.members));

  log(`Found ${groups.length} groups, newest first. (tracked = *)`);
  for (const g of list) log(`  ${g.tracked ? '*' : ' '} ${g.name}  [members=${g.members}, made ${g.created ? new Date(g.created * 1000).toISOString().slice(0, 10) : '?'}${g.parent ? ', community main group - skipped' : ''}]`);
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
    groups: list.map(({ id, name, members, auto, tracked, parent, created }) => ({ id, name, members, auto, tracked, parent, created })),
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
