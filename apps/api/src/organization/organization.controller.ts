import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Action, can, type Principal } from '../access/policy';
import { AUTH_DEPS } from '../auth/auth.module-tokens';
import { type AuthDeps, issueLink, type Session } from '../auth/auth.service';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { withTenant } from '../database/tenant';
import { linkUrl } from '../http/links';
import { CurrentPrincipal, CurrentSession, OrganizationGuard, SessionGuard } from '../http/session';
import { RuleError } from '../domain-errors';
import { FILE_STORE, type FileStore } from '../storage/file-store';
import { addMember, listMembers, updateMember } from './members';
import { getProfile, readLogo, removeLogo, updateProfile, uploadLogo } from './profile';

/** Actions inside the active organization. */
@Controller('organization')
@UseGuards(SessionGuard, OrganizationGuard)
export class OrganizationController {
  constructor(
    @Inject(AUTH_DEPS) private readonly deps: AuthDeps,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FILE_STORE) private readonly store: FileStore,
  ) {}

  /** The agency's details for the case export (Q43): every member reads, the admin edits. */
  @Get('profile')
  profile(@CurrentPrincipal() principal: Principal) {
    this.require(principal, 'organization.view');
    return withTenant(this.deps.pool, this.tenant(principal), getProfile);
  }

  @Post('profile')
  @HttpCode(200)
  updateProfile(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    this.require(principal, 'organization.update');
    return withTenant(this.deps.pool, this.tenant(principal), (c) =>
      updateProfile(c, body as never),
    );
  }

  /** The logo is the request body itself (PNG or JPEG), like a case document. */
  @Post('logo')
  @HttpCode(200)
  uploadLogo(@CurrentPrincipal() principal: Principal, @Req() request: FastifyRequest) {
    this.require(principal, 'organization.update');
    if (!Buffer.isBuffer(request.body)) throw new RuleError('send the image as the request body');
    const body = request.body;
    return withTenant(this.deps.pool, this.tenant(principal), (c) =>
      uploadLogo(c, this.store, body),
    );
  }

  @Post('logo/remove')
  @HttpCode(200)
  removeLogo(@CurrentPrincipal() principal: Principal) {
    this.require(principal, 'organization.update');
    return withTenant(this.deps.pool, this.tenant(principal), removeLogo);
  }

  @Get('logo')
  async logo(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.require(principal, 'organization.view');
    const logo = await withTenant(this.deps.pool, this.tenant(principal), (c) =>
      readLogo(c, this.store),
    );
    if (!logo) {
      void reply.status(404);
      return { error: 'not_found' };
    }
    void reply
      .header('content-type', logo.contentType)
      .header('content-security-policy', "sandbox; default-src 'none'");
    return logo.body;
  }

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
