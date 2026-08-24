/**
 * Workaround for machines where Node's own DNS (c-ares) is configured with a
 * single dead `127.0.0.1` stub — a leftover from VPN / DNS-tool settings.
 * The OS resolver (dns.lookup / getaddrinfo) still works, so normal browsing
 * is fine, but `mongodb+srv://` connection strings fail with
 * `querySrv ECONNREFUSED` because SRV lookups use Node's resolver.
 *
 * This module only kicks in when the configured server list is EXACTLY
 * `['127.0.0.1']` (the broken state). Everywhere else — including Linux
 * servers like Render, where resolv.conf points at a real resolver — it does
 * nothing.
 *
 * Require it BEFORE any mongoose.connect call.
 */

const dns = require('dns');

const servers = dns.getServers();
if (servers.length === 1 && servers[0] === '127.0.0.1') {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
    console.log('⚠ Node DNS was pointed at a dead 127.0.0.1 stub — using 8.8.8.8 / 1.1.1.1 as a fallback.');
  } catch {
    // leave it alone if the override fails for any reason
  }
}
