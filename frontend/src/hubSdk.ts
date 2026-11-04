/**
 * DWS Hub SDK (page views, time in app, JS errors, bug reports and breadcrumbs for Sentinel). The script tag is added
 * at build time only when VITE_HUB_SDK_URL and VITE_HUB_SDK_KEY are set (vite.config.ts); without it these calls do
 * nothing. The reported identity is analytics-grade only, never used for access.
 */
interface DwsHubApi {
  identify(user: { id?: string; email?: string }): void;
  reset(): void;
  track(name: string, properties?: Record<string, unknown>): void;
}

const sdk = (): DwsHubApi | null => {
  const hub = (window as { DwsHub?: unknown }).DwsHub;
  return hub && typeof (hub as DwsHubApi).identify === 'function' ? (hub as DwsHubApi) : null;
};

/** The signed-in person: Hub user id (OIDC `sub`) when ECR knows it, and email. Cheap and idempotent. */
export function hubIdentify(user: { hubSubject: string | null; email: string }) {
  sdk()?.identify(user.hubSubject ? { id: user.hubSubject, email: user.email } : { email: user.email });
}

/** Sign-out: forget the user and start a new SDK session. */
export function hubReset() {
  sdk()?.reset();
}

/** A business action shown under "Tracked actions" in the Hub (name ≤ 80 chars, properties ≤ 2 KB). */
export function hubTrack(name: string, properties?: Record<string, unknown>) {
  sdk()?.track(name, properties);
}
