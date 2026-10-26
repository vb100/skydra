import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { can, type Principal } from '../access/policy';
import { AUTH_DEPS } from '../auth/auth.module-tokens';
import type { AuthDeps } from '../auth/auth.service';
import { withTenant } from '../database/tenant';
import { SCREENING_PROVIDER, type ScreeningProvider } from '../screening/provider';
import { listScreenings, reviewMatch, runScreening } from '../screening/screening';
import { CurrentPrincipal, OrganizationGuard, SessionGuard } from '../http/session';
import {
  activateAml,
  addCaseParty,
  type CaseActor,
  createCase,
  getCase,
  listAssignees,
  listCases,
  removeCaseParty,
  updateCase,
  updateCaseParty,
} from './cases';
import { searchParties } from './parties';

/**
 * AML cases of the active organization. Every route requires case access (BROKER or MANAGER);
 * which cases are visible is then decided by row-level security, so a case that is not the
 * member's simply does not exist for them (404).
 */
@Controller()
@UseGuards(SessionGuard, OrganizationGuard)
export class CasesController {
  constructor(
    @Inject(AUTH_DEPS) private readonly deps: AuthDeps,
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

  private actor(principal: Principal): CaseActor {
    return {
      userId: principal.userId,
      organizationId: principal.organizationId,
      canAssign: can(principal, 'case.assign'),
    };
  }

  @Get('cases')
  list(@CurrentPrincipal() principal: Principal) {
    return this.run(principal, listCases);
  }

  @Get('cases/assignees')
  assignees(@CurrentPrincipal() principal: Principal) {
    return this.run(principal, listAssignees);
  }

  @Post('cases')
  create(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    if (!can(principal, 'case.create')) throw new ForbiddenException({ error: 'forbidden' });
    return this.run(principal, (c) => createCase(c, this.actor(principal), body as never));
  }

  @Get('cases/:id')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.run(principal, (c) => getCase(c, this.deps.keys, id));
  }

  @Post('cases/:id')
  @HttpCode(204)
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.run(principal, (c) => updateCase(c, this.actor(principal), id, body as never));
  }

  @Post('cases/:id/activate-aml')
  @HttpCode(204)
  async activateAml(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.run(principal, (c) => activateAml(c, id, body as never));
  }

  @Post('cases/:id/parties')
  addParty(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.run(principal, (c) =>
      addCaseParty(c, this.deps.keys, this.actor(principal), id, body as never),
    );
  }

  @Post('cases/:id/parties/:casePartyId')
  @HttpCode(204)
  async updateParty(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('casePartyId') casePartyId: string,
    @Body() body: unknown,
  ) {
    await this.run(principal, (c) => updateCaseParty(c, id, casePartyId, body as never));
  }

  @Post('cases/:id/parties/:casePartyId/remove')
  @HttpCode(204)
  async removeParty(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('casePartyId') casePartyId: string,
  ) {
    await this.run(principal, (c) => removeCaseParty(c, id, casePartyId));
  }

  @Get('cases/:id/screenings')
  screenings(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.run(principal, (c) => listScreenings(c, id));
  }

  @Post('cases/:id/screenings')
  screen(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return runScreening(
      this.deps.pool,
      this.context(principal),
      this.screening,
      id,
      (body ?? {}) as never,
    );
  }

  @Post('cases/:id/screening-matches/:matchId/review')
  review(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('matchId') matchId: string,
    @Body() body: unknown,
  ) {
    return this.run(principal, (c) => reviewMatch(c, id, matchId, body as never));
  }

  @Get('parties')
  parties(@CurrentPrincipal() principal: Principal, @Query('query') query = '') {
    return this.run(principal, (c) =>
      searchParties(c, this.deps.keys, principal.organizationId, query),
    );
  }
}
