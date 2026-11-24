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
import { SCREENING_PROVIDER, type ScreeningProvider } from '../screening/provider';
import { autoScreen } from '../screening/screening';
import { REGISTRY_PROVIDER, type RegistryProvider } from './registry-provider';

/** Registry data, ownership and beneficial owners of the legal entities in a case. */
@Controller('cases/:id')
@UseGuards(SessionGuard, OrganizationGuard)
export class OwnershipController {
  constructor(
    @Inject(AUTH_DEPS) private readonly deps: AuthDeps,
    @Inject(REGISTRY_PROVIDER) private readonly registry: RegistryProvider,
    @Inject(SCREENING_PROVIDER) private readonly screening: ScreeningProvider,
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
    return this.run(principal, (c) =>
      listOwnership(c, this.deps.keys, principal.organizationId, id),
    );
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

  /** Links the beneficial owners and the manager, then screens each new link at once. */
  @Post('ownership/:snapshotId/link-owners')
  async link(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('snapshotId') snapshotId: string,
  ) {
    const linked = await this.run(principal, (c) =>
      linkBeneficialOwners(c, this.deps.keys, principal.organizationId, id, snapshotId),
    );
    const screening = linked.casePartyIds.length
      ? await autoScreen(
          this.deps.pool,
          this.context(principal),
          this.screening,
          id,
          linked.casePartyIds,
        )
      : 'SKIPPED';
    return { ...linked, screening };
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
