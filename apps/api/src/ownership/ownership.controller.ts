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
import { can, type Principal } from '../access/policy';
import { AUTH_DEPS } from '../auth/auth.module-tokens';
import type { AuthDeps } from '../auth/auth.service';
import { withTenant } from '../database/tenant';
import { CurrentPrincipal, OrganizationGuard, SessionGuard } from '../http/session';
import { fetchOwnership, linkBeneficialOwners, listOwnership, resolveOwnership } from './ownership';
import { REGISTRY_PROVIDER, type RegistryProvider } from './registry-provider';

/** Registry data, ownership and beneficial owners of the legal entities in a case. */
@Controller('cases/:id')
@UseGuards(SessionGuard, OrganizationGuard)
export class OwnershipController {
  constructor(
    @Inject(AUTH_DEPS) private readonly deps: AuthDeps,
    @Inject(REGISTRY_PROVIDER) private readonly registry: RegistryProvider,
  ) {}

  private context(principal: Principal) {
    if (!can(principal, 'case.view_own') && !can(principal, 'case.view_all'))
      throw new ForbiddenException({ error: 'forbidden' });
    return { organizationId: principal.organizationId, userId: principal.userId };
  }

  private run<T>(principal: Principal, work: Parameters<typeof withTenant<T>>[2]): Promise<T> {
    return withTenant(this.deps.pool, this.context(principal), work);
  }

  @Get('ownership')
  list(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.run(principal, (c) => listOwnership(c, id));
  }

  @Post('parties/:casePartyId/ownership')
  fetch(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('casePartyId') casePartyId: string,
  ) {
    return fetchOwnership(
      this.deps.pool,
      this.context(principal),
      this.deps.keys,
      this.registry,
      id,
      casePartyId,
    );
  }

  @Post('ownership/:snapshotId/link-owners')
  link(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('snapshotId') snapshotId: string,
  ) {
    return this.run(principal, (c) =>
      linkBeneficialOwners(c, this.deps.keys, principal.organizationId, id, snapshotId),
    );
  }

  @Post('ownership/:snapshotId/resolve')
  resolve(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('snapshotId') snapshotId: string,
    @Body() body: unknown,
  ) {
    return this.run(principal, (c) => resolveOwnership(c, id, snapshotId, body as never));
  }
}
