import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { can, type Principal } from '../access/policy';
import { AUTH_DEPS } from '../auth/auth.module-tokens';
import type { AuthDeps } from '../auth/auth.service';
import { withTenant } from '../database/tenant';
import { CurrentPrincipal, OrganizationGuard, SessionGuard } from '../http/session';
import { exportCase, listExports } from './case-report';

/**
 * PDF export of a completed case. A POST (with the CSRF header) rather than a download link: each
 * export is registered with its SHA-256 and must not be triggerable from another site.
 */
@Controller('cases/:id')
@UseGuards(SessionGuard, OrganizationGuard)
export class ExportController {
  constructor(@Inject(AUTH_DEPS) private readonly deps: AuthDeps) {}

  private context(principal: Principal) {
    if (!can(principal, 'case.view_own') && !can(principal, 'case.view_all'))
      throw new ForbiddenException({ error: 'forbidden' });
    return { organizationId: principal.organizationId, userId: principal.userId };
  }

  @Get('exports')
  list(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return withTenant(this.deps.pool, this.context(principal), (c) => listExports(c, id));
  }

  @Post('export.pdf')
  async export(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await withTenant(this.deps.pool, this.context(principal), (c) =>
      exportCase(c, this.deps.keys, id),
    );
    void reply
      .status(201)
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${result.reference}.pdf"`)
      .header('cache-control', 'no-store')
      .header('x-content-sha256', result.sha256)
      .header('x-export-id', result.exportId);
    return result.pdf;
  }
}
