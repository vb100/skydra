import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AppEnv } from '@skydra/shared';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { deriveKeys, hashToken, randomToken } from '../auth/crypto';
import {
  activateAml,
  addCaseParty,
  type CaseActor,
  createCase,
  updateCase,
  updateCaseParty,
} from '../cases/cases';
import { escalate, requestApproval } from '../kyc/decisions';
import { recordInPersonVerification } from '../kyc/identity';
import { MockRegistryProvider } from '../ownership/mock-registry';
import { fetchOwnership, linkBeneficialOwners } from '../ownership/ownership';
import { assessRisk } from '../risk/risk';
import { MockScreeningProvider } from '../screening/mock-provider';
import { listScreenings, reviewMatch, runScreening } from '../screening/screening';
import { type TenantContext, withTenant } from './tenant';

/**
 * Creates a demonstration agency with three members and cases in every state the prototype can
 * show, using the same services (and therefore the same rules and audit trail) as the API. All
 * people and companies are fictional; providers are the simulated ones. Refused in prod.
 *
 * Members get one-time activation links (password and second factor are set by whoever presents
 * the demo), so no known credentials exist. Running it again for an existing demo agency only
 * issues fresh links for members who have not activated yet.
 *
 *   pnpm db:seed:demo [--name "Demo NT agentūra"]
 */

const MEMBERS = [
  {
    key: 'manager',
    email: 'vadove@demo.skydra.eu',
    fullName: 'Gintarė Vadovaitė',
    roles: ['ORG_ADMIN', 'MANAGER'],
    permissions: ['APPROVER'],
  },
  {
    key: 'broker',
    email: 'brokeris@demo.skydra.eu',
    fullName: 'Tomas Brokeraitis',
    roles: ['BROKER'],
    permissions: [],
  },
  {
    key: 'officer',
    email: 'aml@demo.skydra.eu',
    fullName: 'Aistė Atitiktytė',
    roles: ['BROKER'],
    permissions: ['AML_OFFICER'],
  },
] as const;
type MemberKey = (typeof MEMBERS)[number]['key'];

const KYC = (purpose: string, sourceOfFunds: string) => ({
  version: 1 as const,
  purpose,
  sourceOfFunds,
  actsOnOwnBehalf: true,
  pepSelfDeclared: false,
});
const DOCUMENT = { documentType: 'ID_CARD', documentCountry: 'LT' } as const;

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = AppEnv.parse(process.env.APP_ENV);
  if (env === 'prod') throw new Error('demo data is never created in prod');
  const ownerUrl = z.string().min(1).parse(process.env.MIGRATION_DATABASE_URL);
  const appUrl = z.string().min(1).parse(process.env.DATABASE_URL);
  const publicUrl = new URL(z.url().parse(process.env.PUBLIC_APP_URL)).origin;
  const keys = deriveKeys(z.string().parse(process.env.SECRET_ENCRYPTION_KEY));
  const { values } = parseArgs({ options: { name: { type: 'string' } } });
  const orgName = z
    .string()
    .trim()
    .min(1)
    .parse(values.name ?? 'Demo NT agentūra');

  const owner = new Pool({ connectionString: ownerUrl, max: 1 });
  const app = new Pool({ connectionString: appUrl, max: 3 });
  try {
    const result = await createDemoAgency(owner, app, keys, orgName);
    console.log(
      result.created
        ? `Demo agency "${orgName}" created with ${result.cases} cases.`
        : `Demo agency "${orgName}" already exists; issuing fresh activation links.`,
    );
    await printInvites(owner, result.organizationId, publicUrl);
  } finally {
    await app.end();
    await owner.end();
  }
}

/**
 * Creates the demo agency and its cases, or finds the existing one. `owner` connects as the schema
 * owner (bootstrap only), `app` as the runtime role (everything else, through the services).
 */
