/** A business rule refused the action; the message is written for the user and safe to show. */
export class RuleError extends Error {
  override name = 'RuleError';
}

/** The record does not exist or is not visible to the caller (the two are not distinguished). */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/**
 * Turns refusals raised by database rules into domain errors: 42501 is used by our triggers and
 * functions for business rules, 23505 is a unique constraint. Anything else is unexpected.
 */
export function translateDbError(
  error: unknown,
  duplicateMessage = 'this record already exists',
): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new RuleError((error as Error).message);
  if (code === '23505') throw new RuleError(duplicateMessage);
  throw error;
}
