import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, type Principal } from '../access/policy';
import { AUTH_DEPS } from '../auth/auth.module-tokens';
import type { AuthDeps } from '../auth/auth.service';
import { withTenant } from '../database/tenant';
import { RuleError } from '../domain-errors';
import { CurrentPrincipal, OrganizationGuard, SessionGuard } from '../http/session';
import { FILE_STORE, type FileStore } from '../storage/file-store';
import { listDocuments, readDocument, uploadDocument } from './documents';

/**
 * Documents of a case. An upload is the file itself as the request body (no multipart), with
 * what it is in the query; a download is a plain GET, so a link works on any device.
 */
@Controller('cases/:id/documents')
@UseGuards(SessionGuard, OrganizationGuard)
export class DocumentsController {
  constructor(
    @Inject(AUTH_DEPS) private readonly deps: AuthDeps,
    @Inject(FILE_STORE) private readonly store: FileStore,
  ) {}

  private context(principal: Principal) {
    if (!can(principal, 'case.view_own') && !can(principal, 'case.view_all'))
      throw new ForbiddenException({ error: 'forbidden' });
    return { organizationId: principal.organizationId, userId: principal.userId };
  }

  @Get()
  list(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return withTenant(this.deps.pool, this.context(principal), (c) => listDocuments(c, id));
  }

  @Post()
  upload(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query() query: Record<string, string>,
    @Req() request: FastifyRequest,
  ) {
    if (!Buffer.isBuffer(request.body)) throw new RuleError('send the file as the request body');
    const body = request.body;
    return withTenant(this.deps.pool, this.context(principal), (c) =>
      uploadDocument(c, this.store, id, query as never, body),
    );
  }

  @Get(':documentId/file')
  async download(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { document, body } = await withTenant(this.deps.pool, this.context(principal), (c) =>
      readDocument(c, this.store, id, documentId),
    );
    void reply
      .header('content-type', document.contentType)
      .header(
        'content-disposition',
        `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
      )
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('x-content-sha256', document.sha256);
    return body;
  }
}
