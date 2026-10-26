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
import { assessRisk, riskOverview } from './risk';

/** Risk assessment of a case (LT-RISK-01). Visibility follows the case. */
@Controller('cases/:id')
@UseGuards(SessionGuard, OrganizationGuard)
export class RiskController {
  constructor(@Inject(AUTH_DEPS) private readonly deps: AuthDeps) {}

  private run<T>(principal: Principal, work: Parameters<typeof withTenant<T>>[2]): Promise<T> {
    if (!can(principal, 'case.view_own') && !can(principal, 'case.view_all'))
      throw new ForbiddenException({ error: 'forbidden' });
    return withTenant(
      this.deps.pool,
      { organizationId: principal.organizationId, userId: principal.userId },
      work,
    );
  }

  @Get('risk')
  overview(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.run(principal, (c) => riskOverview(c, id));
  }

  @Post('risk-assessments')
  assess(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.run(principal, (c) => assessRisk(c, id, (body ?? {}) as never));
  }
}
