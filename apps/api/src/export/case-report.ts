import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lt } from '@skydra/shared';
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

const req = createRequire(__filename);
// DejaVu covers Lithuanian letters (ą č ę ė į š ų ū ž), which the PDF standard fonts do not.
const FONT = req.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = req.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

type AuditRow = { seq: string; occurred_at: Date; action: string; actor: string | null };

export type CaseReportData = {
  organizationName: string;
  exportedByName: string;
  exportedAt: Date;
  caseFile: CaseDetail;
  checklist: ChecklistEntry[];
  screenings: ScreeningCheck[];
  identity: IdentityVerification[];
  ownership: OwnershipView[];
  risk: RiskOverview;
  decisions: Awaited<ReturnType<typeof listDecisions>>;
  audit: AuditRow[];
};

export async function collectReport(
  client: PoolClient,
  keys: SecretKeys,
  caseId: string,
): Promise<CaseReportData> {
  const id = z.uuid().parse(caseId);
  const caseFile = await getCase(client, keys, id);
  const { rows: who } = await client.query<{ organization: string; user: string }>(
    `SELECT o.name AS organization, u.full_name AS user
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
  return {
    organizationName: who[0]?.organization ?? '',
    exportedByName: who[0]?.user ?? '',
    exportedAt: new Date(),
    caseFile,
    checklist: await getChecklist(client, id),
    screenings: await listScreenings(client, id),
    identity: await listIdentityVerifications(client, keys, id),
    ownership: await listOwnership(client, id),
    risk: await riskOverview(client, id),
    decisions: await listDecisions(client, id),
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
const money = (v: string | null) =>
  v === null ? '–' : `${Number(v).toLocaleString('lt-LT', { minimumFractionDigits: 2 })} EUR`;

/** Renders the AML case file. Personal and document numbers appear only masked. */
export function renderReport(d: CaseReportData, exportId: string): Promise<Buffer> {
  const c = d.caseFile;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 56, bottom: 64, left: 56, right: 56 },
    bufferPages: true,
    info: { Title: `AML byla ${c.reference}`, Author: 'SkyDra', Creator: 'SkyDra' },
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

  // Title
  h1(`AML byla ${c.reference}`);
  p(`${d.organizationName} · eksportavo ${d.exportedByName} · ${date(d.exportedAt)}`, {
    muted: true,
  });
  p(`Eksporto ID: ${exportId}`, { muted: true });
  if (simulated || d.risk.ruleSet.isDemo) {
    doc.moveDown(0.4);
    doc
      .font('Sans-Bold')
      .fontSize(9.5)
      .fillColor('#b42318')
      .text(
        'DEMONSTRACINĖ BYLA: patikros, registrų duomenys ir rizikos metodika yra imitaciniai, ne tikri.',
      )
      .fillColor('#000000');
  }

  h2('1. Sandoris');
  row('Sandorio tipas', label(lt.transactionTypes, c.transactionType));
  row('Turtas', `${label(lt.propertyTypes, c.propertyType)}, ${c.propertyAddress}`);
  row(
    c.transactionType === 'SALE' ? 'Sandorio vertė' : 'Mėnesio nuomos kaina',
    money(c.transactionType === 'SALE' ? c.transactionValue : c.monthlyRent),
  );
  row(
    'Atsiskaitymo būdas',
    c.paymentMethod
      ? `${label(lt.paymentMethods, c.paymentMethod)}${c.paymentMethodOther ? ` (${c.paymentMethodOther})` : ''}`
      : 'nenurodyta',
  );
  row('Sandorio etapas', label(lt.stages, c.stage));
  if (c.offerAcceptedAt) row('Pasiūlymas priimtas', date(c.offerAcceptedAt));
  row('AML procedūros', label(lt.amlApplicability, c.amlApplicability));
  if (c.amlActivationReason) row('Taikymo priežastis', c.amlActivationReason);
  row('Atitikties būsena', label(lt.complianceStatuses, c.complianceStatus));
  row('Teisinis režimas', label(lt.legalRegimes, c.legalRegime));
  row('Atsakingas', c.responsibleName);
  row('Byla sukurta', date(c.createdAt));

  h2('2. Sandorio šalys');
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
        cp.party.personalCodeMasked && `asmens kodas ${cp.party.personalCodeMasked}`,
        cp.party.companyCode && `įmonės kodas ${cp.party.companyCode}`,
        cp.party.birthDate && `gimė ${cp.party.birthDate}`,
        cp.party.citizenships.length > 0 && `pilietybė ${cp.party.citizenships.join(', ')}`,
        owner && `naudos gavėjas: ${owner}`,
      ]
        .filter(Boolean)
        .join(' · '),
      { indent: 10 },
    );
    if (cp.role !== 'BENEFICIAL_OWNER') {
      const kyc = cp.kyc as Record<string, unknown>;
      p(
        `CDD: ${label(lt.parties.cddScopes, cp.cddScope)} · ${label(lt.parties.cddStatuses, cp.cddStatus)}` +
          (cp.isOurClient ? ' · mūsų klientas' : '') +
          (cp.representedByOtherBroker ? ' · atstovauja kitas brokeris' : ''),
        { indent: 10 },
      );
      const answers = [
        kyc.purpose && `tikslas: ${String(kyc.purpose)}`,
        kyc.sourceOfFunds && `lėšų kilmė: ${String(kyc.sourceOfFunds)}`,
        typeof kyc.actsOnOwnBehalf === 'boolean' &&
          (kyc.actsOnOwnBehalf ? 'veikia savo vardu' : 'veikia NE savo vardu'),
        typeof kyc.pepSelfDeclared === 'boolean' &&
          (kyc.pepSelfDeclared ? 'deklaravo PEP statusą' : 'nedeklaravo PEP statuso'),
      ].filter(Boolean);
      if (answers.length) p(`KYC: ${answers.join(' · ')}`, { indent: 10 });
    }
  }

  h2('3. Tapatybės nustatymas');
  if (d.identity.length === 0) p('Įrašų nėra.', { muted: true });
  for (const v of d.identity) {
    const who = c.parties.find((x) => x.id === v.casePartyId)?.party.displayName ?? '';
    p(
      `${who}: ${label(lt.identity.statuses, v.status)} (${label(lt.identity.methods, v.method)}, ${v.provider}) · ` +
        `${label(lt.identity.documentTypes, v.documentType)} ${v.documentNumberMasked ?? ''}` +
        `${v.documentCountry ? `, ${v.documentCountry}` : ''} · ${date(v.completedAt ?? v.requestedAt)}`,
    );
  }

  if (d.ownership.length > 0) {
    h2('4. Registrų duomenys ir naudos gavėjai');
    for (const o of d.ownership) {
      doc.font('Sans-Bold').fontSize(10).text(`${o.company.name} (${o.company.code})`);
      p(
        `Šaltinis: ${o.provider} · gauta ${date(o.fetchedAt)} · ` +
          Object.entries(o.company.references)
            .map(([k, v]) => `${k} ${v}`)
            .join(', '),
        { muted: true, indent: 10 },
      );
      const tree = (nodes: OwnershipNode[], level: number) => {
        for (const n of nodes) {
          p(
            `${n.name}${n.code ? ` (${n.code}, ${n.country ?? ''})` : ''} – ${n.sharePercent} %` +
              (n.effectivePercent !== n.sharePercent
                ? ` (netiesiogiai ${n.effectivePercent} %)`
                : '') +
              (n.unresolved ? ' – duomenų nėra' : ''),
            { indent: 10 + level * 14 },
          );
          tree(n.children, level + 1);
        }
      };
      tree(o.analysis.tree, 0);
      p(`Naudos gavėjai (riba ${o.analysis.thresholdPercent} %):`, { indent: 10 });
      for (const u of o.ubos)
        p(
          `${u.person.firstName} ${u.person.lastName} ${u.person.personalCodeMasked ?? ''} · ` +
            `${label(lt.ownership.bases, u.basis)}${u.effectivePercent !== null ? ` ${u.effectivePercent} %` : ''} · ` +
            `${u.computed ? 'pagal akcijas' : 'nėra tarp akcininkų'}, ${u.declared ? 'deklaruotas JANGIS' : 'nedeklaruotas JANGIS'}`,
          { indent: 24 },
        );
      if (o.discrepancy) p('Nustatytas naudos gavėjų neatitikimas.', { indent: 10 });
      if (o.incomplete) p('Nuosavybės grandinė neatsekta iki fizinių asmenų.', { indent: 10 });
      if (o.resolution)
        p(
          `Sprendimas: ${label(lt.ownership.resolutions, o.resolution.resolution)} – ${o.resolution.notes} ` +
            `(įrodymas: ${o.resolution.evidence}; ${o.resolution.resolvedByName}, ${date(o.resolution.resolvedAt)})`,
          { indent: 10 },
        );
    }
  }

  h2(`${d.ownership.length > 0 ? 5 : 4}. Sankcijų, PEP ir neigiamos informacijos patikros`);
  if (d.screenings.length === 0) p('Patikrų nėra.', { muted: true });
  for (const s of d.screenings) {
    const who = c.parties.find((x) => x.id === s.casePartyId)?.party.displayName ?? '';
    p(
      `${who}: ${s.provider} · ${date(s.completedAt ?? s.requestedAt)} · ` +
        (s.status === 'COMPLETED' ? `sutapimų: ${s.matchCount}` : 'patikra nepavyko'),
    );
    for (const m of s.matches)
      p(
        `${m.categories.map((x) => label(lt.matchCategories, x)).join(', ')} · ${m.name}` +
          `${m.score ? ` · ${Number(m.score)} %` : ''} · ${label(lt.screening.reviewStatuses, m.reviewStatus)}` +
          `${m.reviewJustification ? ` – ${m.reviewJustification}` : ''}`,
        { indent: 14 },
      );
  }

  const n = (k: number) => (d.ownership.length > 0 ? k + 1 : k);
  h2(`${n(5)}. Rizikos vertinimas`);
  const current = d.risk.current;
  if (!current) p('Rizika neįvertinta.', { muted: true });
  else {
    row('Galutinė rizika', label(lt.riskLevels, current.finalLevel));
    row('Apskaičiuota', label(lt.riskLevels, current.calculatedLevel));
    if (current.mandatoryLevel)
      row('Privalomas minimumas', label(lt.riskLevels, current.mandatoryLevel));
    row(
      'Metodika',
      `${current.ruleSetCode} / ${current.ruleSetVersion}${current.isDemo ? ' (demonstracinė)' : ''}`,
    );
    row('Įvertino', `${current.assessedByName}, ${date(current.assessedAt)}`);
    row('Kita peržiūra', day(current.nextReviewOn));
    if (current.justification) row('Pagrindimas', current.justification);
    const matched = current.factors.filter((f) => f.matched);
    p(
      matched.length
        ? `Veiksniai: ${matched.map((f) => `${label(lt.riskFactors, f.code)} (${label(lt.riskLevels, f.level)})`).join('; ')}`
        : 'Rizikos veiksnių nenustatyta.',
    );
  }

  h2(`${n(6)}. Patvirtinimai ir pranešimai AML atsakingam asmeniui`);
  const { approvals, escalations } = d.decisions;
  if (approvals.length + escalations.length === 0) p('Nėra.', { muted: true });
  for (const a of approvals)
    p(
      `Patvirtinimas: ${label(lt.approvals.statuses, a.status)} · prašė ${a.requestedByName} (${date(a.requestedAt)}): ${a.reason}` +
        (a.decidedByName
          ? ` · sprendė ${a.decidedByName} (${date(a.decidedAt)}): ${a.decisionJustification}`
          : ''),
    );
  for (const e of escalations)
    p(
      `Pranešimas: ${label(lt.escalations.statuses, e.status)} · pranešė ${e.requestedByName} (${date(e.requestedAt)}): ${e.reason}` +
        (e.resolvedByName
          ? ` · sprendė ${e.resolvedByName} (${date(e.resolvedAt)}): ${e.resolutionNotes}`
          : ''),
    );

  h2(`${n(7)}. AML reikalavimų įvykdymas`);
  for (const e of d.checklist) {
    const who = e.casePartyId
      ? `${c.parties.find((x) => x.id === e.casePartyId)?.party.displayName ?? ''}: `
      : '';
    p(`${e.ok ? '✓' : '✗'} ${who}${label(lt.checklist.items, e.item)}`);
  }

  h2(`${n(8)}. Veiksmų istorija`);
  for (const a of d.audit)
    p(
      `#${a.seq} · ${date(a.occurred_at)} · ${a.actor ?? 'sistema'} · ${label(lt.auditActions, a.action)}`,
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
        `SkyDra · ${c.reference} · eksportas ${exportId} · ${i + 1} / ${range.count} psl.`,
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
): Promise<{ pdf: Buffer; sha256: string; exportId: string; reference: string }> {
  const data = await collectReport(client, keys, caseId);
  if (data.caseFile.complianceStatus !== 'COMPLETED')
    throw new RuleError('complete the AML checks before exporting the case');

  const { rows: ids } = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
  const exportId = ids[0]!.id;
  const pdf = await renderReport(data, exportId);
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
    after: { exportId, format: 'PDF', sha256, sizeBytes: pdf.length },
  });
  return { pdf, sha256, exportId, reference: data.caseFile.reference };
}

export async function listExports(client: PoolClient, caseId: string): Promise<CaseExport[]> {
  const id = z.uuid().parse(caseId);
  const { rowCount } = await client.query('SELECT 1 FROM cases WHERE id = $1', [id]);
  if (!rowCount) throw new NotFoundError('case not found');
  const { rows } = await client.query<CaseExport>(
    `SELECT x.id, x.sha256, x.size_bytes AS "sizeBytes", u.full_name AS "exportedByName",
            x.exported_at AS "exportedAt"
       FROM case_exports x JOIN users u ON u.id = x.exported_by
      WHERE x.case_id = $1 ORDER BY x.exported_at DESC`,
    [id],
  );
  return rows;
}
