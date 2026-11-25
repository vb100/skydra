import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  format as f,
  type Locale,
  MESSAGES,
  type PartyRole,
  REGISTRY_ROLES,
  screeningStatus,
} from '@skydra/shared';
import PDFDocument from 'pdfkit';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import type { SecretKeys } from '../auth/crypto';
import { type CaseDetail, getCase } from '../cases/cases';
import { NotFoundError, RuleError, translateDbError } from '../domain-errors';
import { type ChecklistEntry, getChecklist, listDecisions } from '../kyc/decisions';
import { type IdentityVerification, listIdentityVerifications } from '../kyc/identity';
import type { OwnershipNode } from '../ownership/analysis';
import { listOwnership, type OwnershipView } from '../ownership/ownership';
import { type RiskOverview, riskOverview } from '../risk/risk';
import { listScreenings, type ScreeningCheck } from '../screening/screening';
import { type CaseDocument, listDocuments, readDocument } from '../documents/documents';
import type { FileStore } from '../storage/file-store';
import { getProfile, type OrganizationProfile, readLogo } from '../organization/profile';
import { zip } from './zip';

const req = createRequire(__filename);
// DejaVu covers Lithuanian letters (ą č ę ė į š ų ū ž), which the PDF standard fonts do not.
const FONT = req.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = req.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

type AuditRow = { seq: string; occurred_at: Date; action: string; actor: string | null };

export type CaseReportData = {
  organizationName: string;
  /** The agency's details and logo from its profile (client answer Q43). */
  organization: OrganizationProfile;
  logo: Buffer | null;
  exportedByName: string;
  exportedAt: Date;
  caseFile: CaseDetail;
  checklist: ChecklistEntry[];
  screenings: ScreeningCheck[];
  identity: IdentityVerification[];
  ownership: OwnershipView[];
  risk: RiskOverview;
  decisions: Awaited<ReturnType<typeof listDecisions>>;
  documents: CaseDocument[];
  audit: AuditRow[];
};

export async function collectReport(
  client: PoolClient,
  keys: SecretKeys,
  caseId: string,
  store?: FileStore,
): Promise<CaseReportData> {
  const id = z.uuid().parse(caseId);
  const caseFile = await getCase(client, keys, id);
  const { rows: who } = await client.query<{ id: string; organization: string; user: string }>(
    `SELECT o.id, o.name AS organization, u.full_name AS user
       FROM organizations o, users u
      WHERE o.id = app.current_organization_id() AND u.id = app.current_user_id()`,
  );
  const { rows: audit } = await client.query<AuditRow>(
    `SELECT e.seq::text, e.occurred_at, e.action, u.full_name AS actor
       FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.entity_type = 'case' AND e.entity_id = $1
      ORDER BY e.seq`,
    [id],
  );
  const organization = await getProfile(client);
  let logo: Buffer | null = null;
  if (organization.hasLogo && store)
    try {
      logo = (await readLogo(client, store))?.body ?? null;
    } catch (error) {
      // The report stands without the logo; the reason is logged, not hidden.
      console.error(
        'case report: logo unavailable',
        error instanceof Error ? error.message : error,
      );
    }
  return {
    organizationName: who[0]?.organization ?? '',
    organization,
    logo,
    exportedByName: who[0]?.user ?? '',
    exportedAt: new Date(),
    caseFile,
    checklist: await getChecklist(client, id),
    screenings: await listScreenings(client, id),
    identity: await listIdentityVerifications(client, keys, id),
    ownership: await listOwnership(client, keys, who[0]?.id ?? '', id),
    risk: await riskOverview(client, id),
    decisions: await listDecisions(client, id),
    documents: await listDocuments(client, id),
    audit,
  };
}

const label = (group: Record<string, unknown>, key: string | null | undefined) => {
  const text = key ? group[key] : undefined;
  return typeof text === 'string' ? text : (key ?? '–');
};
const date = (v: Date | string | null | undefined) =>
  v ? new Date(v).toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius' }) : '–';
const day = (v: Date | string | null | undefined) =>
  v ? new Date(v).toLocaleDateString('lt-LT', { timeZone: 'Europe/Vilnius' }) : '–';
