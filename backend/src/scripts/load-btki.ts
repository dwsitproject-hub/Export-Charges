/**
 * Operations command: loads HS codes of a BTKI version from a CSV export of the tariff book (INSW / BTKI 2022),
 * so HS mappings can be validated against the complete list (BR-PRD-03). Existing codes get their description
 * refreshed; nothing is deleted.
 *
 * CSV: header row with columns `code` and `description`; codes with or without dots, 8 digits.
 * Usage: npm run load:btki -- --file btki-2022.csv --version "BTKI 2022" --reason "Load full BTKI 2022 from INSW"
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../config';
import { createPool } from '../db/db.service';
import { normaliseHs } from '../registry/entities';

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

async function main() {
  loadDotEnv(resolve(process.cwd(), '../.env'));
  const { values } = parseArgs({ options: { file: { type: 'string' }, version: { type: 'string' }, reason: { type: 'string' } } });
  if (!values.file || !values.version || !values.reason) throw new Error('--file, --version and --reason are required');

  // npm runs workspace scripts in backend/; resolve the file from where the operator ran the command.
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), values.file);
  const [header, ...rows] = parseCsv((await readFile(file, 'utf8')).replace(/^﻿/, ''));
  const codeCol = header.findIndex((h) => h.trim().toLowerCase() === 'code');
  const descCol = header.findIndex((h) => h.trim().toLowerCase() === 'description');
  if (codeCol < 0 || descCol < 0) throw new Error('The CSV needs a header row with "code" and "description" columns');

  const codes = new Map<string, string>();
  const bad: string[] = [];
  rows.forEach((r, i) => {
    const digits = normaliseHs(r[codeCol] ?? '');
    if (!digits) bad.push(`row ${i + 2}: "${r[codeCol]}"`);
    else codes.set(digits, (r[descCol] ?? '').trim());
  });
  if (bad.length) throw new Error(`Not 8-digit HS codes (nothing loaded):\n  ${bad.slice(0, 20).join('\n  ')}`);

  const pool = createPool(process.env.DATABASE_URL!);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const version = await client.query<{ id: string }>('SELECT id FROM ecr.btki_version WHERE label = $1', [values.version]);
    if (!version.rows[0]) throw new Error(`Unknown BTKI version "${values.version}"`);
    let added = 0;
    for (const [digits, description] of codes) {
      const res = await client.query<{ inserted: boolean }>(
        `INSERT INTO ecr.hs_code (btki_version_id, code_digits, description) VALUES ($1, $2, NULLIF($3, ''))
         ON CONFLICT (btki_version_id, code_digits) DO UPDATE SET description = EXCLUDED.description
         RETURNING (xmax = 0) AS inserted`,
        [version.rows[0].id, digits, description],
      );
      if (res.rows[0].inserted) added++;
    }
    await client.query(
      `INSERT INTO ecr.audit_event (actor_kind, action, entity_type, entity_id, after, reason)
       VALUES ('SYSTEM', 'BTKI_LOADED', 'BTKI_VERSION', $1, $2, $3)`,
      [version.rows[0].id, JSON.stringify({ file, codes: codes.size, added, osUser: process.env.USERNAME ?? process.env.USER ?? null }), values.reason],
    );
    await client.query('COMMIT');
    console.log(`${values.version}: ${codes.size} codes read, ${added} added, ${codes.size - added} updated.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && /load-btki\.[jt]s$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
