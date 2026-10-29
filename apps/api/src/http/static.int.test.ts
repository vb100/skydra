import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.factory';
import { loadConfig } from '../config/env';
import { migrate } from '../database/migrator';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';

describe('serving the web app from the API origin', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.owner, MIGRATIONS_DIR);
    dir = mkdtempSync(join(tmpdir(), 'skydra-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SkyDra</title>');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    const config = loadConfig({
      APP_ENV: 'demo',
      DATABASE_URL: 'postgres://unused@localhost/unused',
      PUBLIC_APP_URL: 'https://demo.skydra.eu',
      SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      WEB_DIST_DIR: dir,
      SCREENING_PROVIDER: 'MOCK',
      IDENTITY_PROVIDER: 'MOCK',
      REGISTRY_PROVIDER: 'MOCK',
    });
    app = await createApp(config, { pool: db.appPool({ max: 2 }), logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string) => app.inject({ method: 'GET', url });

  it('serves index.html for the root and for client-side routes, never cached', async () => {
    for (const url of ['/', '/cases/123', '/activate']) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<title>SkyDra</title>');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('caches hashed assets for a year', async () => {
    const res = await get('/assets/index-abc123.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('keeps API routes and errors JSON, uncached', async () => {
    const health = await get('/api/health');
    expect(health.json()).toMatchObject({ status: 'ok', env: 'demo' });
    expect(health.headers['cache-control']).toBe('no-store');
    const unknown = await get('/api/does-not-exist');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).not.toContain('<title>');
  });

  it('sends security headers, HSTS outside local', async () => {
    const res = await get('/');
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
    });
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('never serves files outside the web directory', async () => {
    for (const url of ['/../package.json', '/%2e%2e/%2e%2e/etc/passwd', '/assets/../../x']) {
      const res = await get(url);
      expect(res.body).not.toContain('"name"');
      expect(res.body).not.toContain('root:');
    }
  });
});