export async function createDemoAgency(
  owner: Pool,
  app: Pool,
  keys: ReturnType<typeof deriveKeys>,
  name: string,
): Promise<{ organizationId: string; created: boolean; cases: number }> {
  const existing = await owner.query<{ id: string }>(
    'SELECT id FROM organizations WHERE name = $1',
    [name],
  );
  if (existing.rows[0]) return { organizationId: existing.rows[0].id, created: false, cases: 0 };

  const { organizationId, members } = await bootstrap(owner, name);
  const ctx = (key: MemberKey): TenantContext => ({ organizationId, userId: members[key] });
  const cases = await seedCases(app, keys, ctx);
  // Members activate their accounts like real users would.
  await owner.query("UPDATE users SET status = 'INVITED' WHERE id = ANY($1)", [
    Object.values(members),
  ]);
  return { organizationId, created: true, cases };
}

/** Organization and members, written as the owner inside the organization's context. */
async function bootstrap(owner: Pool, name: string) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
    const organizationId = rows[0]!.id;
    await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
    await client.query(
      "INSERT INTO organizations (id, name, plan_code, country_code) VALUES ($1, $2, 'AGENCY_PRO', 'LT')",
      [organizationId, name],
    );
    const members = {} as Record<MemberKey, string>;
    for (const m of MEMBERS) {
      const { rows: user } = await client.query<{ id: string }>(
        // Fails on an e-mail already in use, e.g. by a demo agency under another name.
        `INSERT INTO users (email, full_name, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
        [m.email, m.fullName],
      );
      members[m.key] = user[0]!.id;
      await client.query(
        'INSERT INTO memberships (organization_id, user_id, roles, permissions) VALUES ($1, $2, $3, $4)',
        [organizationId, members[m.key], m.roles, m.permissions],
      );
    }
    await client.query(
      `INSERT INTO audit_events (action, entity_type, entity_id, after, metadata)
       VALUES ('organization.created', 'organization', $1, $2, '{"source": "demo-seed"}')`,
      [organizationId, JSON.stringify({ name, planCode: 'AGENCY_PRO', members: MEMBERS.length })],
    );
    await client.query('COMMIT');
    return { organizationId, members };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function printInvites(owner: Pool, organizationId: string, publicUrl: string) {
  const { rows } = await owner.query<{
    id: string;
    email: string;
    full_name: string;
    roles: string[];
    permissions: string[];
  }>(
    `SELECT u.id, u.email, u.full_name, m.roles, m.permissions
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND u.status = 'INVITED'
      ORDER BY u.email`,
    [organizationId],
  );
  if (rows.length === 0) {
    console.log('All demo members have activated their accounts; sign in at', `${publicUrl}/login`);
    return;
  }
  console.log('\nOne-time activation links (valid 72 h). Each sets a password and the 2FA app:\n');
  for (const u of rows) {
    const token = randomToken();
    await owner.query(
      `UPDATE auth_links SET revoked_at = now()
        WHERE user_id = $1 AND purpose = 'INVITE' AND used_at IS NULL AND revoked_at IS NULL`,
      [u.id],
    );
    await owner.query(
      `INSERT INTO auth_links (token_hash, user_id, organization_id, purpose, expires_at)
       VALUES ($1, $2, $3, 'INVITE', now() + interval '72 hours')`,
      [hashToken(token), u.id, organizationId],
    );
    console.log(`${u.full_name} <${u.email}> (${[...u.roles, ...u.permissions].join(', ')})`);
    console.log(`  ${publicUrl}/activate#token=${token}\n`);
  }
}

