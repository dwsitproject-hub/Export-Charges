import { randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

/** Client IP with the IPv4-mapped IPv6 prefix removed. Honors Express `trust proxy`. */
export function clientIp(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

/**
 * Defence in depth behind the WAF: only office and VPN ranges may call the API (NFR-SEC-07).
 * `cidrs` are like "10.20.0.0/16" or "::1/128".
 */
/** BlockList of the office and VPN networks (`a.b.c.d/nn`, IPv6 too; no prefix = one address). */
export function networkList(cidrs: string[]): BlockList {
  const allowed = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    allowed.addSubnet(address, Number(prefix ?? (family === 'ipv6' ? 128 : 32)), family);
  }
  return allowed;
}

export function ipAllowed(list: BlockList, ip: string): boolean {
  return !!ip && list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

/** Reads the allow-list on every request, so a change on the Configuration screen applies at once (F-52). */
export function networkGuard(cidrs: () => string[]) {
  let current: { source: string[]; list: BlockList } | null = null;
  return (req: Request, res: Response, next: NextFunction) => {
    // Health probes (Docker's own check from inside the container, load balancers) come from addresses outside the
    // list; they only report up/ready and expose no data.
    if (req.method === 'GET' && (req.path === '/api/health' || req.path === '/api/ready')) return next();
    const source = cidrs();
    if (current?.source !== source) current = { source, list: networkList(source) };
    if (ipAllowed(current.list, clientIp(req))) return next();
    res.status(403).json({
      error: {
        code: 'NETWORK_NOT_ALLOWED',
        message: 'ECR is available only from the office network or VPN.',
        traceId: res.locals.traceId,
      },
    });
  };
}

/** Trace id per request plus baseline security headers for API responses. */
export function requestBasics(req: Request, res: Response, next: NextFunction) {
  const traceId = randomUUID();
  res.locals.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}
