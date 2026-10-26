import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { type Action, can, type Principal } from '../access/policy';
import { AUTH_DEPS } from '../auth/auth.module-tokens';
import { type AuthDeps, issueLink, type Session } from '../auth/auth.service';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { withTenant } from '../database/tenant';
import { linkUrl } from '../http/links';
import { CurrentPrincipal, CurrentSession, OrganizationGuard, SessionGuard } from '../http/session';
import { addMember, listMembers, updateMember } from './members';

/** Actions inside the active organization. */
@Controller('organization')
@UseGuards(SessionGuard, OrganizationGuard)
export class OrganizationController {
  constructor(
    @Inject(AUTH_DEPS) private readonly deps: AuthDeps,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private require(principal: Principal, action: Action): void {
    if (!can(principal, action)) throw new ForbiddenException({ error: 'forbidden' });
  }

  private tenant(principal: Principal) {
    return { organizationId: principal.organizationId, userId: principal.userId };
  }

  private async link(
    session: Session,
    principal: Principal,
    userId: string,
    purpose: 'INVITE' | 'PASSWORD_RESET',
  ) {
    const { token } = await issueLink(
      this.deps,
      { userId: session.userId, activeOrganizationId: principal.organizationId },
      { userId, organizationId: principal.organizationId, purpose },
    );
    return linkUrl(this.config, token);
  }

  @Get('members')
  members(@CurrentPrincipal() principal: Principal) {
    this.require(principal, 'member.view');
    return withTenant(this.deps.pool, this.tenant(principal), listMembers);
  }

  @Post('members')
  async addMember(
    @CurrentSession() session: Session,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ) {
    this.require(principal, 'member.manage');
    const added = await withTenant(this.deps.pool, this.tenant(principal), (c) =>
      addMember(c, body as never),
    );
    // A brand-new person gets an invitation link; an existing user simply sees the organization.
    const inviteUrl = added.needsInvite
      ? await this.link(session, principal, added.userId, 'INVITE')
      : null;
    return { userId: added.userId, inviteUrl };
  }

  @Post('members/:userId')
  @HttpCode(204)
  async updateMember(
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    this.require(principal, 'member.manage');
    await withTenant(this.deps.pool, this.tenant(principal), (c) =>
      updateMember(c, userId, body as never),
    );
  }

  @Post('members/:userId/invite')
  async reinvite(
    @CurrentSession() session: Session,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
  ) {
    this.require(principal, 'member.manage');
    return { url: await this.link(session, principal, userId, 'INVITE') };
  }

  @Post('members/:userId/password-reset')
  async passwordReset(
    @CurrentSession() session: Session,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
  ) {
    this.require(principal, 'member.manage');
    return { url: await this.link(session, principal, userId, 'PASSWORD_RESET') };
  }
}
