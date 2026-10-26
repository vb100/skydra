# SkyDra

AML/KYC sandorio bylų platforma NT brokeriams ir agentūroms.

- Architektūra ir priimti sprendimai: [docs/architecture.md](docs/architecture.md)
- Reikalavimų šaltiniai: [docs/](docs/)

## Struktūra

| Kelias            | Paskirtis                                                  |
| ----------------- | ---------------------------------------------------------- |
| `apps/api`        | NestJS (Fastify) API; vėliau ir fono darbų režimas         |
| `apps/web`        | React + Vite SPA                                           |
| `packages/shared` | bendros zod schemos, tipai ir i18n tekstai                 |
| `infra/docker`    | lokali aplinka (PostgreSQL 17, Cloud Storage emuliatorius) |

## Lokalus paleidimas

Reikia: Node.js 24 LTS (`.nvmrc`), pnpm 10, Docker.

```bash
pnpm install
cp .env.example apps/api/.env   # arba eksportuokite kintamuosius
pnpm db:up                      # PostgreSQL (:5433) ir GCS emuliatorius
pnpm db:migrate                 # migracijos (schemos savininko teisėmis)
pnpm db:seed:platform-admin --email admin@skydra.local --name "Vardas Pavardė"
pnpm dev                        # API :3000, web :5173
```

Paruošimo komanda išveda vienkartinę aktyvavimo nuorodą (`http://localhost:5173/activate#token=…`). Ją atidarius nustatomas slaptažodis ir 2FA (reikia autentifikavimo programėlės, pvz., Google Authenticator). Tada galima prisijungti, sukurti organizaciją ir gauti jos administratoriaus kvietimo nuorodą.

Web aplikacija `/api` užklausas per Vite proxy nukreipia į API. Sveikatos patikra: `http://localhost:3000/api/health`.

> **Jei lokali bazė sukurta anksčiau nei dabartinis `infra/docker/postgres-init/01-roles.sql`**, joje trūksta rolių `skydra_migrator` ir (arba) `skydra_app`. Bazę perkurkite: `docker compose -f infra/docker/compose.yaml down -v && pnpm db:up && pnpm db:migrate`. **Dėmesio:** `down -v` ištrina visus lokalios bazės duomenis.

## Duomenų bazė

- **Migracijos:** SQL failai `apps/api/migrations/NNNN_pavadinimas.sql`, vykdomi eilės tvarka, kiekvienas savo transakcijoje. Pritaikytos migracijos keisti negalima: jei pasikeitė kontrolinė suma, migracijų vykdytojas atsisako tęsti. Pataisos daromos nauja migracija.
- **Dvi DB rolės:**
  - `MIGRATION_DATABASE_URL` – `skydra_migrator`, schemos savininkas. Jis nėra superuser, kaip ir Cloud SQL, todėl RLS lokaliai ir testuose veikia taip pat kaip produkcijoje. Naudojamas tik migracijoms ir pradiniam administratoriaus paruošimui.
  - `DATABASE_URL` – `skydra_app`, kuriuo jungiasi API. Šis naudotojas lentelių neturi, todėl negali keisti schemos ar išjungti RLS.
- **Organizacijos ir prieigos:** `User ↔ Membership ↔ Organization → Plan`.
  - **Rolės** (`ORG_ADMIN`, `MANAGER`, `BROKER`) ir **teisės** (`AML_OFFICER`, `APPROVER`, `CASE_VIEW_ALL`) priskiriamos narystei.
  - **Prieigos sprendimai** priimami tik funkcijoje `can()` (`apps/api/src/access/policy.ts`).
  - **Organizacijas kuria tik Platform Admin**, per DB funkciją `app.platform_create_organization`. Funkcija pati patikrina, ar kviečiantysis yra Platform Admin, todėl API niekada neprireikia DB naudotojo, galinčio apeiti RLS.
