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
pnpm db:up                      # PostgreSQL ir GCS emuliatorius
pnpm dev                        # API :3000, web :5173
```

Web aplikacija `/api` užklausas per Vite proxy nukreipia į API. Sveikatos patikra: `http://localhost:3000/api/health`.

## Patikros (tos pačios kaip CI)

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Saugumo taisyklės, kurių laikomės nuo pradžių

- **`MOCK` adapteriai** (patikros, tapatybės patikra, registrai) leidžiami tik `local` ir `demo` aplinkose. Jei `APP_ENV=prod`, API su jais nepasileidžia.
- **Paslapčių repozitorijoje nėra.** `.env` failai įtraukti į `.gitignore`.
- **Paketai įdiegiami tik praėjus bent 3 dienoms nuo jų paskelbimo** (`minimumReleaseAge` nustatymas `pnpm-workspace.yaml` faile).
- **TypeScript fiksuotas 6.x versijoje**, nes TypeScript 7 neturi kompiliatoriaus API, kurio reikia tsup, typescript-eslint ir NestJS CLI.
