# Demo aplinkos diegimas į GCP (demo.skydra.eu)

*Parengta 2026-10-30. Tinka pirmajam diegimui ir vėlesniems atnaujinimams.*

**Kas jau patikrinta lokaliai:**
- Atvaizdas susikompiliuoja `linux/amd64` architektūrai.
- Migracijos veikia su ne-superuser savininku, kaip Cloud SQL.
- Programa paleista demo režimu: griežta CSP, `__Host-` slapukai, abu scenarijai veikia naršyklėje.
- Terraform validuojamas.

**Kas dar nebandyta:** visa, kas priklauso nuo GCP API. Tai bus patikrinta pirmu realiu diegimu.

## Architektūra

| Ištekliai | Pavadinimas | Paskirtis |
|---|---|---|
| Cloud Run paslauga | `skydra-demo` | API ir web sąsaja viename origin'e (vienas atvaizdas) |
| Cloud Run job'ai | `skydra-demo-migrate`, `skydra-demo-seed-demo` | migracijos (kiekvieno diegimo metu) ir demo duomenys |
| Cloud SQL | `skydra-demo-pg` (PostgreSQL 17, ENTERPRISE, `db-custom-1-3840`) | duomenų bazė; prieiga tik per Cloud SQL jungtį, kasdienės atsarginės kopijos ir PITR (ES) |
| Secret Manager | `skydra-demo-*` | DB adresai ir slaptažodžiai, šifravimo raktas |
| Paslaugų paskyros | `skydra-demo-run`, `skydra-demo-jobs` | paslauga mato tik savo 2 paslaptis; migracijų savininko slaptažodį mato tik job'ai |
| Artifact Registry | `europe-north1-docker.pkg.dev/melodic-casing-501208-a3/skydra` | atvaizdai, pažymėti commit'o žyma |
| Terraform state | `gs://melodic-casing-501208-a3-tfstate` | privatus bucket'as su versijomis; jame yra paslapčių, todėl prieigą turi tik administratoriai |

**Programos rolė DB.** `skydra_app` kuria migracija 0001, o slaptažodį jai suteikia migracijų job'as. Cloud SQL ją sukūręs būtų įtraukęs į `cloudsqlsuperuser`, todėl ji kuriama ne per Cloud SQL. Taip ji lieka paprasta rolė, kuriai galioja RLS.

## Ko reikia prieš pradedant

1. **Įjungtas apmokėjimas** „ESV project“ projekte.
2. **Paskyra.** Prisijungta `gcloud` paskyra (`gcloud auth login`, paskyra `vytautas.bielinskas@gmail.com`). Jai projekte reikia *Owner* rolės arba šių rolių:
   - Service Usage Admin;
   - Artifact Registry Admin;
   - Cloud SQL Admin;
   - Secret Manager Admin;
   - Cloud Run Admin;
   - Service Account Admin ir Service Account User;
   - Project IAM Admin;
   - Storage Admin;
   - Logs Viewer.