/** The demo cases, each left in the state it is meant to show. */
async function seedCases(
  app: Pool,
  keys: ReturnType<typeof deriveKeys>,
  ctx: (key: MemberKey) => TenantContext,
): Promise<number> {
  const broker = ctx('broker');
  const as = <T>(who: TenantContext, work: (c: PoolClient) => Promise<T>) =>
    withTenant(app, who, work);
  const actor = (who: TenantContext): CaseActor => ({ ...who, canAssign: false });
  const screening = new MockScreeningProvider();
  const registry = new MockRegistryProvider();

  const newCase = (input: Parameters<typeof createCase>[2], who = broker) =>
    as(who, (c) => createCase(c, actor(who), input)).then((r) => r.id);
  const person = (
    caseId: string,
    role: 'BUYER' | 'SELLER' | 'TENANT' | 'LANDLORD',
    firstName: string,
    lastName: string,
    personalCode: string,
    isOurClient: boolean,
  ) =>
    as(broker, (c) =>
      addCaseParty(c, keys, actor(broker), caseId, {
        party: {
          partyType: 'NATURAL',
          firstName,
          lastName,
          personalCode,
          birthDate: `19${personalCode.slice(1, 3)}-${personalCode.slice(3, 5)}-${personalCode.slice(5, 7)}`,
          citizenships: ['LT'],
          residenceCountry: 'LT',
        },
        role,
        isOurClient,
      }),
    ).then((r) => r.casePartyId);
  const company = (caseId: string, role: 'BUYER' | 'SELLER', name: string, code: string) =>
    as(broker, (c) =>
      addCaseParty(c, keys, actor(broker), caseId, {
        party: {
          partyType: 'LEGAL',
          companyName: name,
          companyCode: code,
          registrationCountry: 'LT',
        },
        role,
        isOurClient: true,
      }),
    ).then((r) => r.casePartyId);
  const screen = (caseId: string) => runScreening(app, broker, screening, caseId, {});
  const complete = async (
    caseId: string,
    casePartyId: string,
    document: string | null,
    kyc: ReturnType<typeof KYC>,
  ) => {
    if (document)
      await as(broker, (c) =>
        recordInPersonVerification(c, keys, caseId, {
          casePartyId,
          ...DOCUMENT,
          documentNumber: document,
        }),
      );
    await as(broker, (c) =>
      updateCaseParty(c, caseId, casePartyId, { kyc, cddStatus: 'COMPLETED' }),
    );
  };
  const assess = (caseId: string) => as(broker, (c) => assessRisk(c, caseId, {}));
  const confirmFirstMatch = async (caseId: string, justification: string) => {
    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    const match = check!.matches[0]!;
    await as(broker, (c) =>
      reviewMatch(c, caseId, match.id, { decision: 'TRUE_POSITIVE', justification }),
    );
  };

  // 1. A completed sale between two private persons: everything done, ready to export.
  {
    const id = await newCase({
      transactionType: 'SALE',
      propertyType: 'APARTMENT',
      propertyAddress: 'Žirmūnų g. 12-5, Vilnius',
      transactionValue: 168000,
      paymentMethod: 'LOAN',
    });
    const buyer = await person(id, 'BUYER', 'Jonas', 'Pirkėjas', '38503150101', true);
    const seller = await person(id, 'SELLER', 'Ona', 'Pardavėja', '47807220202', false);
    await screen(id);
    await complete(id, buyer, 'AB1000001', KYC('Gyventi', 'Būsto paskola ir santaupos'));
    await complete(id, seller, 'AB1000002', KYC('Turto pardavimas', 'Parduodamas turtas'));
    await assess(id);
    await as(broker, (c) => updateCase(c, actor(broker), id, { stage: 'OFFER_ACCEPTED' }));
    await as(broker, (c) => updateCase(c, actor(broker), id, { stage: 'CONTRACT' }));
  }

  // 2. A confirmed PEP: high risk, the approval is waiting for the manager.
  {
    const id = await newCase({
      transactionType: 'SALE',
      propertyType: 'HOUSE',
      propertyAddress: 'Pušyno g. 3, Trakai',
      transactionValue: 420000,
      paymentMethod: 'BANK_TRANSFER',
    });
    const buyer = await person(id, 'BUYER', 'Petras', 'Politikas', '36602100303', true);
    await screen(id);
    await confirmFirstMatch(id, 'Sutampa vardas, gimimo data ir pareigos Seime');
    await complete(id, buyer, 'AB1000003', KYC('Antrasis būstas', 'Darbo užmokestis ir indėliai'));
    await assess(id);
    await as(broker, (c) =>
      requestApproval(c, id, {
        reason: 'Klientas – PEP. Lėšų kilmė pagrįsta banko išrašais už 3 metus.',
      }),
    );
  }

  // 3. A potential adverse-media match waiting for the broker's review.
  {
    const id = await newCase({
      transactionType: 'SALE',
      propertyType: 'APARTMENT',
      propertyAddress: 'Savanorių pr. 45-12, Kaunas',
      transactionValue: 98000,
      paymentMethod: 'BANK_TRANSFER',
    });
    await person(id, 'BUYER', 'Rasa', 'Skandalė', '48901010404', true);
    await screen(id);
  }

  // 4. A letting below the EUR 10 000 threshold: AML procedures do not apply.
  {
    const id = await newCase({
      transactionType: 'RENT',
      propertyType: 'APARTMENT',
      propertyAddress: 'Vytauto g. 8-3, Klaipėda',
      monthlyRent: 850,
      paymentMethod: 'BANK_TRANSFER',
    });
    await person(id, 'TENANT', 'Lukas', 'Nuomininkas', '39504040505', true);
    await person(id, 'LANDLORD', 'Eglė', 'Nuomotoja', '47006060606', false);
  }

  // 5. A letting below the threshold where the broker applied AML anyway.
  {
    const id = await newCase({
      transactionType: 'RENT',
      propertyType: 'OFFICE',
      propertyAddress: 'Konstitucijos pr. 21, Vilnius',
      monthlyRent: 6500,
      paymentMethod: 'MIXED',
    });
    await person(id, 'TENANT', 'Mantas', 'Verslininkas', '38207070707', true);
    await as(broker, (c) =>
      activateAml(c, id, { reason: 'Dalis nuomos mokama grynaisiais per trečiąjį asmenį' }),
    );
  }

  // 6. A company buyer whose JANGIS declaration misses an owner: the discrepancy is open.
  {
    const id = await newCase({
      transactionType: 'SALE',
      propertyType: 'WAREHOUSE',
      propertyAddress: 'Pramonės g. 15, Klaipėda',
      transactionValue: 1250000,
      paymentMethod: 'BANK_TRANSFER',
    });
    const buyer = await company(id, 'BUYER', 'UAB „Neatitikimas“', '300000003');
    const { snapshotId } = await fetchOwnership(app, broker, keys, registry, id, buyer);
    await as(broker, (c) => linkBeneficialOwners(c, keys, broker.organizationId, id, snapshotId));
    await screen(id);
  }

  // 7. A company buyer owned through a holding: completed with medium risk.
  {
    const id = await newCase({
      transactionType: 'SALE',
      propertyType: 'OFFICE',
      propertyAddress: 'Laisvės al. 60, Kaunas',
      transactionValue: 640000,
      paymentMethod: 'BANK_TRANSFER',
    });
    const buyer = await company(id, 'BUYER', 'UAB „Grandinė“', '300000002');
    const seller = await person(id, 'SELLER', 'Vytautas', 'Savininkas', '36001010808', false);
    const { snapshotId } = await fetchOwnership(app, broker, keys, registry, id, buyer);
    await as(broker, (c) => linkBeneficialOwners(c, keys, broker.organizationId, id, snapshotId));
    await screen(id);
    await complete(id, buyer, null, KYC('Biuro patalpos veiklai', 'Įmonės apyvartinės lėšos'));
    await complete(id, seller, 'AB1000008', KYC('Turto pardavimas', 'Parduodamas turtas'));
    await assess(id);
  }

  // 8. Cash payment and a suspicion: escalated to the AML officer, case blocked.
  {
    const id = await newCase({
      transactionType: 'SALE',
      propertyType: 'LAND',
      propertyAddress: 'Sklypas Nr. 41, Neringa',
      transactionValue: 210000,
      paymentMethod: 'CASH',
    });
    await person(id, 'BUYER', 'Darius', 'Grynasis', '37509090909', true);
    await screen(id);
    await as(broker, (c) =>
      escalate(c, id, {
        reason: 'Klientas nori atsiskaityti grynaisiais ir negali paaiškinti lėšų kilmės.',
      }),
    );
  }

  // 9. A confirmed sanctions match: the transaction must not proceed.
  {
    const id = await newCase({
      transactionType: 'SALE',
      propertyType: 'HOUSE',
      propertyAddress: 'Kopų g. 2, Palanga',
      transactionValue: 530000,
      paymentMethod: 'BANK_TRANSFER',
    });
    await person(id, 'BUYER', 'Ivanas', 'Sankcijonis', '37112121010', true);
    await screen(id);
    await confirmFirstMatch(id, 'Sutampa vardas, gimimo data ir pilietybė su ES sąrašu');
  }
  return 9;
}

if (require.main === module)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
