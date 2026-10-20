# SkyDra – architektūra

*Versija 0.1 · 2026-10-20 · Būsena: juodraštis, laukia patvirtinimo*

Šis dokumentas fiksuoja techninius sprendimus, kuriais remiasi MVP kūrimas. Reikalavimų šaltiniai:

- `docs/AML NT brokeriu platformos verslo planas_pagrindinis.pdf` – verslo planas ir pradinė specifikacija;
- `docs/klausimai-klientui.md` – klausimai klientui;
- `docs/SkyDra_klausimai_klientui_atsakymai.docx` – kliento atsakymai;
- vėlesni pokalbiuose priimti sprendimai, apibendrinti 12 skyriuje.

---

## 1. Principai

1. **AML pareigos nepriklauso nuo plano.** Planai riboja tik organizacijos valdymo funkcijas. Privaloma patikra niekada neblokuojama dėl limito.
2. **Taisyklės yra duomenys, ne kodas.** Rizikos taisyklės, tvirtinimo matrica, peržiūrų intervalai, sutapimo slenksčiai, UBO ribos ir saugojimo terminai versijuojami ir susiejami su šalimi bei galiojimo laikotarpiu.
3. **Teisinis režimas fiksuojamas kiekviename įraše.** Kiekviena patikra ir kiekvienas vertinimas žino, pagal kurį režimą atliktas: PPTFPĮ iki 2027-07-10, AMLR nuo tos dienos.
4. **Tiekėjai keičiami be eigos pakeitimų.** Patikros, tapatybės patikra, registrai ir dokumentų ištraukimas veikia per vidines sąsajas su adapteriais: `MOCK`, `ONDATO`, `MANUAL` ir ateityje `SKYDRA_SEARCH`.
5. **Imitacija produkcijoje neįmanoma.** Jei `APP_ENV=prod`, o kuris nors adapteris yra `MOCK`, aplikacija nepasileidžia.
6. **Istorija neperrašoma.** Audit trail, sprendimai ir užbaigti vertinimai tik papildomi. Pataisa visada yra naujas įrašas su nuoroda į ankstesnį.
7. **Duomenys tik ES.** Produkcija veikia europe-north1 regione, atsarginės kopijos irgi lieka ES.
8. **Organizacijų duomenys izoliuoti duomenų bazės lygiu**, ne vien aplikacijos kode.

## 2. Aplinkos

Visos aplinkos yra viename GCP projekte: **ESV project** (`melodic-casing-501208-a3`), regione **europe-north1**.

| | Lokali | demo | prod |
|---|---|---|---|
| Adresas | `localhost` | `demo.skydra.eu` | `app.skydra.eu` |
| Duomenys | sintetiniai | tik sintetiniai | tikri (nuo piloto) |
| Imitaciniai adapteriai | leidžiami | leidžiami, UI ir PDF žymima „DEMO“ | **draudžiami** |
| Diegimas | `docker compose` | automatiškai iš `main` | rankinis to paties atvaizdo perkėlimas iš demo, su patvirtinimu |
| Analitikos srautas | išjungtas | išjungtas | tik organizacijoms su pasirašytu DPA |

**Izoliacija viename projekte:**

