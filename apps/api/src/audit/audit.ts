import type { PoolClient } from 'pg';

export type AuditEvent = {
  /** Dotted, lower-case verb phrase, e.g. `case.created`, `screening.match_reviewed`. */
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  /** Request details such as IP, session or request id. */
  metadata?: Record<string, unknown>;
};

export type RecordedAudit = { id: string; seq: string; hash: string };

const REDACTED = '[REDACTED]';
const SECRET_KEY = /pass(word)?|secret|token|totp|otp|recovery|api[_-]?key|authorization|cookie/i;

/** Removes secrets from values before they become part of the permanent record. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, SECRET_KEY.test(key) ? REDACTED : redact(v)]),
    );
  }
  return value;
}

/**
 * Appends an audit event in the caller's transaction (a client from `withTenant`), so the event
 * exists if and only if the change it describes is committed. Organization, actor, time,
 * sequence number and hash are assigned by the database.
 */
export async function recordAudit(client: PoolClient, event: AuditEvent): Promise<RecordedAudit> {
  const { rows } = await client.query<RecordedAudit>(
    `INSERT INTO audit_events (action, entity_type, entity_id, before, after, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::text, seq::text, encode(hash, 'hex') AS hash`,
    [
      event.action,
      event.entityType,
      event.entityId ?? null,
      event.before === undefined ? null : JSON.stringify(redact(event.before)),
      event.after === undefined ? null : JSON.stringify(redact(event.after)),
      JSON.stringify(redact(event.metadata ?? {})),
    ],
  );
  const recorded = rows[0];
  if (!recorded) throw new Error('audit event was not recorded');
  return recorded;
}

export type ChainVerification = {
  valid: boolean;
  checked: number;
  firstInvalidSeq: number | null;
  reason: string | null;
};

/** Recomputes the current organization's hash chain from the first event to the stored head. */
export async function verifyAuditChain(client: PoolClient): Promise<ChainVerification> {
  const { rows } = await client.query<{
    valid: boolean;
    checked: string;
    first_invalid_seq: string | null;
    reason: string | null;
  }>('SELECT * FROM app.verify_audit_chain()');
  const r = rows[0];
  if (!r) throw new Error('chain verification returned no result');
  return {
    valid: r.valid,
    checked: Number(r.checked),
    firstInvalidSeq: r.first_invalid_seq === null ? null : Number(r.first_invalid_seq),
    reason: r.reason,
  };
}
