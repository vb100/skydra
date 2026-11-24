# Neigiama informacija žiniasklaidoje – Brave Search ir GDELT

*Įdiegta 2026-11-24 pagal kliento specifikaciją „SkyDra – patikrų automatizavimo techninė specifikacija“ (modulis B). Šaltiniai: [Brave Search API](https://api-dashboard.search.brave.com/app/documentation), [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/).*

> Tikro Brave rakto dar neturime. Adapteriai parašyti pagal dokumentaciją, o testuose API imituojamas. Atsakymai skaitomi atlaidžiai: netinkamas rezultatas praleidžiamas, o ne visa patikra. Pirmąsias tikras užklausas reikia patikrinti demo aplinkoje (žr. „Patikrinti su tikru raktu“).

## Kaip veikia

Žiniasklaidos paieška nėra atskira patikra. Ji vyksta **toje pačioje patikroje kaip OpenSanctions**: abu šaltiniai klausiami lygiagrečiai, o rasti straipsniai išsaugomi kaip `ADVERSE_MEDIA` atitikmenys šalia sankcijų ir PEP atitikmenų. Dėl to kontrolinis sąrašas, spalvinė būsena ir PDF ataskaita straipsnius vertina taip pat kaip kitus atitikmenis. Patikra įrašo naudotus šaltinius (`screening_checks.sources`, pvz. `{OPENSANCTIONS,BRAVE}`).

Paieška veikia tik su `SCREENING_PROVIDER=OPENSANCTIONS`. Imitacijos režime (`MOCK`) tikri šaltiniai nekviečiami, o pavardė su „Skandal“ grąžina imituotą straipsnį.

**Kas siunčiama:** tik vardas ir pavardė arba įmonės pavadinimas su rizikos žodžiais. Gimimo data, pilietybė ir asmens kodas į paieškos sistemas **nesiunčiami**.

### Užklausos

Forma: `("vardo forma 1" OR "vardo forma 2" …) (žodis1 OR "žodžių junginys" …)`.

| | |
|---|---|
| Fizinis asmuo | vardininkas ir kilmininkas (Jonas Jonaitis, Jono Jonaičio), abu ir be lietuviškų raidžių. Kilmininkas sudaromas pagal galūnę (-as, -is, -ys, -us, -ė, -a…). Nelietuviškas vardas ieškomas toks, koks įrašytas |
| Įmonė | pavadinimas be teisinės formos (UAB, AB, MB, VšĮ…) ir be kabučių |
| Rizikos žodžiai LT | sukčiavimas, pinigų plovimas, kyšis, korupcija, nuteistas, įtariamas, kaltinamas, sulaikytas, krata, FNTT, STT, apgaulė, mokesčių vengimas, bankrotas, sankcijos |
| Rizikos žodžiai EN | fraud, money laundering, bribery, corruption, convicted, charged, arrested, sanctions, tax evasion |

### Brave Search

| | |
|---|---|
| Užklausos | 3 vienam asmeniui: naujienos LT (`/news/search`, `country=LT`, `search_lang=lt`, iki 50), internetas LT (`/web/search`, iki 20), internetas EN (iki 20) |
| Autentifikacija | antraštė `X-Subscription-Token`; raktas laikomas tik Secret Manager arba aplinkos kintamajame |
| Ribos | užklausa iki 400 simbolių ir 50 žodžių; jei netelpa, rizikos žodžiai atmetami nuo sąrašo galo. Tarp užklausų bent 1 s (nemokamo plano riba) |
| Atranka | Brave gali grąžinti puslapius, kurie užklausą atitinka tik iš dalies. Todėl paliekami tik rezultatai, kurių pavadinime ar ištraukoje yra asmens pavardės kamienas (pvz. „jonai“ – tinka ir Jonaitis, ir Jonaičio) arba įmonės pavadinimas |

### GDELT

| | |
|---|---|
| Užklausa | 1 vienam asmeniui: viso pasaulio naujienos, visomis kalbomis, paskutiniai 3 mėnesiai (`timespan=3months`, iki 50 straipsnių) |
| Autentifikacija | nereikia, nemokama |
| Ribos | GDELT prašo ne dažniau nei kas 5 s; programa užklausas išdėsto automatiškai |
| Įjungimas | `GDELT_ENABLED=true`, **tik kai klientas patvirtins DPIA** (numatytoji reikšmė `false`) |

### Rezultatai

- Tas pats straipsnis iš abiejų šaltinių arba su skirtingais adresais (http/https, `www.`, `utm_*` parametrai) sujungiamas į vieną.
- Patikroje lieka ne daugiau kaip 25 straipsniai, naujausi pirmi.
- Kiekvienas straipsnis yra **stiprus** atitikmuo: kol jis neįvertintas, byla nejuda toliau.
- Brokeriui rodoma: pavadinimas su nuoroda, svetainė, data, ištrauka su paryškintais vardo ir rizikos žodžiais, šaltinis (Brave, GDELT).

### Brokerio sprendimas

| Sprendimas | Reikšmė | Pasekmė |
|---|---|---|
| Apie šį asmenį – neigiama informacija | `TRUE_POSITIVE` | geltona būsena, reikia vadovybės patvirtinimo (kaip kitai patvirtintai rizikai), rizikos vertinimas atliekamas iš naujo |
| Apie kitą asmenį (bendrapavardis) | `FALSE_POSITIVE` | straipsnis atmestas |
| Apie šį asmenį, bet neaktualu rizikai | `NOT_RELEVANT` | straipsnis atmestas. Toks sprendimas galimas tik straipsniui; tai užtikrina ir API, ir duomenų bazė |

Komentaras (bent 10 simbolių) privalomas visada, o sprendimas galutinis.

### Patikimumas ir įrodymai

- Kiekvienam bandymui taikoma tokia pati politika kaip OpenSanctions: 15 s laiko riba ir iki 3 bandymų, kai atsakymo nėra, gaunamas 429 arba 5xx.
- **Jei bent vienas šaltinis nepasiekiamas, visa patikra yra `FAILED`.** Dalinis rezultatas brokeriui atrodytų kaip pilnas.
- Kiekvienas bandymas įrašomas į `screening_requests` su savo šaltiniu (`OPENSANCTIONS`, `BRAVE`, `GDELT`): užklausos adresas (be rakto), atsakymas, HTTP kodas, SHA-256, trukmė.
- GDELT klaidas grąžina tekstu, ne JSON. Tokia klaida patikrą paverčia `FAILED`, o tekstas išsaugomas kaip įrodymas.

## Įjungimas

1. Klientas užsiregistruoja [brave.com/search/api](https://brave.com/search/api/) ir perduoda raktą.
2. Raktas įdedamas į Secret Manager: `printf %s "<raktas>" | gcloud secrets versions add skydra-demo-brave-api-key --data-file=- --project melodic-casing-501208-a3`.
3. Terraform (`demo.tfvars` arba `demo-runapp.tfvars`): `integrations.screening = "OPENSANCTIONS"` ir `adverse_media = { brave = true, gdelt = false }`. GDELT įjungiamas `gdelt = true` tik po DPIA. Tada `infra/scripts/deploy.sh demo …`.

## Patikrinti su tikru raktu

- Brave atsakymo laukai (`results[]` naujienoms, `web.results[]` internetui, `title`, `url`, `description`, `page_age`, `meta_url.hostname`): ar sutampa su tuo, ką skaito adapteris.
- Ar Brave palaiko `OR` ir kabutes taip, kaip tikimasi; kiek rezultatų lieka po atrankos pagal pavardę.
- Kiek kainuoja vienas asmuo: 3 Brave užklausos.
- GDELT: ar užklausa su lietuviškomis raidėmis ir ilgu `OR` sąrašu priimama (GDELT atmeta per trumpas frazes ir kai kurias konstrukcijas).
- Žinomas asmuo su neigiamomis naujienomis ir išgalvotas asmuo be jų.

## Atviri klausimai (klientui)

- Brave sąlygos: ar paieškos rezultatus (pavadinimą, ištrauką, nuorodą) galima saugoti kaip įrodymą 8 metus.
- DPIA Brave ir GDELT naudojimui. Kol jos nėra, GDELT išjungtas.
- Ar 25 straipsnių riba ir rizikos žodžių sąrašas tinka. Abu lengva pakeisti.
