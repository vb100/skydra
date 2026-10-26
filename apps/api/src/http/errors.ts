import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { AuthError, type AuthErrorCode } from '../auth/auth.service';
import { MemberError } from '../organization/members';

const STATUS: Record<AuthErrorCode, number> = {
  invalid_credentials: 401,
  invalid_code: 401,
  no_session: 401,
  forbidden: 403,
  invalid_link: 400,
  invalid_input: 400,
};

/**
 * Maps domain errors to HTTP. Unexpected errors become a bare 500 without details, so internals
 * (SQL, stack traces) never reach the client; they are logged server-side.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (error instanceof AuthError) {
      const body: Record<string, string> = { error: error.code };
      // Refusal reasons from the database are written for administrators and safe to show.
      if (error.code === 'forbidden' || error.code === 'invalid_input')
        body.message = error.message;
      void reply.status(STATUS[error.code]).send(body);
      return;
    }
    if (error instanceof MemberError) {
      // Business-rule refusals (seat limit, last administrator…) written for the user.
      void reply.status(422).send({ error: 'rule_violation', message: error.message });
      return;
    }
    if (error instanceof ZodError) {
      void reply.status(400).send({ error: 'invalid_input' });
      return;
    }
    if (error instanceof HttpException) {
      void reply.status(error.getStatus()).send(error.getResponse());
      return;
    }
    console.error(error);
    void reply.status(500).send({ error: 'internal_error' });
  }
}
