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

## Demo duomenys (prototipo pristatymui)

```bash
pnpm db:seed:demo               # „Demo NT agentūra“: 3 nariai ir 9 bylos
pnpm dev
```

- **Nariai.** Komanda sukuria tris narius ir kiekvienam išveda vienkartinę aktyvavimo nuorodą (galioja 72 val.). Paskyrą aktyvuodamas pristatantis asmuo pats nusistato slaptažodį ir 2FA, todėl iš anksto žinomų prisijungimo duomenų nėra.
  - Gintarė Vadovaitė (`vadove@demo.skydra.eu`) – administratorė, vadovė, tvirtintoja;
  - Tomas Brokeraitis (`brokeris@demo.skydra.eu`) – brokeris, atsakingas už bylas;
  - Aistė Atitiktytė (`aml@demo.skydra.eu`) – brokerė ir AML atsakinga asmuo.
- **Bylos sukuriamos per tuos pačius servisus kaip ir sąsajoje**, todėl joms galioja visos taisyklės ir pilnas auditas:

| Byla | Būsena                          | Ką rodo                                                     |
| ---- | ------------------------------- | ----------------------------------------------------------- |
| 0001 | Atlikta, žema rizika            | pilnas fizinių asmenų sandoris; galima eksportuoti PDF      |
| 0002 | Reikia peržiūros, didelė rizika | patvirtintas PEP; patvirtinimo laukia vadovė                |
| 0003 | Reikia peržiūros                | neigiamos informacijos sutapimas laukia brokerio įvertinimo |
| 0004 | Nepradėta                       | nuoma < 10 000 EUR/mėn., AML netaikoma                      |
| 0005 | Vykdoma                         | nuoma, kuriai AML pritaikyta brokerio sprendimu             |
| 0006 | Vykdoma                         | įmonė su UBO neatitikimu (JANGIS)                           |
| 0007 | Atlikta, vidutinė rizika        | įmonė per holdingą, UBO nustatyti ir patikrinti             |
| 0008 | Sustabdyta                      | grynieji ir pranešimas AML atsakingam asmeniui              |
| 0009 | Sustabdyta                      | patvirtintas sankcijų sutapimas                             |

- **Pakartotinis paleidimas** bylų nekuria. Jis tik išduoda naujas nuorodas dar neaktyvavusiems nariams.
- **Prod aplinkoje** komanda neveikia.

## Bylos eksportas (PDF)

- **Kada galima.** Eksportuoti galima tik užbaigtą bylą (atitikties būsena `COMPLETED`). Tai tikrina ir API, ir DB.
- **Turinys.** PDF apima sandorį, šalis, tapatybės nustatymą, registrų duomenis ir UBO, patikras, rizikos vertinimą, sprendimus, AML reikalavimų įvykdymą ir veiksmų istoriją.
  - Asmens ir dokumentų numeriai rodomi tik užmaskuoti.
  - Demonstraciniai duomenys PDF faile aiškiai pažymėti.
- **Registras.** Kiekvieno eksporto SHA-256 maiša įrašoma į `case_exports` ir audito žurnalą. Pagal ją vėliau galima patikrinti, ar pateiktas failas nepakeistas.
- **Kaip daromas.** Eksportas daromas POST užklausa su CSRF antrašte, todėl jo negalima sukelti iš kitos svetainės.
- **Šriftas.** Naudojamas DejaVu Sans – su juo teisingai rodomos lietuviškos raidės.

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

## KYC užbaigimas: tapatybė, patvirtinimai, eskalavimai

- **Kontrolinis sąrašas.** `app.case_checklist` parodo, ko bylai trūksta. Iš jo skaičiuojama ir atitikties būsena, todėl abu visada sutampa. Sąrašo punktai:
  - šalys pridėtos;
  - kiekviena šalis patikrinta;
  - sutapimai įvertinti;
  - tapatybė patikrinta (fiziniams asmenims, kai CDD atliekame patys);
  - CDD užbaigtas;
  - nėra patvirtintų sankcijų;
  - jei reikia, gautas EDD patvirtinimas, ir jis neatmestas;
  - nėra neišspręstų eskalavimų.
- **Tapatybės patikra:**
  - **gyvai:** brokeris įveda dokumento duomenis, dokumento numeris šifruojamas, pasibaigęs dokumentas atmetamas;
  - **nuotoliu:** per tiekėją. `MOCK` leidžia imituoti rezultatą „patvirtinta“ arba „atmesta“; Ondato bus prijungtas vėliau.
  - Užbaigta patikra nebekeičiama.
- **CDD užbaigtu pažymėti negalima,** kol neužpildytas sandorio tikslas ir pareiškimai (veikia savo vardu, PEP) ir kol nepatikrinta fizinio asmens tapatybė.
- **Pereiti į sutarties ar užbaigimo etapą** galima tik tada, kai atitikties būsena yra `COMPLETED` (taikoma, kai AML procedūros galioja).
- **EDD patvirtinimas.** Jo reikia, kai patvirtintas PEP arba neigiama informacija.
  - Sprendžia narys su teise APPROVER.
  - Sprendžiantis negali būti nei atsakingas brokeris, nei prašymo autorius. Išimtis – vieno nario organizacija (solo).
  - Atmestas patvirtinimas sustabdo bylą.