3. **Programos lokaliai:** veikiantis Docker (colima) ir `bq` (yra kartu su `gcloud`). Terraform diegti nereikia, nes jis paleidžiamas konteineryje.
4. **Domenas `skydra.eu` patvirtintas** [Google Search Console](https://search.google.com/search-console) ta pačia Google paskyra. Search Console duoda TXT įrašą, kurį reikia įdėti Hostinger DNS nustatymuose. Patvirtinimas paprastai užtrunka kelias minutes. Kol domenas nepatvirtintas, galima diegti su run.app adresu (žr. 4 žingsnį).

## Žingsniai

Visos komandos vykdomos iš repozitorijos šaknies, ant `main` šakos, kai darbo medis švarus.

### 1. Senų išteklių valymas

```bash
infra/scripts/cleanup-old-resources.sh            # tik parodo sąrašą
infra/scripts/cleanup-old-resources.sh --execute  # trina tik tai, kas parodyta, paprašius įvesti projekto ID
```

2026-10-30 (billing dar buvo išjungtas) sąraše buvo:
- bucket'as `melodic-casing-501208-a3-aruodas-results`;
- paslaugų paskyros `aruodas-web`, `aruodas-pipeline`, `aruodas-worker`;
- Firestore `(default)` DB.

`aruodas-*` ir `domoplius-*` Cloud Run paslaugų bei job'ų ir BigQuery `realestate_lt` rinkinio API negrąžino. Tikėtina, kad jie jau ištrinti. Įjungus billing'ą, sąrašą perskaitykite dar kartą ir tik tada vykdykite `--execute`.

### 2. Pradinis paruošimas (vieną kartą)

```bash
infra/scripts/bootstrap.sh
```

Sukuria Terraform state bucket'ą, įjungia reikiamas API ir sukuria Artifact Registry. Terraform parodys planą ir paprašys įvesti `yes`.

### 3. Diegimas

```bash
infra/scripts/deploy.sh demo
```

Ką daro skriptas:
1. Sukompiliuoja ir įkelia atvaizdą (`skydra:<commit>`).
2. Sukuria DB, paslaptis, paskyras ir job'us. Pirmą kartą Cloud SQL sukūrimas trunka apie 10–15 min.
3. Paleidžia migracijas.
4. Tik po migracijų atnaujina paslaugą, todėl nauja versija niekada nepradeda veikti su senesne schema.

Terraform du kartus parodys planą ir prašys įvesti `yes`.

**Rezultatas:** išvestyje `domain_dns_records` yra DNS įrašai. Paprastai tai `CNAME demo → ghs.googlehosted.com.`, kurį reikia įdėti Hostinger'yje. Po to Google automatiškai išduoda TLS sertifikatą (nuo 15 min. iki ~1 val.).

### 4. Jei domenas dar nepatvirtintas

```bash
infra/scripts/deploy.sh demo demo-runapp.tfvars
```

Demo veiks adresu `https://skydra-demo-915954505621.europe-north1.run.app`. Kai domenas bus patvirtintas, paleiskite `infra/scripts/deploy.sh demo`: bus sukurtas domeno susiejimas ir pakeistas `PUBLIC_APP_URL`.

### 5. Demo duomenys

```bash
infra/scripts/seed-demo.sh
```

Sukuria „Demo NT agentūrą“ su 9 bylomis ir atspausdina tris vienkartines aktyvavimo nuorodas (galioja 72 val.). Pakartotinis paleidimas išduoda naujas nuorodas.

**Saugumas.** Nuorodos matomos job'o žurnale, todėl jas reikia panaudoti iš karto.

### 6. Patikra

- **Sveikatos patikra:** `https://demo.skydra.eu/api/health` turi grąžinti `"status":"ok","env":"demo","simulatedProviders":true`.
- **Prisijungimas:** aktyvuokite paskyras ir prisijunkite. Prisijungus viršutinėje juostoje turi būti matoma DEMO žyma.

## Atnaujinimai ir atšaukimas

- **Naujai versijai:** `git pull` ant `main` ir `infra/scripts/deploy.sh demo`.
- **Grįžimas prie ankstesnės versijos:** `git checkout <ankstesnis-commit>` ir `infra/scripts/deploy.sh demo`. Migracijos vykdomos tik pirmyn, todėl grįžti galima tik prie versijos be naujesnių migracijų. Kitu atveju reikia pataisyti klaidą ir išdiegti naują versiją.
- **Paslaugos žurnalai:** Cloud Console → Cloud Run → `skydra-demo` → Logs.

## Apytikslės išlaidos (demo)

| Ištekliai | Per mėn. |
|---|---|
| Cloud SQL `db-custom-1-3840`, 10 GB SSD, atsarginės kopijos | ~50 USD |
| Cloud Run (0 instancijų be apkrovos) | ~0–5 USD |
| Secret Manager, Artifact Registry, žurnalai | ~1–3 USD |

Skaičiai apytiksliai, pagal viešus kainoraščius. Pigesnis variantas: `db_tier = "db-g1-small"` faile `demo.tfvars` (apie dvigubai pigiau). Jo veikimo su PostgreSQL 17 dar nepatikrinome.

## Produkcija (vėliau)

Produkcijai naudojamas tas pats `infra/terraform/env` kodas su `prod.tfvars`. Skirtumai:
- `env = "prod"`;
- `public_app_url = "https://app.skydra.eu"`;
- tikri tiekėjai, nes programa su `MOCK` produkcijoje nepasileidžia;
- `db_high_availability = true`;
- `min_instances = 1`.

Demo job'o produkcijoje nėra.