- Visi resursai turi prefiksą `skydra-{env}-*`.
- Kiekviena aplinka turi atskirus service accounts. Jų IAM teisės suteikiamos konkretiems resursams (bucket'ams, secrets, DB naudotojams), o ne visam projektui.
- Kiekviena aplinka turi atskiras duomenų bazes, bucket'us, secrets ir BigQuery duomenų rinkinius.
- **Iki piloto** demo ir prod naudoja vieną Cloud SQL instanciją, bet skirtingas duomenų bazes ir skirtingus DB naudotojus. **Prieš pilotą** prod perkeliamas į atskirą instanciją su didelio prieinamumo (HA) konfigūracija.
- Kol nėra pilotinių klientų, prod lieka be tikrų duomenų. Prieš pilotą jis išvalomas ir paleidžiamas iš naujo.

## 3. Technologijos

| Sritis | Sprendimas | Pastaba |
|---|---|---|
| Kalba | TypeScript (strict) | visame projekte |
| Vykdymo aplinka | Node.js 24 LTS | versija fiksuojama `.nvmrc` ir Docker atvaizde |
| Monorepo | pnpm workspaces | `apps/*`, `packages/*` |
| Frontend | React + Vite (SPA), React Router, TanStack Query | responsive; desktop, planšetė, telefonas |
| UI | Tailwind CSS + Radix UI komponentai, dizaino žetonai (tokens) | žetonai vėliau leis white-label |
| Formos ir validacija | react-hook-form + zod | zod schemos bendros frontend ir API |
| i18n | i18next | MVP tik `lt`; tekstai ne kode |
| API | NestJS (Fastify adapteris) | moduliai pagal domeną, guards teisėms tikrinti |
| API kontraktas | REST + OpenAPI, generuojamas iš zod schemų | pagrindas būsimam viešam API ir mobiliai aplikacijai |
| Duomenų bazė | PostgreSQL 17 | Cloud SQL; lokaliai Docker |
| DB prieiga | Drizzle ORM + SQL migracijos | RLS politikos ir trigeriai rašomi tiesiogiai SQL |
| Fono darbai | pg-boss (eilė PostgreSQL bazėje) | užduotis įrašoma toje pačioje transakcijoje kaip ir verslo pakeitimas (transactional outbox) |
| Failai | Google Cloud Storage; lokaliai `fake-gcs-server` | privatūs bucket'ai, trumpalaikės pasirašytos nuorodos |
| Antivirusas | ClamAV konteineris | failas iš karantino bucket'o perkeliamas tik nuskenavus |
| PDF | HTML šablonas → PDF per Playwright (Chromium) | tie patys i18n tekstai; SHA-256 maiša saugoma audit trail |
| ZIP | srautinis archyvavimas | bylos būsenos momentinė kopija |
| Testai | Vitest (unit), integraciniai testai su tikra PostgreSQL, Playwright (E2E) | E2E apima abu MVP priėmimo scenarijus |
| Infrastruktūra | Terraform, būsena GCS bucket'e (europe-north1) | demo ir prod aprašomi tais pačiais moduliais |
| CI/CD | GitHub Actions + Workload Identity Federation | jokių ilgalaikių service account raktų |

## 4. Sistemos komponentai

```
                 Internet
                    │
     ┌──────────────▼───────────────┐
     │ Global External Application  │  Google-managed TLS sertifikatai
     │ Load Balancer + Cloud Armor  │  WAF, užklausų dažnio ribojimas
     └──────┬───────────────┬───────┘
            │               │
   ┌────────▼──────┐ ┌──────▼────────┐
   │ skydra-{env}- │ │ skydra-{env}- │   Cloud Run (europe-north1)
   │ web (SPA)     │ │ api           │   ingress: tik per LB
   └───────────────┘ └──────┬────────┘
                            │ (pg-boss eilė)
                     ┌──────▼────────┐
                     │ skydra-{env}- │   fono darbai: patikros, PDF/ZIP,
                     │ worker        │   ištraukimas, stebėsena, analitika
                     └──┬─────┬───┬──┘
        ┌───────────────┘     │   └──────────────┐
┌───────▼───────┐   ┌─────────▼──────┐   ┌───────▼────────┐
│ Cloud SQL     │   │ Cloud Storage  │   │ Išoriniai      │
│ PostgreSQL 17 │   │ dokumentai,    │   │ tiekėjai       │
│ (private IP)  │   │ eksportai      │   │ (Ondato vėliau)│
└───────────────┘   └────────────────┘   └────────────────┘
        Secret Manager · Cloud Logging/Monitoring · BigQuery (analitika)
```

- **web** – statinė SPA, aptarnaujama konteinerio. Tas pats atvaizdas veikia abiejose aplinkose; konfigūracija paduodama vykdymo metu.
- **api** – REST API, autentifikacija ir visa domeno logika.
- **worker** – tas pats kodas kaip `api`, tik paleistas darbų režimu. Veikia su `min-instances=1`, nes turi nuolat skaityti eilę.
- **Periodiniai darbai** (pakartotinė stebėsenos patikra, analitikos eksportas, saugojimo terminų skaičiavimas): Cloud Scheduler sukuria užduotį eilėje.
- **DB migracijos** vykdomos kaip Cloud Run Job prieš kiekvieną diegimą.
- **Ryšys su DB:** Cloud Run per Direct VPC egress jungiasi prie Cloud SQL privataus IP.

## 5. Organizacijų duomenų izoliacija

- **Modelis:** `User ↔ Membership ↔ Organization → Plan`. Naudotojas gali priklausyti kelioms organizacijoms, o rolė priskiriama kiekvienoje narystėje atskirai. Solo brokeris yra vieno naudotojo organizacija.
- **Bendra schema.** Kiekviena organizacijos duomenų lentelė turi `organization_id` stulpelį ir **PostgreSQL Row-Level Security** politiką, kuri tikrina `current_setting('app.organization_id')`.
- **API užklausos eiga:** sesija → aktyvi organizacija → transakcijos pradžioje `SET LOCAL app.organization_id`, `app.user_id`. Užmiršus šį nustatymą, užklausa negrąžina jokių duomenų, o ne visus.
- **DB rolės:**
  - `skydra_app` – be `BYPASSRLS`, be `UPDATE`/`DELETE` teisių audit lentelėms;
  - `skydra_migrator` – migracijoms;
  - `skydra_platform` – Platform Admin operacijoms, kurių kiekviena papildomai auditojama.
- **Platform Admin nemato bylų turinio.** Išimtinė prieiga palaikymui (Q18) suteikiama tik laikinai, su priežastimi ir audito įrašu. Įgyvendinama 2 etape.

## 6. Autentifikacija ir teisės

- **Įgyvendinama pačioje aplikacijoje**, su patikrintomis bibliotekomis. Identity Platform nenaudojamas, kad naudotojų duomenys liktų mūsų ES bazėje ir nebūtų priklausomybės nuo GCP apmokėjimo kūrimo metu.
- **Slaptažodžiai:** argon2id, minimalus ilgis, tikrinimas pagal nutekintų slaptažodžių sąrašą (k-anonymity užklausa).
- **2FA privalomas:** TOTP (autentifikavimo programėlė) ir vienkartiniai atsarginiai kodai. Kol nėra el. pašto, atsarginiai kodai yra vienintelis būdas atgauti prieigą be administratoriaus.
- **Sesijos:** saugomos DB; `HttpOnly`, `Secure`, `SameSite=Lax` slapukas; neveiklumo ir absoliutus galiojimo laikas; CSRF apsauga.
- **El. pašto MVP nėra.** Kvietimo ir slaptažodžio atkūrimo nuorodas generuoja Platform Admin arba Organization Admin. Nuoroda vienkartinė, galioja ribotą laiką, DB saugoma tik jos maiša, o sugeneravimas auditojamas.
- **Google ir Microsoft prisijungimas** (OIDC) – po pagrindo, kaip papildomas būdas visiems planams. Įmonės SSO (SAML) – Agency Pro, 2 etapas.
- **Teisių modelis:** rolės (`PLATFORM_ADMIN`, `ORG_ADMIN`, `BROKER`, `MANAGER`) ir atskiros teisės (`AML_OFFICER`, `APPROVER`, `CASE_VIEW_ALL` ir kt.). Teisės tikrinamos per centralizuotą politikos funkciją `can(user, action, resource)`.
- **Plano teisės (entitlements):** funkcijų vėliavos ir skaitiniai limitai priskiriami planui, Platform Admin gali juos pakeisti konkrečiai organizacijai. Limitai „minkšti“: viršijus limitą sistema įspėja ir apskaito perviršį.

## 7. Domeno moduliai (MVP)

| Modulis | Esmė |
|---|---|
| `organizations` | organizacijos, narystės, kvietimai, planai, partnerių (referral) priskyrimas |
| `cases` | sandorio byla, neribotas šalių skaičius, sandorio stadija **atskirai** nuo AML būsenos, nuomos ≥10 000 EUR taisyklė, bylos atnaujinimas (`Completed → Reopened → Completed`) |
| `parties` | fiziniai ir juridiniai asmenys, kurie gali būti naudojami keliose tos pačios organizacijos bylose; kiekvienai šaliai CDD apimtis arba rėmimasis kitu įpareigotuoju subjektu |
| `ownership` | rekursyvi nuosavybės ir kontrolės grafo struktūra: akcijos ir klasės, bendraturčiai, nenustatyti dalyviai, ypatingi dalyviai (valstybė, fondai); netiesioginių dalių skaičiavimas; UBO nustatymo būdas; neatitikimų eiga |
| `screening` | sankcijos, PEP, adverse media, regulatory enforcement per tiekėjo adapterį; peržiūra (`FALSE_POSITIVE` / `TRUE_MATCH` / `INCONCLUSIVE`); išsaugomi originalūs atsakymai |
| `identity` | fizinis tapatybės patikrinimas, kurį atlieka brokeris; nuotolinis patikrinimas per adapterį (MVP – `MOCK`) |
| `documents` | įkėlimas, antivirusinis skenavimas, versijos, peržiūros ir atsisiuntimo auditas; ištraukimo eiga (tekstas → OCR/DI → patvirtinimas) per adapterį |
| `risk` | taisyklių variklis, versijuoti taisyklių rinkiniai (`LT-RISK-01`), lygiai LOW/MEDIUM/HIGH, būsenos `NOT_ASSESSED` ir `REVIEW_REQUIRED` (atskiros), privalomos ribos (PEP, didelės rizikos trečiosios šalys) |
| `approvals` | konfigūruojama tvirtinimo matrica, užduotys; solo organizacijoje – savarankiškas patvirtinimas su deklaracija, kelių naudotojų organizacijoje tvirtintojas negali būti bylos savininkas |
| `decisions` | sprendimai `APPROVE`, `APPROVE_WITH_ENHANCED_MEASURES`, `DECLINE`, `TERMINATE` atskirai nuo darbo eigos būsenų; kitos peržiūros data |
| `exports` | PDF ataskaita ir pilnas ZIP paketas, maiša, auditas |
| `audit` | nekeičiamas veiksmų žurnalas |
| `reviews` | `next_review_date` pagal rizikos lygį ir taisyklių rinkinį (numatytieji intervalai 5 / 3 / 1 m.), peržiūros dėl įvykių |
| `retention` | saugojimo taisyklės pagal kategorijas, `legal_hold`; automatinis trynimas išjungtas (`AUTO_DELETE=OFF`) |
| `analytics` | nuasmenintų įvykių transformacija, kilmės (lineage) žurnalas, eksportas į BigQuery |
| `usage` | mokamų išorinių užklausų ir limitų apskaita pagal organizaciją |

## 8. Audit trail

- **Lentelė `audit_events`:** kas, kada, iš kur (IP / sesija), veiksmas, objektas, reikšmė prieš ir po pakeitimo, užklausos ID.
- **Nekeičiamumas:** `skydra_app` rolė turi tik `INSERT` ir `SELECT` teises. Papildomai trigeris draudžia `UPDATE` ir `DELETE` net administratoriui.
- **Grandinė:** kiekvienas įrašas saugo ankstesnio tos pačios organizacijos įrašo maišą. Taip bet koks pakeitimas tampa aptinkamas, o grandinės vientisumą galima patikrinti eksportuojant.
- **Įrašymas:** įrašai kuriami toje pačioje transakcijoje kaip ir pats pakeitimas, todėl veiksmas negali įvykti be audito įrašo.
- **Rodymas:** naudotojui rodoma suprantama istorija (i18n tekstai).

## 9. Saugumas

- **Tinklas:**
  - **Load Balancer + Cloud Armor:** OWASP taisyklės ir užklausų dažnio ribojimas.
  - **Cloud Run ingress:** priima srautą tik per Load Balancer.
- **Šifravimas:**
  - **TLS:** visur.
  - **Duomenys saugykloje:** šifruojami Google numatytuoju šifravimu.
  - **Jautriems identifikatoriams** (asmens kodai, dokumentų numeriai) papildomai taikomas aplikacijos lygio šifravimas (envelope encryption su Cloud KMS). Galutinis sprendimas – prieš pilotą.
- **Paslaptys:** tik Secret Manager. Kode ir `.env` failuose repozitorijoje jų nėra.
- **Žurnalai:** struktūruoti (pino). Asmens duomenys juose maskuojami (redaction). Žurnaluose nėra dokumentų turinio ir identifikatorių.
- **Failai:** tikrinamas MIME tipas ir dydis, skenuojama antivirusu. Atsisiuntimas – tik per trumpalaikę pasirašytą nuorodą, kiekvienas atsisiuntimas auditojamas.
- **Priklausomybės:** Dependabot, `pnpm audit` ir konteinerių skenavimas CI metu.
- **Paruošta įsiskverbimo testui (pentest):** atskiras demo, organizacijų izoliacijos testai CI, aiškiai aprašytos administratoriaus funkcijos.

## 10. CI/CD

```
PR  ──► lint · typecheck · unit · integration (Postgres service) · build
main ──► build atvaizdų (web, api) ──► Artifact Registry (europe-north1)
     ──► migracijos (Cloud Run Job, demo) ──► diegimas į demo ──► E2E (demo)
release ──► rankinis patvirtinimas (GitHub Environment „prod“)
     ──► tas pats atvaizdo digest ──► migracijos (prod) ──► diegimas į prod
```

- GitHub Actions jungiasi prie GCP per Workload Identity Federation (be raktų).
- Kiekvienai aplinkai naudojamas atskiras diegimo service account su minimaliomis teisėmis.
- `main` šaka apsaugota: tik per PR, CI turi būti žalias.

## 11. Repozitorijos struktūra

```
skydra/
├── apps/
│   ├── web/                 React SPA
│   └── api/                 NestJS API + worker režimas
├── packages/
│   ├── shared/              zod schemos, tipai, enum'ai, i18n tekstai
│   ├── rules/               rizikos variklis ir taisyklių rinkiniai
│   └── config/              bendri eslint/tsconfig nustatymai
├── infra/
│   ├── terraform/           GCP resursai (modules/, envs/demo, envs/prod)
│   └── docker/              lokali aplinka (compose, seed)
├── docs/                    reikalavimai, architektūra, sprendimai
└── .github/workflows/       CI/CD
```

## 12. Priimti sprendimai (santrauka)

| # | Sprendimas | Šaltinis |
|---|---|---|
| D1 | Kodas kuriamas iš naujo, prototipas – tik pavyzdys | vartotojas |
| D2 | TypeScript, React, Node.js, PostgreSQL | vartotojas |
| D3 | Viskas viename GCP projekte „ESV project“, regionas europe-north1, ES duomenų rezidencija | vartotojas, Q47 |
| D4 | Trys aplinkos: lokali, demo (kartu ir testinė), prod | vartotojas |
| D5 | MVP be el. pašto; nuorodas generuoja administratorius | vartotojas |
| D6 | Nuotolinė tapatybės patikra – imitacija, kol nėra Ondato | vartotojas |
| D7 | MVP sąsaja tik LT, i18n nuo pradžių | vartotojas, Q10 |
| D8 | Planai Individual / Agency / Agency Pro; AML funkcijos visuose planuose | klientas |
| D9 | Rizikos modelis pagal veiksnių lygius be balų; centralizuotas LT-RISK-01; organizacijų taisyklės – 2 etapas | Q35, Q36, papildomi atsakymai |
| D10 | Viena byla su neribotu šalių skaičiumi; CDD apimtis nustatoma kiekvienai šaliai | Q20, Q21, papildomi atsakymai |
| D11 | MVP eksportas: PDF ir ZIP; Word – ne | Q42, Q44 |
| D12 | Automatinis duomenų trynimas išjungtas, kol nėra patvirtinto saugojimo grafiko | Q45 |
| D13 | `app.skydra.eu` (prod), `demo.skydra.eu`; pagrindinis puslapis lieka Hostinger | Q50 |

## 13. Atviri klausimai

| Klausimas | Kam | Ką blokuoja |
|---|---|---|
| GCP apmokėjimo įjungimas | klientas | diegimą į demo ir prod, seno turinio išvalymą |
| Papildomos IAM teisės: Cloud SQL, Pub/Sub, Scheduler, Monitoring, Logging konfigūravimas, Compute (LB / Cloud Armor), KMS, Workload Identity Pools | klientas / vartotojas | Terraform paleidimą |
| Ondato sutartis, sandbox, Lietuvos registrų duomenų formatas | klientas | Ondato adapterį, MVP priėmimą |
| LT-RISK-01 veiksnių lentelė | klientas (AML konsultantas) | rizikos taisyklių turinį (ne variklį) |
| Užpildyti JADIS ir JANGIS išrašai, JANGIS išrašų struktūros | klientas | ištraukimo testus |
| Sutikimas naudoti DI paslaugą (ES regione) kaip subtvarkytoją | klientas | DI pagrįstą dokumentų ištraukimą |
| Patvirtinto sankcijų sutapimo eiga MVP | klientas | `decisions` modulio taisykles |
