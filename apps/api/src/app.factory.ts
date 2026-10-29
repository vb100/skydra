import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import type { AppConfig } from './config/env';
import { HttpErrorFilter } from './http/errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-skydra-csrf';

/**
 * Builds the HTTP application. Shared by main.ts and the HTTP tests, so tests exercise the same
 * cookies, CSRF protection and error mapping as production.
 */
export async function createApp(
  config: AppConfig,
  options: { pool?: Pool; logger?: false } = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config, options.pool),
    // Behind the Google load balancer the client IP arrives in X-Forwarded-For.
    new FastifyAdapter({ trustProxy: config.env !== 'local', bodyLimit: 1_048_576 }),
    { logger: options.logger },
  );
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableShutdownHooks();

  const fastify = app.getHttpAdapter().getInstance();
  await fastify.register(cookie);

  // CSRF: state-changing requests must carry a custom header, which browsers only send from our
  // own origin (no CORS is enabled), and a present Origin must be ours. SameSite=Lax cookies are
  // the second layer.
  fastify.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (request.headers[CSRF_HEADER] !== '1' || (origin && origin !== config.publicAppUrl)) {
      await reply.status(403).send({ error: 'csrf_rejected' });
    }
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    securityHeaders(config, request.url, reply);
    return payload;
  });

  if (config.webDistDir) await serveWebApp(fastify, resolve(config.webDistDir));

  return app;
}

/**
 * Headers for every response. The CSP allows only our own scripts, styles and API; images may be
 * data URLs (the TOTP QR code and the favicon).
 */
function securityHeaders(config: AppConfig, url: string, reply: FastifyReply) {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'same-origin');
  reply.header('x-frame-options', 'DENY');
  reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  reply.header(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  if (config.env !== 'local')
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  if (url.startsWith('/api/')) reply.header('cache-control', 'no-store');
}

/**
 * Serves the built web app next to the API, so both share one origin (cookies and the CSRF Origin
 * check work without a proxy). Hashed assets are cached for a year; any other path that is not an
 * API route returns index.html for client-side routing.
 */
async function serveWebApp(fastify: FastifyInstance, root: string): Promise<void> {
  if (!existsSync(resolve(root, 'index.html'))) throw new Error(`no web app in ${root}`);
  await fastify.register(fastifyStatic, {
    root,
    wildcard: false,
    index: false,
    setHeaders: (res, path) => {
      res.header(
        'cache-control',
        path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  fastify.get('/*', async (request, reply) => {
    if (request.url.startsWith('/api')) return reply.status(404).send({ error: 'not_found' });
    return reply.header('cache-control', 'no-cache').sendFile('index.html');
  });
  fastify.get('/', async (_request, reply) =>
    reply.header('cache-control', 'no-cache').sendFile('index.html'),
  );
}
