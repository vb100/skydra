# Ondato AML API – integracijos pastabos

*Peržiūrėta 2026-10-21. Šaltiniai: [AML Screening API v2](https://ondato.atlassian.net/wiki/spaces/PUB/pages/2128248871/AML+Screening+API+v2), jos subpuslapiai ir vieši OpenAPI aprašai:*

- *screening: `https://sandbox-amlscreening.ondato.com/swagger/v2/swagger.json`*
- *monitoring: `https://amlmonitoring.ondato.com/swagger/v1/swagger.json`*

> Sandbox prieigos dar neturime, todėl niekas čia neišbandyta su tikra API. Dokumentacijoje laukų pavadinimai rašomi nevienodai (pvz., `datasets` ir `dataSets`). Tikslius pavadinimus imame iš OpenAPI aprašo, o pirmuoju sandbox iškvietimu juos patikriname.

## 1. Aplinkos ir autentifikacija

| | Sandbox | Produkcija |
|---|---|---|
| Screening API | `https://sandbox-amlscreening.ondato.com` | `https://amlscreening.ondato.com` |
| Monitoring API | patikslinti | `https://amlmonitoring.ondato.com` |
| Žetonas | `https://sandbox-id.ondato.com/connect/token` | `https://id.ondato.com/connect/token` |

- **OAuth2 `client_credentials`.** Užklausa siunčiama kaip `application/x-www-form-urlencoded` su laukais `client_id`, `client_secret` ir (neprivalomu) `scope`.
- **Žetonas galioja 24 val.** Jį saugome ir naudojame pakartotinai; nauja užklausa siunčiama tik pasibaigus galiojimui arba gavus 401.
- **Scopes:**
  - `aml_screening_natural_api` – fiziniai asmenys;
  - `aml_screening_legal_api` – juridiniai asmenys;
  - `aml_monitoring_api` – stebėsena.
- **Prisijungimo duomenys:** demo ir prod naudoja skirtingus duomenis, laikomus Secret Manager.
- **Užklausų riba: 5 per sekundę.** Visos užklausos eina per pg-boss eilę su ribojimu, todėl ribos niekada neviršijame.
- **Klaidų formatas:** `{ reason, message, params? }`.

| HTTP | `reason` | Mūsų elgsena |
|---|---|---|
| 400 | `ValidationFailed` | klaida programoje, kartoti neverta |
| 401 | `AuthenticationFailed` | atnaujiname žetoną, kartojame vieną kartą |
| 403 | `AuthorizationFailed` | trūksta scope, kartoti neverta |
| 404 | `NotFound` | kartoti neverta |

## 2. Paieška (screening v2)

| Veiksmas | Endpoint |
|---|---|
| Asmens paieška | `POST /v2/natural-entities/search` |
| Įmonės paieška | `POST /v2/legal-entities/search` |
| Profilio detalės | `GET /v2/natural-entities/{resourceId}`, `GET /v2/legal-entities/{resourceId}` |
| Išsaugotas paieškos rezultatas | `GET /v2/natural-entities/search/{resourceId}` (ir legal) |
| Įrodymo failas | `GET /v2/{natural\|legal}-entities/{resourceId}/copyrighted-evidences/{evidenceId}/file` |
| Sutapimų peržiūros | `GET/POST /v2/match-resolutions/{resourceId}/matches/{matchId}/reviews` |
| Sankcijas skelbiančių institucijų sąrašas | `GET /v2/features/sanction-bodies` |

**Asmens paieškos laukai:**

| Laukas | Reikalingas? | Reikšmė |
|---|---|---|
| `name` | privalomas | vardas ir pavardė su lietuviškomis raidėmis |
| `datasets` | privalomas | duomenų rinkiniai |
| `threshold` | ne | numatytoji reikšmė 85 – sutampa su kliento atsakymu Q34 |
| `addresses[{geography, city}]` | ne | šalies kodas (ISO), čia perduodama ir pilietybė |
| `birthDate` | ne | gimimo data |
| `birthDateMatching` | ne | numatytoji reikšmė `SameYear` |
| `gender` | ne | lytis |
| `matching` | ne | `Fuzzy` arba `Strict` |
| `pepTiers` | ne | PEP pakopos |
| `sanBodyIdsInclude` / `sanBodyIdsExclude` | ne | kurių institucijų sankcijas tikrinti |
| `transliterateName` | ne | numatytoji reikšmė `true` |

**Įmonės paieška** naudoja tuos pačius laukus, tik be gimimo datos, lyties ir PEP pakopų.

**Duomenų minimizavimas:** asmens kodo siųsti nereikia. Perduodame tik vardą ir pavardę, gimimo datą, šalį ir lytį.

**Atsakymas:**
- `matchCount` ir `matches[]`. Kiekvienas sutapimas turi `resourceId`, `score` (75–100), `match`, `name`, `countries`, `datasets`, o įmonėms dar ir `currentSanBodyIds` / `formerSanBodyIds`.
- Viršutinio lygio `resourceId` identifikuoja pačią paiešką. Jį saugome kaip nuorodą į tiekėjo įrašą.

### Profilio detalės – ką gauname įrodymams
Asmens profilyje (`NaturalEntityDetailsResponse`) yra:

- **Tapatybė:** `aliases`, `datesOfBirthIso`, `nationalitiesIsoCodes`, `addresses`, `identifiers`. Šie laukai naudojami brokerio peržiūroje, kai lyginami kliento ir rasto profilio duomenys.
- **PEP:** `pepEntries` su `pepTier`, `current[]` ir `former[]`. Kiekvienas įrašas turi `countryIsoCode`, `position`, `segment`, `dateFromIso`, `dateToIso`. Tai atitinka specifikacijos reikalavimą saugoti pareigas, valstybę, PEP kategoriją ir statuso datas.
- **Sankcijos:** `sanctionEntries.current[]` ir `former[]`. Kiekvienas įrašas turi `regime.body`, `bodyId`, `name`, `origin` ir `measures`. Iš jų matyti, kuris sąrašas (ES, JT, OFAC) suveikė.
- **Kiti sąrašai:** `adverseMediaEntries`, `regulatoryEnforcementListEntries`, `controversialWeaponEntries`.
- **Šaltiniai:** `evidences[]` su `originalUrl`, `publicationDateIso`, `captureDateIso`, `credibility` ir `summary`.
- **Ryšiai:** `pepByAssociationEntries`, `individualLinks` ir `businessLinks` (įmonėms nurodomas ir `ownershipPercentage`). Tai šeimos nariai, artimi pagalbininkai ir ryšiai su įmonėmis.

**Kaip saugome:** gautą atsakymą įrašome į bylą kaip nekeičiamą momentinę kopiją (snapshot) su gavimo laiku ir naudotu `threshold`. Tiekėjo pusėje duomenys gali pasikeisti, todėl jo išsaugota istorija mums nepakanka.

## 3. Mūsų patikrų atitikmuo Ondato duomenų rinkiniams

| SkyDra patikra | Fizinis asmuo | Juridinis asmuo |
|---|---|---|
| Sankcijos | `GeneralSanctions` | `ExternalSanctions` |
| PEP | `GeneralPep` (+ `pepTiers`) | `ExternalPepLinked` |
| Adverse media | `ExternalAdverseMedia` | `ExternalAdverseMedia` |
| Regulatory enforcement | `ExternalRegulatoryEnforcementList` | `ExternalRegulatoryEnforcementList` |
| *(naujas galimas veiksnys)* | — | `ExternalStateOwnedEnterprise`, `ExternalInsolvencyRegister` |

- **Sankcijų sąrašai pagal šalį.** Laukas `sanBodyIdsInclude` leidžia kiekvienai šaliai pasirinkti institucijas, pvz., ES ir JT, o OFAC – pasirinktinai. Tai atitinka kliento reikalavimą sankcijų šaltinius konfigūruoti pagal šalį (Q27). Institucijų ID imame iš `/v2/features/sanction-bodies` ir saugome šalies taisyklių rinkinyje.
- **`Former` rinkiniai.** Buvusio PEP (12 mėn.) ir buvusių sankcijų rezultatai ateina kartu. Ar juos laikyti rizikos veiksniais, turi nuspręsti LT-RISK-01.

## 4. Sutapimų peržiūros būsenos

| SkyDra | Ondato `MatchStatus` |
|---|---|
| `POTENTIAL_MATCH` (neperžiūrėta) | `Open` |
| `FALSE_POSITIVE` | `FalsePositive` |
| `TRUE_MATCH` | `TruePositive` |
| `INCONCLUSIVE` | `Open` + komentaras |

- **Tiesos šaltinis – SkyDra.** Sprendimą, pagrindimą, naudotoją ir laiką saugo mūsų audit trail.
- **Sprendimą perduodame ir Ondato** (`POST .../reviews`), kad stebėsena vėl nepraneštų apie tą patį jau atmestą sutapimą.

## 5. Tęstinė stebėsena (monitoring v1)

- **Modelis:** *worklist* (sąrašas su nustatymais) → *records* (stebimi asmenys arba įmonės) → *matches* → *reviews*.
- **Worklist nustatymai:** `frequency` (`Daily`, `Weekly`, `Monthly`, `HalfAYear`, `Annual`), `threshold`, `dataSets`, `pepTiers`, `sanBodyIds*`, `matching`.
- **Įrašo laukai:** `name`, `dateOfBirth`, `addresses`, `gender`, `referenceId`, `referenceType`.
  - `referenceId` = mūsų vidinis šalies UUID. Taip neperduodame papildomų asmens duomenų ir lengvai susiejame rezultatus.
  - `referenceType` = organizacijos ID. Taip organizacijos atskiriamos ir tiekėjo pusėje.
- **Webhook'ų nėra.** Nei dokumentacijoje, nei OpenAPI apraše nėra webhook ar callback. Todėl Cloud Scheduler periodiškai paleidžia darbą, kuris užklausomis tikrina naujus sutapimus. Kiekvienas naujas sutapimas sukuria `REVIEW_REQUIRED` užduotį byloje.
- **Siūlomas worklist'ų išdėstymas:** atskiri worklist'ai kiekvienai aplinkai ir rizikos lygiui, pvz., `prod-high` – `Daily`, `prod-medium` ir `prod-low` – `Weekly`. Pasikeitus kliento rizikos lygiui, įrašą perkeliame į kitą worklist'ą.
- **Masiniai veiksmai:** sinchroniškai iki 25 įrašų, asinchroniškai iki 10 000.

## 6. Ko šiose API nėra

- **Lietuvos registrų duomenų** (JAR, JADIS, JANGIS). Endpoint'ų jiems nėra nei screening, nei monitoring API. Klientas minėjo registrų ataskaitas po 3 EUR – tai, matyt, atskiras Ondato KYB produktas su savo API, kurio dokumentacijos dar neturime.
- **Nuotolinės tapatybės patikros (IDV).** Tai irgi atskiras Ondato produktas.

## 7. Klausimai Ondato (perduoti per klientą)

1. Sandbox prisijungimo duomenys screening ir monitoring API. Koks monitoring sandbox adresas?
2. KYB / registrų API: ar grąžina Lietuvos JAR, JADIS ir JANGIS duomenis struktūruotai ar tik PDF? Kokie laukai? Kur dokumentacija?
3. Ar įmanomi webhook'ai stebėsenai? Jei ne, kokio dažnio užklausas rekomenduoja?
4. Ar `threshold` ir `sanBodyIds` galima nustatyti kiekvienai užklausai atskirai, kad skirtingų organizacijų taisyklės nesimaišytų?
5. Duomenų tvarkymo vieta ir subtvarkytojai (DPA); kiek laiko Ondato saugo paieškas ir worklist įrašus.
6. Kainodara: atskirai paieška, detalių užklausa ir stebimas įrašas per mėnesį.
