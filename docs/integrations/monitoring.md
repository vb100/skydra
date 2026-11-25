# Tęstinė stebėsena – pakartotinės patikros

*Įdiegta 2026-11-25 pagal kliento atsakymus į klausimus Nr. 33 (automatinė tęstinė stebėsena) ir Nr. 40 (peržiūrų intervalai). Šaltinis: `docs/SkyDra_klausimai_klientui_atsakymai.docx`.*

## Kas tikrinama ir kada

Stebėsenos užduotis iš naujo patikrina **atvirų bylų** šalis tuo pačiu tiekėju kaip įprasta patikra (OpenSanctions, Brave, GDELT arba imitacija). Šalis patikrinama, kai jos paskutinė patikra senesnė nei `MONITORING_INTERVAL_DAYS` dienų (numatytoji reikšmė – 7).

- **Atvira byla:** AML taikomas, o sandoris dar nebaigtas ir nenutrauktas (etapas ne `COMPLETED` ir ne `TERMINATED`). Užbaigtų sandorių šalys nebetikrinamos.
- **Tikrinamos visos aktyvios šalys:** pirkėjai, pardavėjai, naudos gavėjai ir vadovai.
- **Neperžiūrėtas atitikmuo stabdo stebėseną.** Jei šalies paskutinėje patikroje yra dar neįvertintas stiprus atitikmuo, šalis iš naujo netikrinama, kol brokeris jo neįvertins. Kitaip užduotis galėtų „išnykti“, jei kitas tiekėjo atsakymas to įrašo atsitiktinai nebeturėtų.
- **Eilės tvarka:** pirmiausia tikrinamos šalys, kurių patikra seniausia. Vienas paleidimas apima iki `MONITORING_BATCH` šalių (numatytoji reikšmė – 200), likusios patikrinamos kitą dieną.
- **Kieno vardu:** patikra atliekama atsakingo brokerio vardu. Jei brokeris nebėra aktyvus narys, ją atlieka narys, matantis visas bylas (vadovas). Užduotis veikia per tą pačią eilučių lygio apsaugą (RLS) kaip ir brokerio užklausos. Organizacijų ribų ji neperžengia: iš duomenų bazės gauna tik narių sąrašą (`app.monitoring_actors`).
- **Žymėjimas:** patikroje įrašoma, kas ją pradėjo: `MANUAL` (brokeris), `AUTOMATIC` (prie bylos pridėta šalis) arba `MONITORING` (stebėsena). Žyma rodoma bylos ekrane, PDF ataskaitoje ir veiksmų istorijoje.

## Kas nutinka po patikros

| Rezultatas | Pasekmė |
|---|---|
| Tas pats įrašas, kuris jau įvertintas (tas pats tiekėjo ID arba straipsnio adresas, tos pačios kategorijos) | Ankstesnis sprendimas **perkeliamas** su nuoroda į pradinį sprendimą. Jo autorius ir data išlieka. Brokerio iš naujo neklausiama, rizikos vertinti nereikia |
| Tas pats įrašas, bet pasikeitė kategorijos (pvz., PEP tapo sankcijomis) | Laikomas nauju radiniu ir turi būti įvertintas |
| **Naujas stiprus atitikmuo** | Byla grįžta į „Reikia peržiūros“, o rizika turi būti įvertinta iš naujo. Brokerio „Darbų“ puslapyje atsiranda skiltis „Stebėsena rado naujų galimų sutapimų“, bylos ekrane – žyma „Nauja“ |
| Patvirtintas atitikmuo (`TRUE_POSITIVE`) vėlesnėje patikroje nebėra (pvz., asmuo išbrauktas iš sąrašo) | Patvirtinimas **galioja toliau**: sankcijos vis dar stabdo bylą, PEP vis dar reikalauja patvirtinimo. Bylos ekrane rodomas skyrius „Patvirtinta ankstesnėje patikroje“. Sistema pati sprendimo neatšaukia (žr. „Atviri klausimai“) |
| Tiekėjas nepasiekiamas | Patikra įrašoma kaip `FAILED`, ankstesnis rezultatas lieka. Kitą dieną bandoma vėl |