- **Organizacijų izoliacija (RLS):** visos organizacijos duomenų užklausos vykdomos per `withTenant()` (`apps/api/src/database/tenant.ts`). Ši funkcija transakcijos pradžioje nustato organizacijos kontekstą. Jei konteksto nėra, užklausa negrąžina jokių eilučių.
- **Naujoms organizacijos lentelėms** reikia `organization_id` stulpelio ir iškvietimo `SELECT app.enable_tenant_isolation('lentele');` migracijoje.
- **Audit trail.** Kiekvienas reikšmingas veiksmas įrašomas su `recordAudit(client, {...})` (`apps/api/src/audit/audit.ts`), naudojant tą patį `withTenant` klientą. Taip įvykis išsaugomas tada ir tik tada, kai išsaugomas pats pakeitimas.
  - **Ką nustato DB:** laiką, eilės numerį, veikėją ir maišų grandinę. Aplikacija šių reikšmių pasirinkti negali.
  - **Ką draudžia DB:** `UPDATE`, `DELETE` ir `TRUNCATE` blokuoja trigeriai, net lentelės savininkui.
  - **Vientisumo patikra:** `verifyAuditChain()` aptinka pakeistus, iš vidurio ištrintus ir nuo grandinės galo pašalintus įrašus.

## Prisijungimas ir sesijos

- **Du faktoriai privalomi visiems:**
  - slaptažodis (argon2id, bent 12 simbolių);
  - TOTP kodas arba vienkartinis atsarginis kodas.
- **Prisijungimo bandymai:**
  - Po 5 nesėkmingų bandymų paskyra užrakinama 15 min. Skaičiuojami ir neteisingi 2FA kodai.
  - Klaidos pranešimas vienodas, kad ir kas būtų neteisinga: el. paštas, slaptažodis ar paskyra užrakinta.
- **Paslapčių saugojimas:**
  - TOTP paslaptys šifruojamos AES-256-GCM raktu, išvestu iš `SECRET_ENCRYPTION_KEY`.
  - Atsarginiai kodai saugomi kaip HMAC.
  - Sesijų ir nuorodų žetonai saugomi tik kaip SHA-256.
- **Sesija:**
  - Saugoma `HttpOnly`, `SameSite=Lax` slapuke (ne lokaliai – `__Host-`, `Secure`).
  - Po 2FA žetonas pakeičiamas nauju.
  - Baigiasi po 30 min. neveiklumo ir ne vėliau kaip po 12 val.
- **CSRF:** keičiančios užklausos privalo turėti antraštę `x-skydra-csrf: 1`, o `Origin` turi sutapti su `PUBLIC_APP_URL`.
- **Kvietimai ir slaptažodžio atkūrimas:**
  - Vienkartinės nuorodos su žetonu URL fragmente (`#token=`), todėl jis nepatenka į serverių žurnalus.
  - Atkuriant nustatomas naujas slaptažodis ir nauja 2FA, o visos sesijos nutraukiamos.
  - Organizacijos administratorius negali atkurti slaptažodžio naudotojui, kuris priklauso ir kitai organizacijai. Tai gali tik Platform Admin.
- **El. laiškų MVP nėra:** nuorodas administratorius perduoda pats, saugiu kanalu.

## AML bylos ir šalys

- **Byla = vienas sandoris** su neribotu šalių skaičiumi; fizinis ar juridinis asmuo yra šalies, ne bylos savybė.
- **Kas mato bylas** (tikrina ir API, ir DB eilučių politika `case_visibility`):
  - MANAGER arba teisė CASE_VIEW_ALL – visas organizacijos bylas;
  - BROKER – bylas, už kurias atsakingas arba kurias sukūrė;
  - vien ORG_ADMIN – jokių bylų.
