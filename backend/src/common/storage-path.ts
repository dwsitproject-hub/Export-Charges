import { join, resolve } from 'node:path';

export interface StorageLocation {
  /** Folder that holds every stored file (source documents, imports, exports, evidence packs, review reports). */
  dir: string;
  /**
   * `synology`: ECR's project folder on the shared NAS. It must already exist; ECR never creates it or anything above
   * it, so a missing mount cannot silently turn into files on the server's disk or folders in another system's area.
   */
  kind: 'synology' | 'local';
}

/**
 * Where files are stored (SYNOLOGY-INTEGRATION.md, "Path resolution"):
 *   1. STORAGE_LOCAL_PATH, as given;
 *   2. STORAGE_SYNOLOGY_ROOT/STORAGE_DEPLOYMENT/STORAGE_PROJECT_SLUG when all three are set (dev or prod, one folder name);
 *   3. STORAGE_DIR (older name), else var/storage.
 */
export function storageLocation(env: NodeJS.ProcessEnv): StorageLocation {
  const local = env.STORAGE_LOCAL_PATH?.trim();
  if (local) return { dir: resolve(local), kind: 'local' };

  const root = env.STORAGE_SYNOLOGY_ROOT?.trim();
  const deployment = env.STORAGE_DEPLOYMENT?.trim();
  const slug = env.STORAGE_PROJECT_SLUG?.trim();
  if (root || deployment || slug) {
    if (!root || !deployment || !slug) {
      throw new Error('Set all of STORAGE_SYNOLOGY_ROOT, STORAGE_DEPLOYMENT and STORAGE_PROJECT_SLUG, or none of them');
    }
    if (!['dev', 'prod'].includes(deployment)) throw new Error('STORAGE_DEPLOYMENT must be dev or prod');
    // One folder name: no separators or dots, so the path cannot leave APPs/{deployment}/.
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(slug)) throw new Error('STORAGE_PROJECT_SLUG must be 2–40 letters, digits, "-" or "_"');
    return { dir: join(resolve(root), deployment, slug), kind: 'synology' };
  }

  return { dir: resolve(env.STORAGE_DIR?.trim() || 'var/storage'), kind: 'local' };
}
