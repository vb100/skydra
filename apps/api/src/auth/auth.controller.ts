import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import {
  clearSessionCookie,
  CurrentSession,
  readSessionCookie,
  SessionGuard,
  setSessionCookie,
} from '../http/session';
import { AUTH_DEPS } from './auth.module-tokens';
import {
  type AuthDeps,
  AuthError,
  completeLink,
  describeLink,
  describeUser,
  login,
  logout,
  selectOrganization,
  type Session,
  startLink,
  verifySecondFactor,
} from './auth.service';

const LoginBody = z.object({ email: z.string().max(320), password: z.string().max(256) });
const MfaBody = z
  .object({ code: z.string().max(10).optional(), recoveryCode: z.string().max(32).optional() })
  .refine((b) => Boolean(b.code) !== Boolean(b.recoveryCode), 'exactly one of code, recoveryCode');
const LinkBody = z.object({ token: z.string().min(20).max(100) });
const CompleteBody = LinkBody.extend({
  password: z.string().max(256),
  totpCode: z.string().max(10),
});
const OrganizationBody = z.object({ organizationId: z.string() });

const meta = (request: FastifyRequest) => ({
  ip: request.ip,
  userAgent: request.headers['user-agent']?.slice(0, 300),
});

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AUTH_DEPS) private readonly deps: AuthDeps,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { pendingToken } = await login(this.deps, LoginBody.parse(body), meta(request));
    setSessionCookie(reply, this.config, pendingToken, 'pending');
    return { next: 'second_factor' };
  }

  @Post('second-factor')
  @HttpCode(200)
  async secondFactor(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const pending = readSessionCookie(request, this.config);
    if (!pending) throw new AuthError('no_session');
    const { sessionToken } = await verifySecondFactor(
      this.deps,
      pending,
      MfaBody.parse(body),
      meta(request),
    );
    setSessionCookie(reply, this.config, sessionToken, 'session');
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = readSessionCookie(request, this.config);
    if (token) await logout(this.deps, token);
    clearSessionCookie(reply, this.config);
  }

  @Get('me')
  @UseGuards(SessionGuard)
  async me(@CurrentSession() session: Session) {
    return {
      ...(await describeUser(this.deps, session.userId)),
      activeOrganizationId: session.activeOrganizationId,
    };
  }

  @Post('organization')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async chooseOrganization(@CurrentSession() session: Session, @Body() body: unknown) {
    await selectOrganization(this.deps, session, OrganizationBody.parse(body).organizationId);
  }

  // Link tokens travel in the request body, never in the URL, so they do not end up in logs.
  @Post('links/inspect')
  @HttpCode(200)
  inspectLink(@Body() body: unknown) {
    return describeLink(this.deps, LinkBody.parse(body).token);
  }

  @Post('links/start')
  @HttpCode(200)
  startLink(@Body() body: unknown) {
    return startLink(this.deps, LinkBody.parse(body).token);
  }

  @Post('links/complete')
  @HttpCode(200)
  completeLink(@Body() body: unknown) {
    return completeLink(this.deps, CompleteBody.parse(body));
  }
}
