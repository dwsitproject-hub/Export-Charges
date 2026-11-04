/**
 * Local stand-in for DWS Hub so ECR can be run without registering it in the real Hub.
 * Same strict OIDC contract as the tests use. Development only — never deploy this.
 *
 *   npm run dev:hub
 *   Switch person: http://localhost:4000/dev/as?email=ani@corp.example&name=Ani%20Rahma
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadDotEnv } from '../src/config';
import { startHubStub } from './hub-stub';

loadDotEnv(resolve(process.cwd(), '../.env'));

const issuer = (process.env.HUB_ISSUER ?? 'http://localhost:4000').replace(/\/+$/, '');
const port = Number(new URL(issuer).port || 4000);
const clientId = process.env.OIDC_CLIENT_ID ?? 'ecr-local';
const redirectUri = `${(process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '')}/api/auth/callback`;

const asUser = (email: string, name: string) => ({
  sub: createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 32),
  email,
  name,
});

startHubStub(clientId, redirectUri, {
  port,
  // 0.0.0.0 inside the local Docker deployment, where the port is published to 127.0.0.1 only.
  host: process.env.DEV_HUB_HOST ?? 'localhost',
  issuer,
  devRoutes(url, res, stub) {
    if (url.pathname !== '/dev/as' && url.pathname !== '/dashboard') return false;
    if (url.pathname === '/dev/as') {
      const email = url.searchParams.get('email');
      if (email) stub.user = asUser(email, url.searchParams.get('name') ?? email);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`DWS Hub dev stub. Next sign-in: ${stub.user.name} <${stub.user.email}> (sub ${stub.user.sub})\n`);
    return true;
  },
}).then((stub) => {
  stub.user = asUser(process.env.DEV_HUB_EMAIL ?? 'dev.admin@corp.example', process.env.DEV_HUB_NAME ?? 'Dev Admin');
  console.log(`DWS Hub dev stub at ${issuer} for client ${clientId}; redirect ${redirectUri}`);
  console.log(`Signing in as ${stub.user.email}. Switch: ${issuer}/dev/as?email=someone@corp.example&name=Someone`);
});
