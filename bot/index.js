// WhatsApp Community Tracker - reader bot
// Runs on GitHub Actions. Logs into WhatsApp Web (saved session), reads the messages
// YOUR account sent in each community announcement group, collects reads / reactions /
// replies and uploads them to the tracker Worker. It never sends anything.
//
//   MODE=login  -> link the WhatsApp account (pairing code or QR in the job log), save session
//   MODE=sync   -> normal scheduled run (default)

const { Client, LocalAuth } = require('whatsapp-web.js');

const env = process.env;
const MODE = (env.MODE || 'sync').toLowerCase();
const TRACKER_URL = (env.TRACKER_URL || '').replace(/\/+$/, '');
const INGEST_TOKEN = env.INGEST_TOKEN || '';
const LOOKBACK_DAYS = Number(env.LOOKBACK_DAYS || 14);
const MAX_MESSAGES = Number(env.MAX_MESSAGES_PER_GROUP || 300);
const GROUP_FILTER = env.GROUP_NAME_FILTER ? new RegExp(env.GROUP_NAME_FILTER, 'i') : null;
const PAIR_PHONE = (env.PAIR_PHONE || '').replace(/\D/g, '');
const HARD_TIMEOUT_MS = Number(env.HARD_TIMEOUT_MIN || 20) * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (MODE === 'sync' && (!TRACKER_URL || !INGEST_TOKEN)) {
  console.error('TRACKER_URL and INGEST_TOKEN must be set (GitHub repo secrets).');
  process.exit(1);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth', clientId: 'tracker' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
  ...(MODE === 'login' && PAIR_PHONE ? { pairWithPhoneNumber: { phoneNumber: PAIR_PHONE, showNotification: true } } : {}),
});

let finished = false;
async function finish(code, report) {
  if (finished) return;
  finished = true;
  if (report && TRACKER_URL && INGEST_TOKEN) await upload(report).catch(e => log('Upload failed:', e.message));
  try { await client.destroy(); } catch {}
  process.exit(code);
}
setTimeout(() => { log('Hard timeout reached'); finish(1, { status: 'error', note: 'Bot timed out', communities: [], messages: [] }); }, HARD_TIMEOUT_MS);

client.on('qr', qr => {
  if (MODE === 'login') {
    log('Scan this QR in WhatsApp > Linked devices > Link a device (or re-run with a phone number to get a pairing code):');
    require('qrcode-terminal').generate(qr, { small: true });
  } else {
    log('Session is not logged in. Run the workflow manually with mode = login.');
    finish(1, { status: 'logged_out', note: 'WhatsApp session expired - run the workflow with mode=login', communities: [], messages: [] });
  }
});
client.on('code', code => {
  log('================================================');
  log(`  PAIRING CODE:  ${code}`);
  log('  WhatsApp > Linked devices > Link a device >');
  log('  "Link with phone number instead" and type it.');
  log('================================================');
});
client.on('authenticated', () => log('Authenticated'));
client.on('auth_failure', m => { log('Auth failure:', m); finish(1, { status: 'logged_out', note: 'Auth failure: ' + m, communities: [], messages: [] }); });

client.on('ready', async () => {
  log('WhatsApp ready');
  if (MODE === 'login') {
    log('Linked. Waiting 60s so the session finishes syncing before it is saved...');
    await sleep(60000);
    return finish(0);
  }
  try {
    await sleep(15000); // let chats load
    const report = await collect();
    log(`Collected ${report.messages.length} messages from ${report.communities.length} groups`);
    await finish(0, report);
  } catch (e) {
    log('Sync error:', e.stack || e.message);
    await finish(1, { status: 'error', note: e.message, communities: [], messages: [] });
  }
});

function isCommunityAnnouncementGroup(chat) {
  const md = chat.groupMetadata || {};
  if (md.isParentGroup) return false;
  return !!(md.defaultSubgroup || (md.parentGroup && md.announce));
}

async function collect() {
  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);
  const me = client.info && client.info.wid && client.info.wid._serialized;

  log(`Found ${groups.length} groups. (tracked = *)`);
  const tracked = [];
  for (const g of groups) {
    const md = g.groupMetadata || {};
    const take = GROUP_FILTER ? GROUP_FILTER.test(g.name || '') : isCommunityAnnouncementGroup(g);
    log(`  ${take ? '*' : ' '} ${g.name}  [members=${(md.participants || []).length}${md.parentGroup ? ', in community' : ''}${md.defaultSubgroup ? ', announcements' : ''}]`);
    if (take) tracked.push(g);
  }
  if (!tracked.length) log('No groups tracked. Set GROUP_NAME_FILTER (a regex on group names) if auto-detection misses your communities.');

  const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  const communities = [];
  const messages = [];

  for (const chat of tracked) {
    const md = chat.groupMetadata || {};
    let name = chat.name;
    if (md.parentGroup && !GROUP_FILTER) {
      try {
        const parent = await client.getChatById(md.parentGroup._serialized || md.parentGroup);
        if (parent && parent.name) name = parent.name;
      } catch {}
    }
    communities.push({ wa_chat_id: chat.id._serialized, name, members: (md.participants || []).length });

    let all = [];
    try { all = await chat.fetchMessages({ limit: MAX_MESSAGES }); } catch (e) { log(`  ! could not read ${name}: ${e.message}`); continue; }
    const recent = all.filter(m => m.timestamp >= since);
    const mine = recent.filter(m => m.fromMe || (me && m.author === me));

    // replies = messages from others that quote one of ours
    const replyCount = {};
    for (const m of recent) {
      if (m.fromMe) continue;
      const q = m._data && (m._data.quotedStanzaID || (m._data.quotedMsgId && m._data.quotedMsgId.id));
      if (q) replyCount[q] = (replyCount[q] || 0) + 1;
    }

    log(`  ${name}: ${mine.length} of our messages in the last ${LOOKBACK_DAYS} days`);
    for (const m of mine) {
      if (['notification', 'e2e_notification', 'gp2', 'revoked'].includes(m.type)) continue;
      let delivered = 0, reads = 0, reactions = 0;
      try {
        const info = await m.getInfo();
        if (info) {
          const r = (info.read || []).length + (info.played || []).length;
          reads = r;
          delivered = (info.delivery || []).length + r;
        }
      } catch {}
      try {
        if (m.hasReaction) {
          const rs = await m.getReactions();
          reactions = (rs || []).reduce((s, r) => s + (r.senders || []).length, 0);
        }
      } catch {}
      const body = m.body || (m._data && (m._data.caption || m._data.text)) || `[${m.type}]`;
      messages.push({
        id: m.id._serialized, wa_chat_id: chat.id._serialized, sent_at: m.timestamp, body,
        delivered, reads, reactions, replies: replyCount[m.id.id] || 0,
      });
      await sleep(250);
    }
  }
  return { status: 'ok', communities, messages };
}

async function upload(report) {
  const res = await fetch(`${TRACKER_URL}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify(report),
  });
  log('Upload:', res.status, await res.text());
  if (!res.ok) throw new Error('upload returned ' + res.status);
}

log(`Starting in ${MODE} mode`);
client.initialize().catch(e => { log('Init failed:', e.message); finish(1, { status: 'error', note: 'Init failed: ' + e.message, communities: [], messages: [] }); });
