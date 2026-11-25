import { RuleError } from '../domain-errors';

/**
 * Where case documents are kept. In GCP a private Cloud Storage bucket in the environment's
 * region, written with the application's service account, which may create and read objects but
 * not delete or replace them (Terraform). Locally the fake-gcs-server of infra/docker.
 */
export interface FileStore {
  /** Stores a new object; refuses to replace an existing one. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export const FILE_STORE = Symbol('FILE_STORE');

export class StorageError extends Error {
  override name = 'StorageError';
}

/** No bucket configured: documents cannot be added, and say so (a rule, not an outage). */
export class UnavailableFileStore implements FileStore {
  put(): Promise<void> {
    return Promise.reject(new RuleError('file storage is not configured'));
  }
  get(): Promise<Buffer> {
    return Promise.reject(new RuleError('file storage is not configured'));
  }
}

/** Tests: objects kept in memory, with the same no-overwrite rule. */
export class MemoryFileStore implements FileStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.objects.has(key)) return Promise.reject(new StorageError('object already exists'));
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    return o ? Promise.resolve(o.body) : Promise.reject(new StorageError('object not found'));
  }
}

export type GcsOptions = {
  bucket: string;
  /** https://storage.googleapis.com, or the emulator's address (then without credentials). */
  endpoint: string;
  emulator: boolean;
  fetch?: typeof fetch;
};

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/**
 * Cloud Storage JSON API. On Cloud Run the access token of the service account comes from the
 * metadata server; no key file exists anywhere.
 */
export class GcsFileStore implements FileStore {
  private token: { value: string; until: number } | null = null;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: GcsOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  private async headers(): Promise<Record<string, string>> {
    if (this.options.emulator) return {};
    if (!this.token || this.token.until < Date.now()) {
      const res = await this.fetch(METADATA_TOKEN_URL, {
        headers: { 'Metadata-Flavor': 'Google' },
      });
      if (!res.ok) throw new StorageError(`metadata token: HTTP ${res.status}`);
      const body = (await res.json()) as { access_token: string; expires_in: number };
      // Renewed a minute before it expires.
      this.token = { value: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    }
    return { Authorization: `Bearer ${this.token.value}` };
  }

  /** The local emulator starts empty: its bucket is created on first use. */
  private bucketReady = false;
  private async ensureEmulatorBucket(): Promise<void> {
    if (!this.options.emulator || this.bucketReady) return;
    const { endpoint, bucket } = this.options;
    const res = await this.fetch(`${endpoint}/storage/v1/b?project=local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bucket }),
    });
    if (!res.ok && res.status !== 409)
      throw new StorageError(`emulator bucket: HTTP ${res.status}`);
    this.bucketReady = true;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.ensureEmulatorBucket();
    const { endpoint, bucket } = this.options;
    // ifGenerationMatch=0: only if no object of that name exists.
    const params = new URLSearchParams({ uploadType: 'media', name: key, ifGenerationMatch: '0' });
    const res = await this.fetch(
      `${endpoint}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${params}`,
      {
        method: 'POST',
        headers: { ...(await this.headers()), 'Content-Type': contentType },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) throw new StorageError(`upload: HTTP ${res.status}`);
  }

  async get(key: string): Promise<Buffer> {
    const { endpoint, bucket } = this.options;
    const res = await this.fetch(
      `${endpoint}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media`,
      { headers: await this.headers(), signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) throw new StorageError(`download: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
