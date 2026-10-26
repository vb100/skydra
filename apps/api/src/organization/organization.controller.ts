import { Controller, ForbiddenException, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { can, type Principal } from '../access/policy';
import { AUTH_DEPS } from '../auth/auth.module-tokens';
import { type AuthDeps, issueLink, type Session } from '../auth/auth.service';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { linkUrl } from '../http/links';
import { CurrentPrincipal, CurrentSession, OrganizationGuard, SessionGuard } from '../http/session';

/** Actions inside the active organization. Member management grows here in the next PRs. */
@Controller('organization')
@UseGuards(SessionGuard, OrganizationGuard)
export class OrganizationController {
  constructor(
    @Inject(AUTH_DEPS) private readonly deps: AuthDeps,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('members/:userId/password-reset')
  async passwordReset(
    @CurrentSession() session: Session,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
  ) {
    if (!can(principal, 'member.manage')) throw new ForbiddenException({ error: 'forbidden' });
    const { token } = await issueLink(
      this.deps,
      { userId: session.userId, activeOrganizationId: principal.organizationId },
      { userId, organizationId: principal.organizationId, purpose: 'PASSWORD_RESET' },
    );
    return { url: linkUrl(this.config, token) };
  }
}