- **Bylą kitam priskirti** gali tik vadovas, kai planas turi TASK_ASSIGNMENT. DB leidžia tai tik matančiam visas bylas, o atsakingas asmuo turi būti aktyvus brokeris arba vadovas.
- **AML taikymą nustato DB:** pirkimui–pardavimui procedūros taikomos visada, nuomai – nuo 10 000 EUR/mėn. Žemiau ribos brokeris gali jas pritaikyti savo sprendimu; tam reikia priežasties, o sprendimo atšaukti negalima.
- **Teisinis režimas** (PPTFPĮ iki 2027-07-10, vėliau AMLR) užfiksuojamas kuriant bylą ir nebekeičiamas.
- **Asmens kodai:**
  - šifruojami AES-256-GCM, o paieškai naudojamas HMAC indeksas, susietas su organizacija;
  - API rodo tik paskutinius 4 skaitmenis;
  - į audito žurnalą nepatenka.
- **Šalys:**
  - Šalis pakartotinai naudojama organizacijos bylose. Kito brokerio kliento brokeris nemato, bet įvedęs tą patį asmens ar įmonės kodą susieja esamą šalį ir dublikatas nesukuriamas.
  - Pašalinta iš bylos šalis lieka istorijoje.
  - Sudėtiniai išoriniai raktai neleidžia susieti kitos organizacijos bylos ir šalies.

## Patikros: sankcijos, PEP, neigiama informacija

- **Tiekėjai:**
  - Visi tiekėjai jungiami per `ScreeningProvider` sąsają (`SCREENING_PROVIDER`).
  - `MOCK` (lokaliai ir demo) imituoja rezultatus. Pavardė su „Sankcij“ grąžina sankcijas, „Politik“ – PEP, „Artimas“ – PEP artimą asmenį, „Skandal“ – neigiamą informaciją; kitais atvejais sutapimų nėra.
  - Prod aplinkoje `MOCK` uždraustas. `ONDATO` ir `MANUAL` kol kas aiškiai atsisako veikti.
- **Ką siunčiame tiekėjui:** vardą, gimimo datą ir šalis. Asmens kodo – niekada.
- **Patikros eiga:**
  - Tiekėjas kviečiamas ne DB transakcijos metu, o rezultatai išsaugomi vienoje transakcijoje kartu su auditu.
  - Nepavykusi patikra irgi užfiksuojama (`FAILED`).
- **Įrodymai:** užbaigtos patikros ir rasti sutapimai nebekeičiami ir netrinami.
- **Sutapimų vertinimas:** brokeris kiekvieną sutapimą įvertina vieną kartą – „klaidingas“ arba „patvirtintas“ – ir privalo nurodyti pagrindimą (bent 10 simbolių).
- **Bylos atitikties būseną** skaičiuoja tik `app.refresh_case_compliance`; programa jos tiesiogiai nustatyti negali.
  - `BLOCKED` – patvirtintos sankcijos.
  - `REVIEW_REQUIRED` – yra neįvertintas sutapimas arba patvirtintas PEP ar neigiama informacija.
  - `COMPLETED` – visos šalys patikrintos be atvirų sutapimų, o ten, kur CDD atliekame patys, jis užbaigtas.
  - Kitais atvejais būsena yra `IN_PROGRESS`, o `NOT_STARTED` – kai AML netaikoma arba bylai dar nepridėta šalių.

## Patikros (tos pačios kaip CI)

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:int   # reikia veikiančios bazės (pnpm db:up) ir TEST_DATABASE_URL
```

## Saugumo taisyklės, kurių laikomės nuo pradžių

- **`MOCK` adapteriai** (patikros, tapatybės patikra, registrai) leidžiami tik `local` ir `demo` aplinkose. Jei `APP_ENV=prod`, API su jais nepasileidžia.
- **Paslapčių repozitorijoje nėra.** `.env` failai įtraukti į `.gitignore`.
- **Paketai įdiegiami tik praėjus bent 3 dienoms nuo jų paskelbimo** (`minimumReleaseAge` nustatymas `pnpm-workspace.yaml` faile).
- **TypeScript fiksuotas 6.x versijoje**, nes TypeScript 7 neturi kompiliatoriaus API, kurio reikia tsup, typescript-eslint ir NestJS CLI.
