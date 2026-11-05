import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';

/**
 * Private object storage for source documents. Local development and tests use a directory; UAT and production
 * use an Alibaba Cloud OSS bucket with server-side encryption behind the same two calls (Technical Design §4.2.2).
 */
export interface ObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Removes an object; a missing object is not an error. */
  delete(key: string): Promise<void>;
}

export class DirectoryObjectStore implements ObjectStore {
  private readonly root: string;

  /**
   * `createRoot: false` for a folder on the shared Synology NAS: ECR writes only inside it and never creates it, so a
   * missing mount or folder fails loudly instead of writing to the server's disk or next to another system's files.
   */
  constructor(root: string, private readonly options: { createRoot: boolean } = { createRoot: true }) {
    this.root = resolve(root);
  }

  /** Checks at start-up that the folder exists (or creates a local one) and that ECR can write in it. */
  async assertWritable(): Promise<void> {
    if (this.options.createRoot) await mkdir(this.root, { recursive: true });
    else await this.requireRoot();
    const probe = join(this.root, `.ecr-write-check-${process.pid}`);
    try {
      await writeFile(probe, 'ok');
    } catch (err) {
      throw new Error(`Cannot write in the storage folder ${this.root}: ${(err as Error).message}`);
    } finally {
      await rm(probe, { force: true });
    }
  }

  private async requireRoot(): Promise<void> {
    const info = await stat(this.root).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`The storage folder ${this.root} does not exist. On the Synology NAS, ECR's project folder must be created (and bound into the container) before ECR starts; ECR does not create it.`);
    }
  }

  private path(key: string): string {
    if (!/^[a-z0-9/_.-]+$/.test(key) || key.includes('..')) throw new Error(`Invalid object key ${key}`);
    return join(this.root, key);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const target = this.path(key);
    if (!this.options.createRoot) await this.requireRoot();
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, body, { flag: 'w' });
    await rename(temp, target);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export type ScanResult = { verdict: 'CLEAN' } | { verdict: 'INFECTED'; signature: string } | { verdict: 'NOT_SCANNED' };

export interface MalwareScanner {
  scan(body: Buffer): Promise<ScanResult>;
}

/** Used only where scanning is not required (local development, tests without a scanner). */
export class NoScanner implements MalwareScanner {
  async scan(): Promise<ScanResult> {
    return { verdict: 'NOT_SCANNED' };
  }
}

/** ClamAV daemon over TCP using the INSTREAM command (US-21-N1 AC1). */
export class ClamdScanner implements MalwareScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(body: Buffer): Promise<ScanResult> {
    return new Promise((resolvePromise, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('clamd timed out')));
      socket.on('error', reject);
      socket.on('data', (c) => chunks.push(c));
      socket.on('end', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        if (/: OK$/.test(reply)) return resolvePromise({ verdict: 'CLEAN' });
        const found = /: (.+) FOUND$/.exec(reply);
        if (found) return resolvePromise({ verdict: 'INFECTED', signature: found[1] });
        reject(new Error(`Unexpected clamd reply: ${reply.slice(0, 200)}`));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < body.length; i += 64 * 1024) {
          const chunk = body.subarray(i, i + 64 * 1024);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}

/** Real PDF by content, not by name or declared type: the header must appear in the first 1 KiB. */
export function looksLikePdf(body: Buffer): boolean {
  return body.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}
