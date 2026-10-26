import cookie from '@fastify/cookie';
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

  return app;
}
