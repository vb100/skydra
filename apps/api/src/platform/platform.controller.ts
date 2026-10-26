import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AUTH_DEPS } from '../auth/auth.module-tokens';
import { type AuthDeps, issueLink, type Session } from '../auth/auth.service';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { linkUrl } from '../http/links';
import { CurrentSession, PlatformAdminGuard, SessionGuard } from '../http/session';
import { createOrganization, CreateOrganizationInput, withPlatform } from './platform';

const LinkPurposeBody = z.object({ purpose: z.enum(['INVITE', 'PASSWORD_RESET']) });

/** SkyDra staff: create and list organizations, help members who cannot sign in. */
@Controller('platform')
@UseGuards(SessionGuard, PlatformAdminGuard)
export class PlatformController {
  constructor(
    @Inject(AUTH_DEPS) private readonly deps: AuthDeps,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('organizations')
  listOrganizations(@CurrentSession() session: Session) {
    return withPlatform(this.deps.pool, session.userId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, name, plan_code AS "planCode", status, country_code AS "countryCode",
                created_at AS "createdAt"
           FROM organizations ORDER BY created_at DESC`,
      );
      return rows;
    });
  }

  @Post('organizations')
  async createOrganization(@CurrentSession() session: Session, @Body() body: unknown) {
    const input = CreateOrganizationInput.parse(body);
    const org = await withPlatform(this.deps.pool, session.userId, (c) =>
      createOrganization(c, input),
    );
    const { token } = await issueLink(
      this.deps,
      { userId: session.userId, activeOrganizationId: null },
      { userId: org.adminUserId, organizationId: org.organizationId, purpose: 'INVITE' },
    );
    return { ...org, inviteUrl: linkUrl(this.config, token) };
  }

  @Post('organizations/:organizationId/users/:userId/links')
  async issueLink(
    @CurrentSession() session: Session,
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    const { purpose } = LinkPurposeBody.parse(body);
    const { token } = await issueLink(
      this.deps,
      { userId: session.userId, activeOrganizationId: null },
      { userId, organizationId, purpose },
    );
    return { url: linkUrl(this.config, token) };
  }
}
