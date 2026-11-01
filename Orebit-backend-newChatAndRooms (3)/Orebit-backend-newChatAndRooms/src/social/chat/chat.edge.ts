import type { IncomingHttpHeaders } from 'node:http';
import { config } from '../../config';

// True when Cloudflare reported the request as coming through Tor (`T1` in `cf-ipcountry`). Behind the same trust
// gate as the country in geo/cloudflare.ts: unless an operator declared Cloudflare as the ingress, the header is
// something a caller can write, so it is not read. It is the only anonymised-network signal available here; no
// VPN or proxy detection provider is connected, so a VPN is not detected.
// Chat's own copy, so geo/ stays untouched.
export function cloudflareAnonymised(headers: IncomingHttpHeaders): boolean {
  if (!config.trustCloudflareHeaders) return false;
  const raw = headers['cf-ipcountry'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().toUpperCase() === 'T1';
}
