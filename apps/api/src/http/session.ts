import '@fastify/cookie';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Principal } from '../access/policy';
import { loadPrincipal } from '../access/principal';
import { AUTH_DEPS } from '../auth/auth.module-tokens';
import { type AuthDeps, getSession, type Session, SESSION_POLICY } from '../auth/auth.service';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { withTenant } from '../database/tenant';
import { withPlatform } from '../platform/platform';

type AuthedRequest = FastifyRequest & { session?: Session; principal?: Principal };

/** `__Host-` binds the cookie to our exact origin over HTTPS; plain name only for local http. */
export function sessionCookieName(config: AppConfig): string {
  return config.env === 'local' ? 'skydra_session' : '__Host-skydra_session';
}

export function setSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
  token: string,
  kind: 'pending' | 'session',
): void {
  reply.setCookie(sessionCookieName(config), token, {
    httpOnly: true,
    secure: config.env !== 'local',
    sameSite: 'lax',
    path: '/',
    maxAge:
      kind === 'pending'
        ? SESSION_POLICY.pendingMinutes * 60
        : SESSION_POLICY.absoluteHours * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(sessionCookieName(config), { path: '/' });
}

export function readSessionCookie(request: FastifyRequest, config: AppConfig): string | undefined {
  return request.cookies[sessionCookieName(config)];
}

/** Requires a fully signed-in session (both factors). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AUTH_DEPS) private readonly deps: AuthDeps,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readSessionCookie(request, this.config);
    const session = token ? await getSession(this.deps, token) : null;
    if (!session) throw new UnauthorizedException({ error: 'no_session' });
    if (!session.mfaVerified) throw new UnauthorizedException({ error: 'mfa_required' });
    request.session = session;
    return true;
  }
}

/** SkyDra staff only. Must run after SessionGuard. */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(@Inject(AUTH_DEPS) private readonly deps: AuthDeps) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const userId = request.session?.userId;
    if (!userId) throw new UnauthorizedException({ error: 'no_session' });
    const isAdmin = await withPlatform(this.deps.pool, userId, async (c) => {
      const { rows } = await c.query<{ ok: boolean }>('SELECT app.is_platform_admin() AS ok');
      return rows[0]?.ok === true;
    });
    if (!isAdmin) throw new ForbiddenException({ error: 'forbidden' });
    return true;
  }
}

/** Requires an active organization with an active membership; resolves the acting principal. */
@Injectable()
export class OrganizationGuard implements CanActivate {
  constructor(@Inject(AUTH_DEPS) private readonly deps: AuthDeps) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const session = request.session;
    if (!session) throw new UnauthorizedException({ error: 'no_session' });
    if (!session.activeOrganizationId) {
      throw new ForbiddenException({ error: 'organization_required' });
    }
    const principal = await withTenant(
      this.deps.pool,
      { organizationId: session.activeOrganizationId, userId: session.userId },
      loadPrincipal,
    );
    if (!principal) throw new ForbiddenException({ error: 'forbidden' });
    request.principal = principal;
    return true;
  }
}

export const CurrentSession = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const session = context.switchToHttp().getRequest<AuthedRequest>().session;
  if (!session) throw new UnauthorizedException({ error: 'no_session' });
  return session;
});

export const CurrentPrincipal = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const principal = context.switchToHttp().getRequest<AuthedRequest>().principal;
  if (!principal) throw new ForbiddenException({ error: 'forbidden' });
  return principal;
});
