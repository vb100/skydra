import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
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

  /**
   * Screening volume per month and organization (cost overview): finished checks by origin and
   * answered provider requests. Counters only; no tenant data leaves the organizations.
   */
  @Get('usage')
  usage(@CurrentSession() session: Session, @Query('months') months?: string) {
    const n = z.coerce
      .number()
      .int()
      .min(1)
      .max(24)
      .catch(6)
      .parse(months ?? 6);
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1));
    return withPlatform(this.deps.pool, session.userId, async (c) => {
      const { rows } = await c.query(
        `SELECT to_char(month, 'YYYY-MM') AS month, organization_id AS "organizationId",
                organization, checks, monitoring_checks AS "monitoringChecks",
                failed_checks AS "failedChecks", opensanctions_requests AS "openSanctions",
                brave_requests AS "brave", gdelt_requests AS "gdelt"
           FROM app.platform_provider_usage($1)`,
        [from.toISOString().slice(0, 10)],
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
