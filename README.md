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
pnpm dev                        # API :3000, web :5173
```

Web aplikacija `/api` užklausas per Vite proxy nukreipia į API. Sveikatos patikra: `http://localhost:3000/api/health`.

> **Jei lokali bazė buvo sukurta prieš atsirandant `infra/docker/postgres-init/`**, naudotojo `skydra_app` joje nėra. Bazę perkurkite: `docker compose -f infra/docker/compose.yaml down -v && pnpm db:up && pnpm db:migrate`. **Dėmesio:** `down -v` ištrina visus lokalios bazės duomenis.

## Duomenų bazė

- **Migracijos:** SQL failai `apps/api/migrations/NNNN_pavadinimas.sql`, vykdomi eilės tvarka, kiekvienas savo transakcijoje. Pritaikytos migracijos keisti negalima: jei pasikeitė kontrolinė suma, migracijų vykdytojas atsisako tęsti. Pataisos daromos nauja migracija.
- **Dvi DB rolės:**
  - `MIGRATION_DATABASE_URL` – schemos savininkas, naudojamas tik migracijoms.
  - `DATABASE_URL` – `skydra_app`, kuriuo jungiasi API. Šis naudotojas lentelių neturi, todėl negali keisti schemos ar išjungti RLS.
- **Organizacijų izoliacija (RLS):** visos organizacijos duomenų užklausos vykdomos per `withTenant()` (`apps/api/src/database/tenant.ts`). Ši funkcija transakcijos pradžioje nustato organizacijos kontekstą. Jei konteksto nėra, užklausa negrąžina jokių eilučių.
- **Naujoms organizacijos lentelėms** reikia `organization_id` stulpelio ir iškvietimo `SELECT app.enable_tenant_isolation('lentele');` migracijoje.
- **Audit trail.** Kiekvienas reikšmingas veiksmas įrašomas su `recordAudit(client, {...})` (`apps/api/src/audit/audit.ts`), naudojant tą patį `withTenant` klientą. Taip įvykis išsaugomas tada ir tik tada, kai išsaugomas pats pakeitimas.
  - **Ką nustato DB:** laiką, eilės numerį, veikėją ir maišų grandinę. Aplikacija šių reikšmių pasirinkti negali.
  - **Ką draudžia DB:** `UPDATE`, `DELETE` ir `TRUNCATE` blokuoja trigeriai, net lentelės savininkui.
  - **Vientisumo patikra:** `verifyAuditChain()` aptinka pakeistus, iš vidurio ištrintus ir nuo grandinės galo pašalintus įrašus.

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
