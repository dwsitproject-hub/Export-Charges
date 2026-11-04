import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface HubClaims {
  sub: string;
  email?: string;
  name?: string;
}

const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
// DWS Hub signs with asymmetric keys only; HS256 and "none" are refused (contract §8).
const ALLOWED_ALGS = ['RS256', 'ES256'];

/**
 * OIDC client for DWS Hub in strict mode: authorization code + PKCE (S256), ID token verified
 * against the Hub JWKS (Technical Design §4.1.1). ECR is a public client and stores no Hub tokens.
 */
@Injectable()
export class OidcService {
  private discovery?: { doc: Discovery; fetchedAt: number };
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get redirectUri(): string {
    return `${this.config.publicBaseUrl}/api/auth/callback`;
  }

  async getDiscovery(): Promise<Discovery> {
    if (this.discovery && Date.now() - this.discovery.fetchedAt < DISCOVERY_TTL_MS) {
      return this.discovery.doc;
    }
    const doc = (await this.hubFetch(this.config.hubDiscoveryUrl, { method: 'GET' }).then((r) => {
      if (!r.ok) throw new ApiError(503, 'HUB_UNAVAILABLE', 'DWS Hub is unavailable.');
      return r.json();
    })) as Partial<Discovery>;

    for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof doc[key] !== 'string' || !doc[key]) {
        throw new ApiError(503, 'HUB_UNAVAILABLE', `DWS Hub discovery document lacks ${key}.`);
      }
    }
    if (doc.issuer!.replace(/\/+$/, '') !== this.config.hubIssuer) {
      throw new ApiError(503, 'HUB_MISCONFIGURED', 'DWS Hub issuer does not match HUB_ISSUER.');
    }
    this.discovery = { doc: doc as Discovery, fetchedAt: Date.now() };
    this.jwks = createRemoteJWKSet(new URL(doc.jwks_uri!), {
      timeoutDuration: this.config.hubTimeoutMs,
      cooldownDuration: 30_000, // refetch on unknown kid at most every 30 s (T-09)
      cacheMaxAge: 6 * 60 * 60 * 1000,
    });
    return this.discovery.doc;
  }

  async authorizeUrl(p: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
    const { authorization_endpoint } = await this.getDiscovery();
    const url = new URL(authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.oidcClientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('code_challenge', p.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', p.state);
    url.searchParams.set('nonce', p.nonce);
    return url.toString();
  }

  /** Exchanges the code for an ID token. Never retried on a rejection: codes are single-use. */
  async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const { token_endpoint } = await this.getDiscovery();
    const res = await this.hubFetch(token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.config.oidcClientId,
        code_verifier: codeVerifier,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown };
    if (!res.ok || typeof body.id_token !== 'string') {
      throw new ApiError(401, 'LOGIN_TOKEN_REJECTED', 'DWS Hub did not complete sign-in.', {
        hubError: typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
      });
    }
    return body.id_token;
  }

  async verifyIdToken(idToken: string, expectedNonce: string): Promise<HubClaims> {
    const discovery = await this.getDiscovery();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks!, {
        issuer: discovery.issuer,
        audience: this.config.oidcClientId,
        algorithms: ALLOWED_ALGS,
        clockTolerance: 60,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch (err) {
      const reason = err instanceof joseErrors.JOSEError ? err.code : 'UNKNOWN';
      throw new ApiError(401, 'LOGIN_TOKEN_INVALID', 'DWS Hub sign-in could not be verified.', { reason });
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new ApiError(401, 'LOGIN_TOKEN_INVALID', 'DWS Hub sign-in could not be verified.', { reason: 'MISSING_SUB' });
    }
    // The contract makes nonce optional; when the Hub echoes it, it must match (T-04).
    if (payload.nonce !== undefined && payload.nonce !== expectedNonce) {
      throw new ApiError(401, 'LOGIN_TOKEN_INVALID', 'DWS Hub sign-in could not be verified.', { reason: 'NONCE_MISMATCH' });
    }
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  }

  /**
   * Job jwks-refresh (Technical Design §4.2.7): reloads the discovery document and checks that the JWKS still
   * publishes signing keys ECR accepts, so a Hub change is noticed before people fail to sign in.
   */
  async refreshKeys(): Promise<{ issuer: string; keys: number; usable: number }> {
    this.discovery = undefined;
    const discovery = await this.getDiscovery();
    const res = await this.hubFetch(discovery.jwks_uri, { method: 'GET' });
    if (!res.ok) throw new ApiError(503, 'HUB_UNAVAILABLE', `DWS Hub JWKS answered ${res.status}.`);
    const body = (await res.json().catch(() => ({}))) as { keys?: { kty?: string; alg?: string; use?: string }[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const usable = keys.filter((k) => (k.use ?? 'sig') === 'sig' && (k.alg ? ALLOWED_ALGS.includes(k.alg) : k.kty === 'RSA' || k.kty === 'EC'));
    if (!usable.length) throw new ApiError(503, 'HUB_MISCONFIGURED', 'DWS Hub JWKS has no RS256 or ES256 signing key.');
    return { issuer: discovery.issuer, keys: keys.length, usable: usable.length };
  }

  private async hubFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.config.hubTimeoutMs) });
    } catch {
      throw new ApiError(503, 'HUB_UNAVAILABLE', 'DWS Hub is unavailable.');
    }
  }
}
