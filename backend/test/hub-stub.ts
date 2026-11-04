import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

export interface StubUser {
  sub: string;
  email?: string;
  name?: string;
}

/** Switches that make the stub misbehave in the ways the DWS Hub contract §8 lists. */
export interface StubMode {
  audience?: string;
  issuer?: string;
  signWithHs256?: boolean;
  expired?: boolean;
  /** undefined = echo the request nonce, null = omit it, string = send this value. */
  nonce?: string | null;
}

export interface HubStub {
  issuer: string;
  user: StubUser;
  mode: StubMode;
  close(): Promise<void>;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce?: string;
  user: StubUser;
  used: boolean;
}

export interface StubOptions {
  port?: number;
  host?: string;
  /** Issuer to advertise; defaults to http://<host>:<port>. Must equal ECR's HUB_ISSUER. */
  issuer?: string;
  /** Extra routes for local development (e.g. switching the signed-in person). */
  devRoutes?: (url: URL, res: http.ServerResponse, stub: HubStub) => boolean;
}

/** In-process stand-in for DWS Hub in strict OIDC mode (authorization code + PKCE, RS256 via JWKS). */
export async function startHubStub(clientId: string, redirectUri: string, options: StubOptions = {}): Promise<HubStub> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'hub-key-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, IssuedCode>();

  const stub: HubStub = {
    issuer: '',
    user: { sub: 'unset' },
    mode: {},
    close: () => new Promise((done) => server.close(() => done())),
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', stub.issuer);
    if (options.devRoutes?.(url, res, stub)) return;

    if (req.method === 'GET' && url.pathname === '/api/sso/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: stub.issuer,
        authorization_endpoint: `${stub.issuer}/api/sso/authorize`,
        token_endpoint: `${stub.issuer}/api/sso/token`,
        jwks_uri: `${stub.issuer}/api/sso/jwks`,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/sso/jwks') {
      return json(res, 200, { keys: [jwk] });
    }
    if (req.method === 'GET' && url.pathname === '/api/sso/bridge') {
      return json(res, 410, { error: 'bridge_disabled' });
    }
    if (req.method === 'GET' && url.pathname === '/api/sso/authorize') {
      const p = url.searchParams;
      if (p.get('response_type') !== 'code' || p.get('client_id') !== clientId || p.get('redirect_uri') !== redirectUri
        || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
        return json(res, 400, { error: 'invalid_request' });
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        clientId,
        redirectUri,
        challenge: p.get('code_challenge')!,
        nonce: p.get('nonce') ?? undefined,
        user: { ...stub.user },
        used: false,
      });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      if (p.get('state')) target.searchParams.set('state', p.get('state')!);
      res.writeHead(302, { Location: target.toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/sso/token') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const issued = codes.get(body.code);
      const challenge = createHash('sha256').update(String(body.code_verifier ?? '')).digest('base64url');
      if (!issued || issued.used || body.grant_type !== 'authorization_code' || body.client_id !== issued.clientId
        || body.redirect_uri !== issued.redirectUri || challenge !== issued.challenge) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      issued.used = true;
      return json(res, 200, {
        token_type: 'Bearer',
        expires_in: 60,
        id_token: await signIdToken(issued),
        scope: 'openid profile email',
      });
    }
    json(res, 404, { error: 'not_found' });
  });

  async function signIdToken(issued: IssuedCode): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const m = stub.mode;
    const claims: JWTPayload = { sub: issued.user.sub, user_id: issued.user.sub };
    if (issued.user.email) claims.email = issued.user.email;
    if (issued.user.name) claims.name = issued.user.name;
    const nonce = m.nonce === undefined ? issued.nonce : m.nonce;
    if (nonce !== null && nonce !== undefined) claims.nonce = nonce;

    const jwt = new SignJWT(claims)
      .setIssuer(m.issuer ?? stub.issuer)
      .setAudience(m.audience ?? issued.clientId)
      .setIssuedAt(m.expired ? now - 600 : now)
      .setExpirationTime(m.expired ? now - 300 : now + 60);
    if (m.signWithHs256) {
      return jwt.setProtectedHeader({ alg: 'HS256', kid: 'hub-key-1' }).sign(new TextEncoder().encode('x'.repeat(32)));
    }
    return jwt.setProtectedHeader({ alg: 'RS256', kid: 'hub-key-1' }).sign(privateKey);
  }

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((ready) => server.listen(options.port ?? 0, host, () => ready()));
  stub.issuer = options.issuer ?? `http://${host}:${(server.address() as AddressInfo).port}`;
  return stub;
}
