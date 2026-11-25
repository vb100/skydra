# Bylos dokumentai, rankinė patikra ir ZIP eksportas

*Įdiegta 2026-11-25 pagal kliento atsakymus į klausimus Nr. 11 (dokumentų ir nuotraukų įkėlimas, taip pat ir telefonu), Nr. 28 (AC4 – rankinis atsarginis patikros režimas) ir Nr. 44 (PDF ataskaita ir ZIP paketas).*

## Dokumentai

| | |
|---|---|
| Kas | tapatybės dokumentų kopijos, naudos gavėjų ir registrų dokumentai (JADIS, JANGIS išrašai), kliento dokumentai (anketa ir kt.), patikrų įrodymai, kita |
| Formatai | PDF, JPEG, PNG, WEBP, HEIC, iki 20 MB. Tipas nustatomas pagal **failo turinį**, ne pagal pavadinimą ar naršyklės nurodytą tipą. HTML, skriptai ir kiti failai atmetami |
| Kur saugoma | failas – privačiame Cloud Storage kibire `<projektas>-skydra-<env>-documents` (europe-north1); duomenų bazėje (`case_documents`) – kas tai per failas, kurios bylos ir asmens, kas ir kada jį pridėjo, SHA-256 |
| Nekintamumas | programa gali dokumentą pridėti ir skaityti, bet negali jo pakeisti ar ištrinti: tai riboja ir duomenų bazės teisės, ir kibiro IAM (`objectCreator` + `objectViewer`). Atsisiunčiant failas sutikrinamas su SHA-256 – pakeistas failas nebus atiduotas |
| Prieiga | kaip ir byla: brokeris mato savo bylų dokumentus, vadovas – visų (RLS). Kiekvienas įkėlimas ir atsisiuntimas įrašomas į veiksmų istoriją |
| Atsisiuntimas | per programą (`GET /api/cases/:id/documents/:docId/file`), su `Content-Disposition: attachment` ir `CSP: sandbox`. Viešų ar pasirašytų nuorodų nėra |

Telefonu failo pasirinkimo lange galima iš karto nufotografuoti dokumentą.

**Lokaliai** naudojamas `fake-gcs-server` (`pnpm db:up`, `STORAGE_BUCKET=skydra-local`, `STORAGE_EMULATOR_HOST=http://localhost:4443`). Emuliatorius kibirą sukuria pats, bet nepaiso draudimo perrašyti objektą (`ifGenerationMatch=0`). Tikrame Cloud Storage šis draudimas veikia.

## Rankinė patikra (atsarginis būdas)

Pagrindinis patikros būdas lieka automatinis (OpenSanctions, žiniasklaida). Rankinė patikra skirta tik tam atvejui, kai automatinė **nepasiekiama**:

- Įvesti galima tik tada, kai šalies paskutinė patikra nepavyko (`FAILED`) arba patikros iš viso nepavyko atlikti. Jei galioja užbaigta automatinė patikra, rankinė atmetama.
- Įvesti gali vadovas arba AML atsakingas asmuo; vieno asmens organizacijoje – tas asmuo.
- **Privaloma:** šaltinis (pvz., ES sankcijų žemėlapis, VTEK PEP sąrašas), paieškos data (ne ateityje), rezultatas („atitikmenų nerasta“ arba „rastas galimas atitikmuo“), pagrindimas (bent 10 simbolių) ir **įrodymas** – nuoroda į šaltinį (`https://`) arba prie bylos pridėtas dokumentas (pvz., ekrano nuotrauka ar PDF).
- Rastas galimas atitikmuo (vardas ir sąrašas) tampa įprastu stipriu atitikmeniu: jį reikia įvertinti kaip ir kitus.
- Patikra pažymima `MANUAL`: rodoma bylos ekrane, PDF ataskaitoje (šaltinis, data, rezultatas, pagrindimas, įrodymas) ir veiksmų istorijoje (`manual: true`).
- Visi reikalavimai tikrinami ir API, ir duomenų bazėje (įrodymas turi būti tos pačios bylos dokumentas).

## Eksportas

- **„Atsisiųsti ataskaitą (PDF)“** – bylos ataskaita. Joje yra skyrius „Priedai“ su visų dokumentų sąrašu (rūšis, pavadinimas, asmuo, dydis, kas ir kada pridėjo, SHA-256).
- **„Atsisiųsti visą bylą su dokumentais (ZIP)“** – `Case_<nr>.zip`:

  ```
  Case_Report.pdf
  Attachments/
    Identity/           tapatybės dokumentai
    UBO/                naudos gavėjų ir registrų dokumentai
    Client_Documents/   kliento dokumentai
    Other/              patikrų įrodymai ir kita
  ```

  ZIP yra eksporto momento kopija. Kiekvienas failas prieš įdedant sutikrinamas su SHA-256. Archyvas registruojamas su savo SHA-256 (`case_exports`, formatas `ZIP`), o veiksmų istorijoje išvardijami į jį įtraukti dokumentai. Vienu kartu – iki 300 MB dokumentų.
- Abu eksportai galimi tik užbaigtai bylai.
- Failų pavadinimai ZIP archyve yra UTF-8: lietuviškas raides teisingai rodo Windows, macOS „Archive Utility“ ir 7-Zip. Senas macOS `unzip` jų neskaito.

## Atviri klausimai

- **Saugojimo terminai.** Kiek laikyti dokumentus (pvz., 8 metai po santykių pabaigos) ir ar įjungti kibiro saugojimo politiką (retention lock). Dabar failų niekas neištrina, o kibiro versijos ir 30 d. „soft delete“ apsaugo nuo atsitiktinio pašalinimo.
- **OCR.** Klientas nori, kad JADIS / JANGIS išrašai būtų atpažįstami automatiškai (atsakymas į klausimą Nr. 32). Tai atskiras etapas: dokumentų saugykla jam jau paruošta.
- **Antivirusinė patikra.** Dabar priimami tik PDF ir nuotraukos (pagal turinį), o atsisiunčiami failai pateikiami izoliuotai. Jei reikės, galima pridėti failų skenavimą.
