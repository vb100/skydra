import { createHash, randomUUID } from 'node:crypto';
import { MAX_LOGO_BYTES, OrganizationProfileInput } from '@skydra/shared';
import type { PoolClient } from 'pg';
import { recordAudit } from '../audit/audit';
import { detectType } from '../documents/documents';
import { RuleError, translateDbError } from '../domain-errors';
import type { FileStore } from '../storage/file-store';

/** The agency's details for the case export (client answer Q43). */
export type OrganizationProfile = {
  id: string;
  name: string;
  companyCode: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  hasLogo: boolean;
  logoUpdatedAt: string | null;
};

const PROFILE = `
  SELECT id, name, company_code AS "companyCode", address, phone, email, website,
         logo_storage_key IS NOT NULL AS "hasLogo", logo_updated_at AS "logoUpdatedAt"
    FROM organizations WHERE id = app.current_organization_id()`;

export async function getProfile(client: PoolClient): Promise<OrganizationProfile> {
  const { rows } = await client.query<OrganizationProfile>(PROFILE);
  return rows[0]!;
}

/** Updates the details; the database lets only an organization administrator do it. */
export async function updateProfile(
  client: PoolClient,
  input: OrganizationProfileInput,
): Promise<OrganizationProfile> {
  const p = OrganizationProfileInput.parse(input);
  const before = await getProfile(client);
  const value = (v: string) => (v === '' ? null : v);
  try {
    await client.query(
      `UPDATE organizations
          SET name = $1, company_code = $2, address = $3, phone = $4, email = $5, website = $6
        WHERE id = app.current_organization_id()`,
      [
        p.name,
        value(p.companyCode),
        value(p.address),
        value(p.phone),
        value(p.email),
        value(p.website),
      ],
    );
  } catch (error) {
    translateDbError(error);
  }
  const after = await getProfile(client);
  await recordAudit(client, {
    action: 'organization.profile_updated',
    entityType: 'organization',
    entityId: after.id,
    before: { ...before, logoUpdatedAt: undefined },
    after: { ...after, logoUpdatedAt: undefined },
  });
  return after;
}

/**
 * A new logo: PNG or JPEG (checked from its bytes), up to 1 MB. Stored as a new object; the
 * earlier one stays in the bucket as the record of what earlier exports showed.
 */
export async function uploadLogo(
  client: PoolClient,
  store: FileStore,
  body: Buffer,
): Promise<OrganizationProfile> {
  if (body.length === 0) throw new RuleError('the file is empty');
  if (body.length > MAX_LOGO_BYTES) throw new RuleError('the logo is larger than 1 MB');
  const type = detectType(body);
  if (type !== 'image/png' && type !== 'image/jpeg')
    throw new RuleError('the logo must be a PNG or JPEG image');
  const { id } = await getProfile(client);
  const key = `${id}/organization/logo/${randomUUID()}`;
  const sha256 = createHash('sha256').update(body).digest('hex');
  try {
    await client.query(
      `UPDATE organizations SET logo_storage_key = $1, logo_content_type = $2, logo_sha256 = $3,
              logo_updated_at = now()
        WHERE id = app.current_organization_id()`,
      [key, type, sha256],
    );
  } catch (error) {
    translateDbError(error);
  }
  await store.put(key, body, type);
  await recordAudit(client, {
    action: 'organization.logo_updated',
    entityType: 'organization',
    entityId: id,
    after: { contentType: type, sizeBytes: body.length, sha256 },
  });
  return getProfile(client);
}

/** Removes the logo from the profile (the stored file is kept, like every stored file). */
export async function removeLogo(client: PoolClient): Promise<OrganizationProfile> {
  const { id } = await getProfile(client);
  try {
    await client.query(
      `UPDATE organizations SET logo_storage_key = NULL, logo_content_type = NULL,
              logo_sha256 = NULL, logo_updated_at = NULL
        WHERE id = app.current_organization_id()`,
    );
  } catch (error) {
    translateDbError(error);
  }
  await recordAudit(client, {
    action: 'organization.logo_removed',
    entityType: 'organization',
    entityId: id,
  });
  return getProfile(client);
}

/** The current logo, checked against its SHA-256; null when there is none. */
export async function readLogo(
  client: PoolClient,
  store: FileStore,
): Promise<{ body: Buffer; contentType: 'image/png' | 'image/jpeg' } | null> {
  const { rows } = await client.query<{ key: string | null; type: string; sha256: string }>(
    `SELECT logo_storage_key AS key, logo_content_type AS type, logo_sha256 AS sha256
       FROM organizations WHERE id = app.current_organization_id()`,
  );
  const logo = rows[0];
  if (!logo?.key) return null;
  const body = await store.get(logo.key);
  if (createHash('sha256').update(body).digest('hex') !== logo.sha256)
    throw new Error('the stored logo does not match its SHA-256');
  return { body, contentType: logo.type as 'image/png' | 'image/jpeg' };
}
