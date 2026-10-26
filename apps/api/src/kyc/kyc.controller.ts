import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { type Action, can, type Principal } from '../access/policy';
import { AUTH_DEPS } from '../auth/auth.module-tokens';
import type { AuthDeps } from '../auth/auth.service';
import { withTenant } from '../database/tenant';
import { CurrentPrincipal, OrganizationGuard, SessionGuard } from '../http/session';
import {
  decideApproval,
  escalate,
  getChecklist,
  listDecisions,
  requestApproval,
  resolveEscalation,
} from './decisions';
import {
  listIdentityVerifications,
  recordInPersonVerification,
  simulateRemoteVerification,
  startRemoteVerification,
} from './identity';
import { IDENTITY_PROVIDER, type IdentityProvider } from './identity-provider';

/**
 * Completing the KYC of a case: identity verification, approvals, escalations and the checklist.
 * Case visibility is decided by row-level security as for the case itself; deciding approvals and
 * resolving escalations additionally need the APPROVER / AML_OFFICER permission (checked here and
 * in the database).
 */
@Controller('cases/:id')
@UseGuards(SessionGuard, OrganizationGuard)
export class KycController {
  constructor(
    @Inject(AUTH_DEPS) private readonly deps: AuthDeps,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
  ) {}

  private context(principal: Principal, action?: Action) {
    const allowed = action
      ? can(principal, action)
      : can(principal, 'case.view_own') || can(principal, 'case.view_all');
    if (!allowed) throw new ForbiddenException({ error: 'forbidden' });
    return { organizationId: principal.organizationId, userId: principal.userId };
  }

  private run<T>(
    principal: Principal,
    work: Parameters<typeof withTenant<T>>[2],
    action?: Action,
  ): Promise<T> {
    return withTenant(this.deps.pool, this.context(principal, action), work);
  }

  @Get('checklist')
  checklist(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.run(principal, (c) => getChecklist(c, id));
  }

  @Get('identity-verifications')
  verifications(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.run(principal, (c) => listIdentityVerifications(c, this.deps.keys, id));
  }

  @Post('identity-verifications/in-person')
  inPerson(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.run(principal, (c) =>
      recordInPersonVerification(c, this.deps.keys, id, body as never),
    );
  }

  @Post('identity-verifications/remote')
  remote(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return startRemoteVerification(
      this.deps.pool,
      this.context(principal),
      this.identity,
      id,
      body as never,
    );
  }

  @Post('identity-verifications/:verificationId/simulate')
  simulate(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('verificationId') verificationId: string,
    @Body() body: unknown,
  ) {
    return this.run(principal, (c) =>
      simulateRemoteVerification(c, this.identity, id, verificationId, body as never),
    );
  }

  @Get('decisions')
  decisions(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.run(principal, (c) => listDecisions(c, id));
  }

  @Post('approvals')
  requestApproval(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.run(principal, (c) => requestApproval(c, id, body as never));
  }

  @Post('approvals/:approvalId/decide')
  decide(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('approvalId') approvalId: string,
    @Body() body: unknown,
  ) {
    return this.run(
      principal,
      (c) => decideApproval(c, id, approvalId, body as never),
      'case.approve',
    );
  }

  @Post('escalations')
  escalate(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.run(principal, (c) => escalate(c, id, body as never));
  }

  @Post('escalations/:escalationId/resolve')
  resolve(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('escalationId') escalationId: string,
    @Body() body: unknown,
  ) {
    return this.run(
      principal,
      (c) => resolveEscalation(c, id, escalationId, body as never),
      'aml.escalation_handle',
    );
  }
}
