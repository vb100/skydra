# OpenSanctions – sankcijų ir PEP patikra

*Įdiegta 2026-11-24 pagal kliento specifikaciją „SkyDra – patikrų automatizavimo techninė specifikacija“ (modulis A). Šaltinis: [OpenSanctions API dokumentacija](https://www.opensanctions.org/docs/api/).*

> Tikro rakto dar neturime. Adapteris parašytas pagal dokumentaciją ir OpenAPI aprašą, o testuose API imituojamas. Pirmąją tikrą užklausą reikia patikrinti demo aplinkoje (žr. „Patikrinti su tikru raktu“).

## Kaip veikia

| | |
|---|---|
| Užklausa | `POST {OPENSANCTIONS_URL}/match/default?algorithm=best&threshold={slenkstis}&limit=10` |
| Autentifikacija | antraštė `Authorization: ApiKey <raktas>`; raktas tik Secret Manager arba aplinkos kintamajame |
| Viena užklausa | vienas asmuo ar įmonė (vienas kreditas, €0,10); apmokestinamos tik sėkmingos (HTTP 200) |
| Fizinis asmuo | `Person`: `name`, `birthDate`, `nationality`. **Asmens kodas nesiunčiamas.** |
| Įmonė | `Company`: `name`, `registrationNumber` (įmonės kodas), `jurisdiction` |

**Stiprūs ir silpni atitikmenys.** API pažymi `match: true`, kai balas siekia slenkstį (`OPENSANCTIONS_THRESHOLD`, numatytasis 0,7). Tokie atitikmenys yra **stiprūs**: kol jie neįvertinti, byla nejuda toliau. Žemesnio balo rezultatai, jei API juos grąžina, yra **silpni**: rodomi suskleisti, bylos nestabdo, bet juos galima įvertinti.

**`topics` reikšmės ir kategorijos:**

| OpenSanctions | SkyDra | Pasekmė |
|---|---|---|
| `sanction`, `sanction.control` | Sankcijos | patvirtinus – byla stabdoma |
| `role.pep` | PEP | patvirtinus – sustiprintas tyrimas, vadovybės patvirtinimas |
| `role.rca` | PEP artimas asmuo | kaip PEP |
| `sanction.linked`, `debarment`, `poi`, `wanted`, `corp.disqual`, `crime*`, `reg.*` | Kitas sąrašas | peržiūra |
| `sanction.counter` (kontrsankcijos) | – | ne rizika; jei kitų žymių nėra, rodoma kaip „kitas sąrašas“ |

Lietuvos PEP (VTEK, `lt_pep_declarations`) ir FNTT sąrašai (`lt_fiu_freezes`) jau yra OpenSanctions duomenyse.

**Patikimumas.** Kiekvienas bandymas turi 15 s laiko ribą. Iki 3 bandymų kartojama tik tada, kai atsakymo nėra, atsakymas yra 429 arba 5xx; tarp bandymų laukiama 0,5 s, paskui 1 s. 401 ir 422 nekartojami. Nepavykusi patikra visada yra `FAILED`, niekada „atitikmenų nerasta“.

**Įrodymai.** Kiekvienas bandymas įrašomas į `screening_requests`: užklausa (be rakto), atsakymas, HTTP kodas, atsakymo SHA-256, trukmė ir laikas. Lentelę programa gali tik papildyti. Brokeriui rodomi pagrindiniai laukai (žymės, pareigos, gimimo data, pilietybė, šaltinių sąrašai, nuoroda į OpenSanctions įrašą).

## Įjungimas

1. Klientas užsiregistruoja [opensanctions.org/api](https://www.opensanctions.org/api) įmonės el. paštu (2 000 nemokamų kreditų) ir perduoda raktą.
2. Raktas įdedamas į Secret Manager: `printf %s "<raktas>" | gcloud secrets versions add skydra-demo-opensanctions-api-key --data-file=- --project melodic-casing-501208-a3`.
3. Terraform: `integrations.screening = "OPENSANCTIONS"` faile `demo.tfvars` arba `demo-runapp.tfvars`, tada `infra/scripts/deploy.sh demo …`.

## Patikrinti su tikru raktu

- Ar atsakyme grąžinami rezultatai žemiau slenksčio (`match: false`), ar tik virš jo. Nuo to priklauso, ar bus silpnų atitikmenų.
- Kokį HTTP kodą API grąžina pasibaigus kreditams (dokumentacijoje nenurodyta).
- Žinomas sankcionuotas asmuo, žinomas Lietuvos PEP ir išgalvotas asmuo be atitikmenų (specifikacijos testiniai asmenys).

## Atviri klausimai (klientui)

- Ar licencija leidžia rodyti rezultatus brokeriams komerciniame produkte (gamybos sąlyga).
- OpenSanctions įtraukimas į sub-tvarkytojų sąrašą ir duomenų tvarkymo sąlygos.
