/**
 * Operations command: grants a role to a user who has already signed in once through DWS Hub.
 * Used to bootstrap the first Super Admins (SoD-4 needs two); afterwards roles are managed in the app.
 *
 * Usage: npm run grant:role -- --email alice@corp.example --role SUPER_ADMIN --reason "Initial platform owner"
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../config';
import { createPool } from '../db/db.service';

async function main() {
  loadDotEnv(resolve(process.cwd(), '../.env'));
  const { values } = parseArgs({ options: { email: { type: 'string' }, role: { type: 'string' }, reason: { type: 'string' } } });
  if (!values.email || !values.role || !values.reason) throw new Error('--email, --role and --reason are required');

  const pool = createPool(process.env.DATABASE_URL!);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string; status: string }>('SELECT id, status FROM ecr.app_user WHERE email = $1 FOR UPDATE', [values.email]);
    if (!user.rows[0]) throw new Error(`No ECR account for ${values.email}. The person must sign in through DWS Hub once first.`);
    if (user.rows[0].status !== 'ACTIVE') throw new Error(`Account is ${user.rows[0].status}, not ACTIVE.`);
    const role = await client.query<{ id: string }>('SELECT id FROM ecr.role WHERE code = $1', [values.role.toUpperCase()]);
    if (!role.rows[0]) throw new Error(`Unknown role ${values.role}`);

    const granted = await client.query(
      `INSERT INTO ecr.user_role (user_id, role_id, granted_by) VALUES ($1, $2, NULL)
       ON CONFLICT (user_id, role_id) WHERE revoked_at IS NULL DO NOTHING`,
      [user.rows[0].id, role.rows[0].id],
    );
    if (!granted.rowCount) {
      console.log(`${values.email} already has ${values.role.toUpperCase()}.`);
      await client.query('ROLLBACK');
      return;
    }
    // New privileges apply from the next sign-in (shorter idle timeout, authenticator enrolment).
    await client.query(
      `UPDATE ecr.user_session SET revoked_at = now(), revoke_reason = 'ADMIN_REVOKE' WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.rows[0].id],
    );
    await client.query(
      `INSERT INTO ecr.audit_event (actor_kind, action, entity_type, entity_id, after, reason)
       VALUES ('SYSTEM', 'ROLE_GRANTED_CLI', 'APP_USER', $1, $2, $3)`,
      [user.rows[0].id, JSON.stringify({ role: values.role.toUpperCase(), osUser: process.env.USERNAME ?? process.env.USER ?? null }), values.reason],
    );
    await client.query('COMMIT');
    console.log(`Granted ${values.role.toUpperCase()} to ${values.email}.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
