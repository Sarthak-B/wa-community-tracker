// Short-link address on Cloudflare Pages (free), e.g. https://flexisb.pages.dev/funnel-agent-replay-3b
// Deployed from the Mac with:  npx wrangler pages deploy pages --project-name <name> --branch main
// Secret (once):               npx wrangler pages secret put RELAY_KEY --project-name <name>
//                              (the same value as the tracker's RELAY_KEY)
//
// A tracked link is handed to the tracker, which counts the click and sends the visitor to the real page.
// Anything else (the bare address, typos, removed links) goes to the main site. Visitors never see an error.

const TRACKER = 'https://sb.flexicommunities.workers.dev'; // the tracker's link worker
const FALLBACK = 'https://sb.flexifunnels.com';             // where everything else goes
const TAG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
// tracked links look like /<page>-<2-6 tag characters>, or an older random code like /sRbWJc
const LINK_RE = /^\/([A-Za-z0-9][A-Za-z0-9-]{2,63})\/?$/;
const NOT_LINKS = new Set(['dashboard', 'health', 'api']); // tracker pages that must never be reachable from here

// Smart fallback: funnel-agent-replay-3b names its page, so if the tracker can't be reached the visitor still
// lands on https://sb.flexifunnels.com/funnel-agent-replay (the registration page), not the homepage.
const pageFor = (code) => {
  const m = new RegExp(`^([a-z0-9][a-z0-9-]*?)-[${TAG_CHARS}]{2,6}$`, 'i').exec(code);
  // only links made as <page>-<tag> name their page; older random codes go to the homepage
  return m && m[1].toLowerCase() !== 'wa' ? FALLBACK + '/' + m[1].toLowerCase() : FALLBACK;
};
const redirect = (location) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    const m = (request.method === 'GET' || request.method === 'HEAD') && LINK_RE.exec(url.pathname);
    if (!m || NOT_LINKS.has(m[1].toLowerCase())) return redirect(FALLBACK);
    try {
      const res = await fetch(TRACKER + '/' + m[1], {
        method: request.method,
        redirect: 'manual',
        headers: {
          'user-agent': request.headers.get('user-agent') || '',
          'x-relay-key': env.RELAY_KEY || '',
          'x-relay-ip': request.headers.get('cf-connecting-ip') || '',
          'x-relay-country': (request.cf && request.cf.country) || '',
        },
        signal: AbortSignal.timeout(3000),
      });
      const location = res.headers.get('location');
      if (location && res.status >= 300 && res.status < 400) return redirect(location);
    } catch (e) { /* tracker slow or unreachable */ }
    return redirect(pageFor(m[1])); // the page the link was made for
  },
};