Tai atitinka kliento reikalavimą: pokytis turi sukurti peržiūros užduotį, o ne pats pakeisti brokerio sprendimą.

Periodinė peržiūra lieka atskira: `next_review_on` apskaičiuojama pagal rizikos lygį (5 / 3 / 1 metai), o artėjančios peržiūros rodomos „Darbų“ puslapyje ir suvestinėje.

## Kaštų apžvalga

Platformos administratoriaus puslapyje rodoma lentelė „Patikros ir tiekėjų užklausos“: kiekvieno mėnesio ir organizacijos užbaigtos patikros (iš jų stebėsenos ir nepavykusios) bei atsakytos tiekėjų užklausos (HTTP 200 – tik už jas tiekėjai ima mokestį). Lentelėje taip pat apskaičiuojama apytikslė OpenSanctions kaina (0,10 € už užklausą, neįskaičiuojant nemokamų kreditų). Brave kaina priklauso nuo plano, todėl rodomas tik užklausų skaičius.

Skaitliukus pildo duomenų bazės trigeriai (`screening_usage`). Platformos administratorius gauna tik sumas, ne organizacijų duomenis.

**Orientacinis skaičiavimas:** viena šalis per mėnesį su numatytuoju 7 d. intervalu – apie 4 patikros: 4 OpenSanctions užklausos (≈ 0,40 €) ir, jei Brave įjungtas, 12 Brave užklausų. 100 šalių atvirose bylose – apie 400 OpenSanctions ir 1 200 Brave užklausų per mėnesį.

## Paleidimas

- **Lokaliai:** `pnpm --filter @skydra/api monitor`. Naudoja `apps/api/.env`, jungiasi programos rolės teisėmis (`DATABASE_URL`).
- **GCP:** Cloud Run job `skydra-<env>-monitor` (`node dist/screening/monitor.js`). Jis veikia su programos paslaugos paskyra ir tais pačiais tiekėjų raktais. Rankinis paleidimas: `gcloud run jobs execute skydra-demo-monitor --project melodic-casing-501208-a3 --region europe-north1 --wait`.
- **Kasdienis paleidimas (Cloud Scheduler)** pagal nutylėjimą išjungtas. Jam įjungti reikia:
  1. Įjungti `cloudscheduler.googleapis.com` API (`infra/terraform/shared` jau turi jį sąraše; reikia `apply` su teise įjungti API).
  2. Suteikti teisę kurti Scheduler darbus ir paslaugų paskyras (`roles/cloudscheduler.admin`). Tai turi padaryti vartotojas.
  3. Faile `demo-runapp.tfvars` nustatyti `monitoring = { schedule = "0 6 * * *" }` (kasdien 06:00 Vilniaus laiku). Jei Cloud Scheduler `europe-north1` regione nepasiekiamas, nurodyti `scheduler_region = "europe-west1"`. Scheduler saugo tik paleidimo nustatymą, ne asmens duomenis.
- **Rezultatas** rašomas į žurnalą viena JSON eilute: `due`, `screened`, `failed`, `newMatches`, `skipped`, `errors`. Jei kyla netikėtų klaidų, užduotis baigiasi kodu 1.

## Atviri klausimai (klientui)

- **Patvirtinimo atšaukimas.** Ką daryti, kai patvirtintas sankcijų ar PEP atitikmuo vėlesnėje patikroje dingsta? Šiuo metu patvirtinimas galioja, kol nebus nustatyta atšaukimo tvarka (pvz., AML atsakingo asmens sprendimas su pagrindimu ir keturių akių principu).
- **Dažnis.** Ar tinka 7 d. visoms atviroms byloms, ar dažnį sieti su rizika (pvz., aukšta – kasdien)? Dažnis keičiamas vienu nustatymu.
- **Apimtis.** Ar stebėti ir užbaigtų sandorių klientus (pvz., nuomos santykius), ar tik atviras bylas?
- **Žiniasklaida.** Ar stebėsenoje ieškoti ir žiniasklaidoje (Brave, GDELT), ar tik sankcijų ir PEP sąrašuose? Šiuo metu, kaip ir pirminėje patikroje, ieškoma visur, kur įjungta.
