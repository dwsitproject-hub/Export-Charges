import QRCode from 'qrcode';
import { useState, type FormEvent } from 'react';
import { confirmTotpEnrollment, Me, startTotpEnrollment } from '../api';
import { ErrorText, Page } from '../ui';

/** Authenticator enrolment for privileged roles (Technical Design §4.1.6). */
export function Authenticator({ me }: { me: Me }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function start() {
    setError(null);
    try {
      const { secret, otpauthUri } = await startTotpEnrollment();
      setSetup({ secret, qr: await QRCode.toDataURL(otpauthUri, { margin: 1, width: 200 }) });
    } catch (e) {
      setError(e);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setRecoveryCodes((await confirmTotpEnrollment(code.trim())).recoveryCodes);
    } catch (err) {
      setError(err);
    }
  }

  if (recoveryCodes) {
    return (
      <Page title="Authenticator set up">
        <p>Save these recovery codes somewhere safe. Each works once if you lose your phone. They are shown only now.</p>
        <pre style={{ background: 'var(--subtle)', padding: 16, columns: 2 }}>{recoveryCodes.join('\n')}</pre>
        <a href="/">Continue</a>
      </Page>
    );
  }

  if (me.totp.enrolled) {
    return (
      <Page title="Authenticator">
        <p>Your authenticator app is set up. If you lose it, use a recovery code or ask a User Administrator to reset it.</p>
      </Page>
    );
  }

  return (
    <Page title="Set up your authenticator">
      <p>
        {me.user.privileged
          ? 'Your role can change data or access, so ECR asks for a code from an authenticator app before sensitive actions.'
          : 'You can set up an authenticator app now; it is required only for privileged roles.'}
      </p>
      {!setup ? (
        <button onClick={start}>Start setup</button>
      ) : (
        <form onSubmit={confirm}>
          <p>Scan this code with Microsoft Authenticator, Google Authenticator or a similar app.</p>
          <img src={setup.qr} alt="QR code for your authenticator app" width={200} height={200} />
          <p style={{ fontSize: 13 }}>Can't scan? Enter this key: <code>{setup.secret}</code></p>
          <label>
            6-digit code from the app{' '}
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
          </label>{' '}
          <button type="submit" disabled={!/^\d{6}$/.test(code.trim())}>Confirm</button>
        </form>
      )}
      <ErrorText error={error} />
    </Page>
  );
}
