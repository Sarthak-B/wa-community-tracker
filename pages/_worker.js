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
// tracked links always look like /<page>-<2-6 tag characters>
const LINK_RE = new RegExp(`^/([a-z0-9][a-z0-9-]{0,60}-[${TAG_CHARS}]{2,6})/?$`, 'i');

const redirect = (location) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    const m = (request.method === 'GET' || request.method === 'HEAD') && LINK_RE.exec(url.pathname);
    if (!m) return redirect(FALLBACK);
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
        signal: AbortSignal.timeout(4000),
      });
      const location = res.headers.get('location');
      if (location && res.status >= 300 && res.status < 400) return redirect(location);
    } catch (e) { /* tracker unreachable */ }
    return redirect(FALLBACK);
  },
};
