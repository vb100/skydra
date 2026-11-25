import { Controller, ForbiddenException, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { can, type Principal } from '../access/policy';
import { AUTH_DEPS } from '../auth/auth.module-tokens';
import type { AuthDeps } from '../auth/auth.service';
import { withTenant } from '../database/tenant';
import { CurrentPrincipal, OrganizationGuard, SessionGuard } from '../http/session';
import { getClient, listClients } from './clients';

/**
 * The clients of the organization (client answer Q7): who sees cases sees their clients, and
 * row-level security decides which (a broker, those of their own cases).
 */
@Controller('clients')
@UseGuards(SessionGuard, OrganizationGuard)
export class ClientsController {
  constructor(@Inject(AUTH_DEPS) private readonly deps: AuthDeps) {}

  private context(principal: Principal) {
    if (!can(principal, 'case.view_own') && !can(principal, 'case.view_all'))
      throw new ForbiddenException({ error: 'forbidden' });
    return { organizationId: principal.organizationId, userId: principal.userId };
  }

  @Get()
  list(@CurrentPrincipal() principal: Principal) {
    return withTenant(this.deps.pool, this.context(principal), (c) =>
      listClients(c, this.deps.keys),
    );
  }

  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return withTenant(this.deps.pool, this.context(principal), (c) =>
      getClient(c, this.deps.keys, id),
    );
  }
}