- **Eskalavimas AML atsakingam asmeniui.**
  - Pranešti gali bet kuris bylą matantis narys. Kol pranešimas neišspręstas, byla sustabdyta.
  - Išspręsti gali tik AML_OFFICER: „įtarimas nepasitvirtino“ arba „pranešta FNTT“. Pastaruoju atveju byla lieka sustabdyta.
- **Visų bylų matomumas.** Tvirtintojai ir AML atsakingi asmenys mato visas organizacijos bylas, nes priima sprendimus dėl kitų narių bylų.

## Juridiniai asmenys: registrai ir naudos gavėjai (UBO)

- **Registrų duomenys.** Kiekvienam juridiniam asmeniui, kuriam atliekame CDD, gaunami registrų duomenys per `RegistryProvider`: JAR, JADIS ir JANGIS.
  - `MOCK` naudoja sintetines įmones. Jų kodai:
    - `300000001` – paprasta įmonė;
    - `300000002` – nuosavybė per holdingą (60 % × 100 %);
    - `300000003` – UBO neatitikimas;
    - `300000004` – neatsekamas užsienio savininkas.
  - Bet kuris kitas kodas duoda paprastą įmonę su vienu savininku.
- **Analizė** (`ownership/analysis.ts`) yra gryna funkcija:
  - atseka grandinę ir apskaičiuoja netiesiogines dalis;
  - UBO nustato pagal ribą, kuri saugoma kaip duomenys (`ownership_rule_sets`, LT-UBO-01: 25 %). Jei savininko virš ribos nėra, UBO laikomas vadovas;
  - palygina rezultatą su JANGIS ir aptinka nepilnas grandines bei ciklus.
- **Išrašai** (`ownership_snapshots`) nekeičiami.
  - Asmens kodai JSON'e saugomi tik užšifruoti ir užmaskuoti, o UBO raktas – kaip su organizacija susieta HMAC reikšmė.
  - Veikti galima tik pagal naujausius duomenis.
- **UBO bylos šalys.** Nustatyti UBO pridedami kaip bylos šalys su vaidmeniu `BENEFICIAL_OWNER`.
  - Jiems taikoma sankcijų ir PEP patikra.
  - Gyvo tapatybės patikrinimo ir KYC atsakymų iš jų nereikia, nes jų CDD apima įmonės CDD.
  - Rankiniu būdu UBO pridėti negalima. Pašalinus įmonę, pašalinami ir jos UBO.
- **Neatitikimas arba nepilna grandinė** blokuoja bylos užbaigimą, kol užfiksuojamas sprendimo būdas, pagrindimas (bent 20 simbolių) ir įrodymas. Tai galima padaryti vieną kartą.
- **Kontrolinis sąrašas** papildytas punktais `OWNERSHIP_FETCHED`, `OWNERSHIP_RESOLVED` ir `UBOS_LINKED`.
- **Rizikos metodika `DEMO-2`** prideda veiksnį „sudėtinga arba neatsekama nuosavybė“. Užsienio UBO veikia per geografijos veiksnius.

## Rizikos vertinimas (LT-RISK-01)

- **Taisyklės yra duomenys.**
  - Versijuoti rinkiniai laikomi lentelėje `risk_rule_sets`. Programa juos gali tik skaityti.
  - Dabar galioja `LT-RISK-01 / DEMO-1` – laikina lentelė, kurią sąsaja žymi kaip DEMO. Ji aprašyta `docs/rizikos-metodika-LT-RISK-01.md`.
  - Tikroji lentelė bus nauja versija, įdėta migracija. Varikliui pakeitimų nereikės.
- **Variklis** (`apps/api/src/risk/engine.ts`) yra gryna funkcija. Ji surenka bylos faktus (PEP, sankcijas, šalis, atsiskaitymo būdą, vertę ir kt.) ir pritaiko taisykles.
  - Galimi lygiai: LOW / MEDIUM / HIGH, be balų.
  - Bendras lygis lygus didžiausiam suveikusio veiksnio lygiui. Jei suveikia keli MEDIUM veiksniai (DEMO-1 – trys), rizika tampa HIGH.
  - Privalomi veiksniai (PEP, sankcijos, didelės rizikos trečioji šalis) nustato minimumą.
  - Netaisyklingas rinkinys atmetamas iškart (zod), o ne skaičiuojamas.
- **Vertinimai nekeičiami.**
  - Įrašoma: faktai, kiekvieno veiksnio rezultatas, apskaičiuotas ir galutinis lygis, metodikos versija, teisinis režimas ir kitos peržiūros data (5 / 3 / 1 m.).
  - Brokeris galutinį lygį gali padidinti, nurodęs pagrindimą.
  - Sumažinti gali tik tvirtintojas, kuris nėra atsakingas brokeris (išskyrus solo).
  - Žemiau privalomo minimumo nustatyti negali niekas. Tai užtikrina DB.
- **Pasenęs vertinimas.** Jei po vertinimo pasikeičia rizikos duomenys (vertė, atsiskaitymas, šalys, KYC atsakymai, patikros, tapatybė), sąrašo punktas „Įvertinta rizika“ vėl tampa neįvykdytas. Etapo keitimas ir CDD užbaigimas vertinimo nepasendina.
- **HIGH rizika** reikalauja EDD patvirtinimo, kaip ir patvirtintas PEP. Prašyti patvirtinimo galima tik įvertinus riziką.

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