const NUMBER_LOCALE: Record<Locale, string> = { lt: 'lt-LT', en: 'en-GB' };
const money = (v: string | null, locale: Locale) =>
  v === null
    ? '–'
    : `${Number(v).toLocaleString(NUMBER_LOCALE[locale], { minimumFractionDigits: 2 })} EUR`;

/**
 * Renders the AML case file in Lithuanian or English (client answer Q10). Personal and document
 * numbers appear only masked; what people entered (reasons, notes) stays as they wrote it.
 */
export function renderReport(
  d: CaseReportData,
  exportId: string,
  locale: Locale = 'lt',
): Promise<Buffer> {
  const c = d.caseFile;
  const lt = MESSAGES[locale];
  const r = lt.report;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 56, bottom: 64, left: 56, right: 56 },
    bufferPages: true,
    info: { Title: f(r.title, { reference: c.reference }), Author: 'SkyDra', Creator: 'SkyDra' },
  });
  doc.registerFont('Sans', FONT);
  doc.registerFont('Sans-Bold', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const h1 = (text: string) => doc.font('Sans-Bold').fontSize(18).text(text).moveDown(0.3);
  const h2 = (text: string) => {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.moveDown(0.8).font('Sans-Bold').fontSize(12).fillColor('#1f5f8b').text(text);
    doc.fillColor('#000000').moveDown(0.2);
  };
  const p = (text: string, opts: { muted?: boolean; indent?: number } = {}) =>
    doc
      .font('Sans')
      .fontSize(9.5)
      .fillColor(opts.muted ? '#5b6673' : '#000000')
      .text(text, { indent: opts.indent ?? 0 })
      .fillColor('#000000');
  const row = (name: string, value: string) =>
    doc
      .font('Sans-Bold')
      .fontSize(9.5)
      .text(`${name}: `, { continued: true })
      .font('Sans')
      .text(value);

  const simulated =
    d.screenings.some((s) => s.provider === 'MOCK') ||
    d.ownership.some((o) => o.provider === 'MOCK') ||
    d.identity.some((v) => v.provider === 'MOCK');

  // The agency (Q43): logo and details from its profile.
  const o = d.organization;
  const top = doc.y;
  let textX = doc.page.margins.left;
  if (d.logo) {
    try {
      doc.image(d.logo, doc.page.margins.left, top, { fit: [120, 44] });
      textX += 132;
    } catch (error) {
      console.error(
        'case report: logo not embeddable',
        error instanceof Error ? error.message : error,
      );
    }
  }
  doc.font('Sans-Bold').fontSize(11).text(o.name, textX, top);
  doc
    .font('Sans')
    .fontSize(8.5)
    .fillColor('#5b6673')
    .text(
      [
        o.companyCode && f(r.companyCode, { code: o.companyCode }),
        o.address,
        [o.phone, o.email, o.website].filter(Boolean).join(' · '),
      ]
        .filter(Boolean)
        .join('\n'),
      textX,
    )
    .fillColor('#000000');
  doc.x = doc.page.margins.left;
  doc.y = Math.max(doc.y, top + 48);
  doc.moveDown(0.6);

  // Title
  h1(f(r.title, { reference: c.reference }));
  p(
    f(r.exported, {
      organization: d.organizationName,
      by: d.exportedByName,
      date: date(d.exportedAt),
    }),
    { muted: true },
  );
  p(f(r.exportId, { id: exportId }), { muted: true });
  // Who decided and when, and on which methodology (Q43), before the details.
  const decided = d.decisions.final[0];
  if (decided)
    p(
      f(r.finalDecision, {
        decision: label(lt.finalDecision.decisions, decided.decision),
        by: decided.decidedByName,
        date: date(decided.decidedAt),
      }),
    );
  if (d.risk.current)
    p(
      f(r.methodology, {
        code: d.risk.current.ruleSetCode,
        version: d.risk.current.ruleSetVersion,
      }),
      { muted: true },
    );
  if (simulated || d.risk.ruleSet.isDemo) {
    doc.moveDown(0.4);
    doc.font('Sans-Bold').fontSize(9.5).fillColor('#b42318').text(r.demo).fillColor('#000000');
  }

  const F = r.fields;
  h2(`1. ${r.sections.transaction}`);
  row(F.transactionType, label(lt.transactionTypes, c.transactionType));
  row(F.property, `${label(lt.propertyTypes, c.propertyType)}, ${c.propertyAddress}`);
  row(
    c.transactionType === 'SALE' ? F.value : F.rent,
    money(c.transactionType === 'SALE' ? c.transactionValue : c.monthlyRent, locale),
  );
  row(
    F.payment,
    c.paymentMethod
      ? `${label(lt.paymentMethods, c.paymentMethod)}${c.paymentMethodOther ? ` (${c.paymentMethodOther})` : ''}`
      : F.notStated,
  );
  row(F.stage, label(lt.stages, c.stage));
  if (c.offerAcceptedAt) row(F.offerAccepted, date(c.offerAcceptedAt));
  row(F.aml, label(lt.amlApplicability, c.amlApplicability));
  if (c.amlActivationReason) row(F.activationReason, c.amlActivationReason);
  row(F.compliance, label(lt.complianceStatuses, c.complianceStatus));
  row(F.regime, label(lt.legalRegimes, c.legalRegime));
  row(F.responsible, c.responsibleName);
  row(F.created, date(c.createdAt));

  const P = r.party;
  h2(`2. ${r.sections.parties}`);
  for (const cp of c.parties) {
    const owner = cp.beneficialOwnerOf
      ? c.parties.find((x) => x.id === cp.beneficialOwnerOf)?.party.displayName
      : null;
    doc
      .font('Sans-Bold')
      .fontSize(10)
      .text(`${label(lt.partyRoles, cp.role)}: ${cp.party.displayName}`);
    p(
      [
        label(lt.parties, cp.party.partyType),
        cp.party.personalCodeMasked && f(P.personalCode, { code: cp.party.personalCodeMasked }),
        cp.party.companyCode && f(P.companyCode, { code: cp.party.companyCode }),
        cp.party.birthDate && f(P.born, { date: cp.party.birthDate }),
        cp.party.citizenships.length > 0 &&
          f(P.citizenship, { list: cp.party.citizenships.join(', ') }),
        owner && f(P.uboOf, { name: owner }),
      ]
        .filter(Boolean)
        .join(' · '),
      { indent: 10 },
    );
    if (!REGISTRY_ROLES.includes(cp.role as PartyRole)) {
      const kyc = cp.kyc as Record<string, unknown>;
      p(
        `CDD: ${label(lt.parties.cddScopes, cp.cddScope)} · ${label(lt.parties.cddStatuses, cp.cddStatus)}` +
          (cp.isOurClient ? ` · ${P.ourClient}` : '') +
          (cp.representedByOtherBroker ? ` · ${P.otherBroker}` : ''),
        { indent: 10 },
      );
      const answers = [
        kyc.purpose && f(P.purpose, { value: String(kyc.purpose) }),
        kyc.sourceOfFunds && f(P.funds, { value: String(kyc.sourceOfFunds) }),
        typeof kyc.actsOnOwnBehalf === 'boolean' &&
          (kyc.actsOnOwnBehalf ? P.ownBehalf : P.notOwnBehalf),
        typeof kyc.pepSelfDeclared === 'boolean' &&
          (kyc.pepSelfDeclared ? P.pepDeclared : P.pepNotDeclared),
      ].filter(Boolean);
      if (answers.length) p(`KYC: ${answers.join(' · ')}`, { indent: 10 });
    }
  }

  h2(`3. ${r.sections.identity}`);
  if (d.identity.length === 0) p(r.none, { muted: true });
  for (const v of d.identity) {
    const who = c.parties.find((x) => x.id === v.casePartyId)?.party.displayName ?? '';
    p(
      `${who}: ${label(lt.identity.statuses, v.status)} (${label(lt.identity.methods, v.method)}, ${v.provider}) · ` +
        `${label(lt.identity.documentTypes, v.documentType)} ${v.documentNumberMasked ?? ''}` +
        `${v.documentCountry ? `, ${v.documentCountry}` : ''} · ${date(v.completedAt ?? v.requestedAt)}`,
    );
  }

  if (d.ownership.length > 0) {
    const O = r.ownership;
    h2(`4. ${r.sections.ownership}`);
    for (const o of d.ownership) {
      doc.font('Sans-Bold').fontSize(10).text(`${o.company.name} (${o.company.code})`);
      p(
        f(O.source, {
          provider: o.provider,
          date: date(o.fetchedAt),
          references: Object.entries(o.company.references)
            .map(([k, v]) => `${k} ${v}`)
            .join(', '),
        }),
        { muted: true, indent: 10 },
      );
      const tree = (nodes: OwnershipNode[], level: number) => {
        for (const n of nodes) {
          p(
            `${n.name}${n.code ? ` (${n.code}, ${n.country ?? ''})` : ''} – ${n.sharePercent} %` +
              (n.effectivePercent !== n.sharePercent
                ? ` ${f(O.indirect, { percent: n.effectivePercent })}`
                : '') +
              (n.unresolved ? ` – ${O.unresolved}` : ''),
            { indent: 10 + level * 14 },
          );
          tree(n.children, level + 1);
        }
      };
      tree(o.analysis.tree, 0);
      p(f(O.ubos, { percent: o.analysis.thresholdPercent }), { indent: 10 });
      for (const u of o.ubos)
        p(
          `${u.person.firstName} ${u.person.lastName} ${u.person.personalCodeMasked ?? ''} · ` +
            `${label(lt.ownership.bases, u.basis)}${u.effectivePercent !== null ? ` ${u.effectivePercent} %` : ''} · ` +
            `${u.computed ? O.byShares : O.notShareholder}, ${u.declared ? O.declared : O.notDeclared}`,
          { indent: 24 },
        );
      if (o.discrepancy) p(O.discrepancy, { indent: 10 });
      if (o.incomplete) p(O.incomplete, { indent: 10 });
      if (o.resolution)
        p(
          f(O.resolution, {
            resolution: label(lt.ownership.resolutions, o.resolution.resolution),
            notes: o.resolution.notes,
            evidence: o.resolution.evidence,
            by: o.resolution.resolvedByName,
            date: date(o.resolution.resolvedAt),
          }),
          { indent: 10 },
        );
    }
  }

  const S = r.screening;
  h2(`${d.ownership.length > 0 ? 5 : 4}. ${r.sections.screening}`);
  if (d.screenings.length === 0) p(S.none, { muted: true });
  for (const cp of c.parties) {
    const own = d.screenings.filter((s) => s.casePartyId === cp.id);
    if (own.length === 0) continue;
    p(
      `${cp.party.displayName} (${label(lt.partyRoles, cp.role)}): ` +
        label(lt.screening.statuses, screeningStatus(own).status),
    );
  }
  for (const s of d.screenings) {
    const who = c.parties.find((x) => x.id === s.casePartyId)?.party.displayName ?? '';
    const sources = (s.sources.length ? s.sources : [s.provider])
      .map((x) => label(lt.screening.providers, x))
      .join(', ');
    const origin = s.origin ? ` · ${label(lt.screening.origins, s.origin)}` : '';
    p(
      `${who}: ${sources} · ${date(s.completedAt ?? s.requestedAt)}${origin} · ` +
        (s.status === 'COMPLETED' ? f(S.matches, { count: s.matchCount ?? 0 }) : S.failed),
      { indent: 10 },
    );
    if (s.manual) {
      // A check made by hand: what was searched where, when, and why the result holds.
      const evidence = d.documents.find((x) => x.id === s.evidenceDocumentId);
      p(
        f(S.manual, {
          source: s.manual.source,
          date: s.manual.searchedOn,
          result: label(lt.screening.manualResults, s.manual.result),
          justification: s.manual.justification,
        }) +
          (s.manual.sourceUrl ? ` · ${s.manual.sourceUrl}` : '') +
          (evidence ? ` · ${f(S.evidence, { name: evidence.fileName })}` : ''),
        { indent: 18 },
      );
    }
    for (const m of s.matches) {
      if (m.details.kind === 'article') {
        // The article itself is the evidence: its address and date, as the broker reviewed it.
        const published = typeof m.details.publishedAt === 'string' ? m.details.publishedAt : null;
        p(
          `${label(lt.matchCategories, 'ADVERSE_MEDIA')} · ${m.name}` +
            `${published ? ` · ${day(published)}` : ''}` +
            ` · ${label(lt.screening.articleStatuses, m.reviewStatus)}` +
            `${m.reviewJustification ? ` – ${m.reviewJustification}` : ''}` +
            `${m.carriedFrom ? S.carried : ''}`,
          { indent: 18 },
        );
        if (typeof m.details.sourceUrl === 'string')
          p(m.details.sourceUrl, { indent: 26, muted: true });
        continue;
      }
      p(
        `${m.categories.map((x) => label(lt.matchCategories, x)).join(', ')} · ${m.name}` +
          `${m.score ? ` · ${Number(m.score)} %` : ''}` +
          `${m.strength === 'WEAK' ? ` · ${S.weak}` : ''}` +
          ` · ${label(lt.screening.reviewStatuses, m.reviewStatus)}` +
          `${m.reviewJustification ? ` – ${m.reviewJustification}` : ''}` +
          `${m.carriedFrom ? S.carried : ''}`,
        { indent: 18 },
      );
    }
  }

  const n = (k: number) => (d.ownership.length > 0 ? k + 1 : k);
  const K = r.risk;
  h2(`${n(5)}. ${r.sections.risk}`);
  const current = d.risk.current;
  if (!current) p(K.none, { muted: true });
  else {
    row(K.final, label(lt.riskLevels, current.finalLevel));
    row(K.calculated, label(lt.riskLevels, current.calculatedLevel));
    if (current.mandatoryLevel) row(K.mandatory, label(lt.riskLevels, current.mandatoryLevel));
    row(
      K.methodology,
      `${current.ruleSetCode} / ${current.ruleSetVersion}${current.isDemo ? K.demo : ''}`,
    );
    row(K.assessedBy, `${current.assessedByName}, ${date(current.assessedAt)}`);
    row(K.nextReview, day(current.nextReviewOn));
    if (current.justification) row(K.justification, current.justification);
    const matched = current.factors.filter((x) => x.matched);
    p(
      matched.length
        ? f(K.factors, {
            list: matched
              .map((x) => `${label(lt.riskFactors, x.code)} (${label(lt.riskLevels, x.level)})`)
              .join('; '),
          })
        : K.noFactors,
    );
  }

  const D = r.decisions;
  h2(`${n(6)}. ${r.sections.decisions}`);
  const { approvals, escalations } = d.decisions;
  if (approvals.length + escalations.length === 0) p(D.none, { muted: true });
  for (const a of approvals)
    p(
      f(D.approval, {
        status: label(lt.approvals.statuses, a.status),
        by: a.requestedByName,
        date: date(a.requestedAt),
        reason: a.reason,
      }) +
        (a.decidedByName
          ? f(D.decided, {
              by: a.decidedByName,
              date: date(a.decidedAt),
              text: a.decisionJustification ?? '',
            })
          : ''),
    );
  for (const e of escalations)
    p(
      f(D.escalation, {
        status: label(lt.escalations.statuses, e.status),
        by: e.requestedByName,
        date: date(e.requestedAt),
        reason: e.reason,
      }) +
        (e.resolvedByName
          ? f(D.decided, {
              by: e.resolvedByName,
              date: date(e.resolvedAt),
              text: e.resolutionNotes ?? '',
            })
          : ''),
    );

  // The final decision (Q25) with the separate assessment of suspicious indicators; earlier
  // decisions follow, newest first.
  const Z = r.final;
  h2(`${n(7)}. ${r.sections.finalDecision}`);
  const [final, ...earlier] = d.decisions.final;
  if (!final) p(Z.none, { muted: true });
  else {
    row(Z.decision, label(lt.finalDecision.decisions, final.decision));
    row(Z.decidedBy, `${final.decidedByName}, ${date(final.decidedAt)}`);
    row(Z.justification, final.justification);
    row(
      Z.suspicion,
      final.suspiciousIndicators
        ? f(Z.suspicionFound, { notes: final.suspicionNotes ?? '' })
        : Z.suspicionNone,
    );
    if (final.riskLevel) row(Z.risk, label(lt.riskLevels, final.riskLevel));
    if (final.nextReviewOn) row(Z.nextReview, day(final.nextReviewOn));
    for (const e of earlier)
      p(
        f(Z.earlier, {
          decision: label(lt.finalDecision.decisions, e.decision),
          by: e.decidedByName,
          date: date(e.decidedAt),
          justification: e.justification,
        }),
        { muted: true },
      );
  }

  // The documents are the annex of the report (Q44); the ZIP export carries the files.
  h2(`${n(8)}. ${r.sections.annex}`);
  if (d.documents.length === 0) p(r.annex.none, { muted: true });
  for (const doc of d.documents) {
    const who = c.parties.find((x) => x.id === doc.casePartyId)?.party.displayName;
    p(
      `${label(lt.documents.categories, doc.category)} · ${doc.fileName}${who ? ` · ${who}` : ''} · ` +
        `${Math.max(1, Math.round(doc.sizeBytes / 1024))} KB · ${doc.uploadedByName}, ${date(doc.uploadedAt)}`,
    );
    p(`SHA-256: ${doc.sha256}`, { indent: 10, muted: true });
  }

  h2(`${n(9)}. ${r.sections.checklist}`);
  for (const e of d.checklist) {
    const who = e.casePartyId
      ? `${c.parties.find((x) => x.id === e.casePartyId)?.party.displayName ?? ''}: `
      : '';
    p(`${e.ok ? '✓' : '✗'} ${who}${label(lt.checklist.items, e.item)}`);
  }

  h2(`${n(10)}. ${r.sections.history}`);
  for (const a of d.audit)
    p(
      `#${a.seq} · ${date(a.occurred_at)} · ${a.actor ?? r.system} · ${label(lt.auditActions, a.action)}`,
      {
        muted: true,
      },
    );

  // Footer on every page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Sans')
      .fontSize(8)
      .fillColor('#5b6673')
      .text(
        f(r.footer, { reference: c.reference, id: exportId, page: i + 1, pages: range.count }),
        doc.page.margins.left,
        doc.page.height - 40,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center' },
      );
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

export type CaseExport = {
  id: string;
  format: 'PDF' | 'ZIP';
  sha256: string;
  sizeBytes: number;
  exportedByName: string;
  exportedAt: string;
};

/**
 * Produces the PDF of a completed case, registers its SHA-256 and records the export in the audit
 * trail, all in the caller's transaction: the file is handed out only if it is on record.
 */
export async function exportCase(
  client: PoolClient,
  keys: SecretKeys,
  caseId: string,
  store?: FileStore,
  locale: Locale = 'lt',
): Promise<{ pdf: Buffer; sha256: string; exportId: string; reference: string }> {
  const data = await collectReport(client, keys, caseId, store);
  // A completed case, or one closed by a decline or termination (its file is kept too).
  if (!['COMPLETED', 'CLOSED'].includes(data.caseFile.complianceStatus))
    throw new RuleError('complete the AML checks before exporting the case');

  const { rows: ids } = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
  const exportId = ids[0]!.id;
  const pdf = await renderReport(data, exportId, locale);
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  try {
    await client.query(
      `INSERT INTO case_exports (id, case_id, format, sha256, size_bytes, compliance_status)
       VALUES ($1, $2, 'PDF', $3, $4, 'COMPLETED')`,
      [exportId, data.caseFile.id, sha256, pdf.length],
    );
  } catch (error) {
    translateDbError(error);
  }
  await recordAudit(client, {
    action: 'case.exported',
    entityType: 'case',
    entityId: data.caseFile.id,
    after: { exportId, format: 'PDF', language: locale, sha256, sizeBytes: pdf.length },
  });
  return { pdf, sha256, exportId, reference: data.caseFile.reference };
}

/** ZIP folders of the client's export structure (answer to Q44). */
const FOLDERS: Record<CaseDocument['category'], string> = {
  IDENTITY: 'Identity',
  UBO: 'UBO',
  CLIENT: 'Client_Documents',
  SCREENING: 'Other',
  OTHER: 'Other',
};

/** Everything a ZIP may hold at once (the files are read into memory). */
const MAX_ZIP_BYTES = 300 * 1024 * 1024;

/**
 * The complete case as a ZIP (client answer Q44): the report as Case_Report.pdf and every
 * document under Attachments/<folder>/, each file checked against its SHA-256. A snapshot of the
 * moment: registered with the archive's own SHA-256 and recorded in the audit trail with the
 * documents it contains.
 */
export async function exportCaseZip(
  client: PoolClient,
  keys: SecretKeys,
  store: FileStore,
  caseId: string,
  locale: Locale = 'lt',
): Promise<{ zip: Buffer; sha256: string; exportId: string; reference: string }> {
  const data = await collectReport(client, keys, caseId, store);
  // A completed case, or one closed by a decline or termination (its file is kept too).
  if (!['COMPLETED', 'CLOSED'].includes(data.caseFile.complianceStatus))
    throw new RuleError('complete the AML checks before exporting the case');
  const total = data.documents.reduce((n, doc) => n + doc.sizeBytes, 0);
  if (total > MAX_ZIP_BYTES) throw new RuleError('the documents are too large for one archive');

  const { rows: ids } = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
  const exportId = ids[0]!.id;
  const pdf = await renderReport(data, exportId, locale);
  const used = new Set<string>();
  const entries = [{ name: 'Case_Report.pdf', data: pdf, modified: data.exportedAt }];
  for (const doc of data.documents) {
    const { body } = await readDocument(client, store, data.caseFile.id, doc.id, { audit: false });
    // Two files of the same name in a folder: the later one gets a number.
    const folder = `Attachments/${FOLDERS[doc.category]}/`;
    const dot = doc.fileName.lastIndexOf('.');
    const [stem, ext] =
      dot > 0 ? [doc.fileName.slice(0, dot), doc.fileName.slice(dot)] : [doc.fileName, ''];
    let name = `${folder}${doc.fileName}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${folder}${stem} (${i})${ext}`;
    used.add(name.toLowerCase());
    entries.push({ name, data: body, modified: new Date(doc.uploadedAt) });
  }
  const archive = zip(entries);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  try {
    await client.query(
      `INSERT INTO case_exports (id, case_id, format, sha256, size_bytes, compliance_status)
       VALUES ($1, $2, 'ZIP', $3, $4, 'COMPLETED')`,
      [exportId, data.caseFile.id, sha256, archive.length],
    );
  } catch (error) {
    translateDbError(error);
  }
  await recordAudit(client, {
    action: 'case.exported',
    entityType: 'case',
    entityId: data.caseFile.id,
    after: {
      exportId,
      format: 'ZIP',
      language: locale,
      sha256,
      sizeBytes: archive.length,
      documents: data.documents.map((doc) => ({ id: doc.id, sha256: doc.sha256 })),
    },
  });
  return { zip: archive, sha256, exportId, reference: data.caseFile.reference };
}

export async function listExports(client: PoolClient, caseId: string): Promise<CaseExport[]> {
  const id = z.uuid().parse(caseId);
  const { rowCount } = await client.query('SELECT 1 FROM cases WHERE id = $1', [id]);
  if (!rowCount) throw new NotFoundError('case not found');
  const { rows } = await client.query<CaseExport>(
    `SELECT x.id, x.format, x.sha256, x.size_bytes AS "sizeBytes", u.full_name AS "exportedByName",
            x.exported_at AS "exportedAt"
       FROM case_exports x JOIN users u ON u.id = x.exported_by
      WHERE x.case_id = $1 ORDER BY x.exported_at DESC`,
    [id],
  );
  return rows;
}
