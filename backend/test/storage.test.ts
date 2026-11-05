import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { storageLocation } from '../src/common/storage-path';
import { DirectoryObjectStore } from '../src/registry/file-handling';

describe('file storage location (SYNOLOGY-INTEGRATION.md)', () => {
  const base = mkdtempSync(join(tmpdir(), 'ecr-storage-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('resolves STORAGE_LOCAL_PATH, then the Synology project folder, then STORAGE_DIR', () => {
    const syn = { STORAGE_SYNOLOGY_ROOT: '/mnt/synology', STORAGE_DEPLOYMENT: 'dev', STORAGE_PROJECT_SLUG: 'ECR' };
    expect(storageLocation({ ...syn, STORAGE_LOCAL_PATH: join(base, 'x') })).toEqual({ dir: join(base, 'x'), kind: 'local' });
    const nas = storageLocation(syn);
    expect(nas.kind).toBe('synology');
    expect(nas.dir.split(/[\\/]/).slice(-4)).toEqual(['mnt', 'synology', 'dev', 'ECR']);
    expect(storageLocation({ STORAGE_DIR: join(base, 'y') })).toEqual({ dir: join(base, 'y'), kind: 'local' });
    expect(() => storageLocation({ STORAGE_SYNOLOGY_ROOT: '/mnt/synology' })).toThrow(/all of/);
    expect(() => storageLocation({ ...syn, STORAGE_DEPLOYMENT: 'staging' })).toThrow(/dev or prod/);
    expect(() => storageLocation({ ...syn, STORAGE_PROJECT_SLUG: '../EOS' })).toThrow(/STORAGE_PROJECT_SLUG/);
  });

  it('never creates the project folder on the NAS, and writes only inside it', async () => {
    const project = join(base, 'APPs', 'dev', 'ECR');
    const store = new DirectoryObjectStore(project, { createRoot: false });
    await expect(store.assertWritable()).rejects.toThrow(/does not exist/);
    await expect(store.put('sources/2026/a.pdf', Buffer.from('x'))).rejects.toThrow(/does not exist/);
    expect(existsSync(join(base, 'APPs'))).toBe(false);

    mkdirSync(project, { recursive: true });
    await store.assertWritable();
    await store.put('sources/2026/a.pdf', Buffer.from('x'));
    expect((await store.get('sources/2026/a.pdf')).toString()).toBe('x');
    await expect(store.put('../EOS/a.pdf', Buffer.from('x'))).rejects.toThrow(/Invalid object key/);
  });
});
