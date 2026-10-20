# SkyDra – klausimai prieš pradedant programavimo darbus

*Versija 2. Atnaujinta 2026-10-19, peržiūrėjus verslo planą (PDF, parengtas 2026-07-15) ir du demonstracinius vaizdo įrašus.*

Kad galėtume pradėti kurti MVP ir jį diegti Google Cloud aplinkoje, prašome atsakyti į toliau pateiktus klausimus.

**Kaip atsakyti.** Klausimai, pažymėti **[!]**, mums būtini prieš pradedant darbus. Kitus galima patikslinti per pirmąsias kelias savaites. Prie daugelio klausimų nurodėme, ką siūlome, jei konkrečios nuomonės neturite. Tokiu atveju užtenka atsakyti „sutinku“. Klausimai, prasidedantys žodžiu **„Patvirtinkite“**, remiasi tuo, ką matėme demonstraciniuose įrašuose. Jei supratome teisingai, užtenka atsakyti „taip“.

---

## Jau sutarta

- **Domenas:** skydra.eu (jau turimas). Hostinger DNS nustatymus administruoja kūrėjas.
- **Google Cloud:** paskyra bendra (kūrėjo ir kliento vardu). Klientas suteikė reikiamas teises ir roles.
- **Kodas:** kuriamas visiškai iš naujo. Esamas prototipas ir demonstraciniai įrašai naudojami tik kaip funkcionalumo ir ekranų logikos pavyzdys, prototipo kodas neperimamas. Kodas saugomas privačioje GitHub repozitorijoje, kurią valdo kūrėjas.
- **El. pašto pranešimai:** ateityje bus, bet MVP jų neįgyvendiname. Užduotys ir tvirtinimai bus matomi pačioje sistemoje.
- **Biudžetas:** tikslinamas darbų eigoje.
- **Naudojimo regionas:** Baltijos šalys (Lietuva, Latvija, Estija).
- **Kalba:** MVP sąsaja ir bylos lietuvių kalba. Sistema iš karto kuriama daugiakalbė, kad vėliau būtų galima pridėti kitų kalbų neperrašant kodo.
- **Atsakingi asmenys:** užsakovas turi produkto sprendimų priėmėjus ir AML teisinį konsultantą. Kontaktai bus pateikti vėliau.

## Ką supratome iš demonstracinių įrašų

Jei kas nors iš šio sąrašo neatitinka jūsų lūkesčių, prašome pataisyti. Kitaip laikysime tai MVP pagrindu.

- Byla pildoma žingsnis po žingsnio: privačiam klientui 7 žingsniai (Sandoris → Klientas → Dokumentai → Patikros → Vertinimas → Sprendimas → Byla), verslo klientui 8 (papildomai UBO).
- Bylos tipą lemia brokerio kliento tipas (privatus / verslo). Bylos numeruojamos AML-P001 ir AML-J001 formatu.
- Tikrinamos **abi sandorio šalys** (pirkėjas ir pardavėjas). Tas pats asmuo gali būti susietas su keliomis bylomis (pvz., pardavėja Ieva naudojama ir antroje byloje).
- Tapatybę patikrina pats brokeris, palygindamas dokumentą su asmeniu. Šis patvirtinimas registruojamas atskirai nuo dokumento įkėlimo.
- Kliento anketa įkeliama kaip dokumentas (PDF). Klientas sistemoje nesilanko.
- Nuosavybės grandinė rodoma schema, netiesioginė dalis apskaičiuojama automatiškai (60 % × 100 %). Neišspręstas UBO šaltinių neatitikimas **blokuoja** bylos užbaigimą, ir vieno komentaro tam nepakanka.
- Patvirtinus PEP statusą, sistema automatiškai sukuria sustiprinto patikrinimo užduotis (lėšų ir turto šaltinis, galutinis rizikos vertinimas) ir vadovybės pritarimo užduotį. Vadovė jas mato savo paskyroje.
- Rizika vertinama pagal veiksnius (PEP, sankcijos, nuosavybė / klientas, geografija ir veikla, mokėjimas / finansavimas). Rodoma preliminari ir galutinė rizika bei metodikos versija (DEMO-RISK-01).
- Sprendime atskirai fiksuojamas įtarimo požymių vertinimas ir kitos peržiūros data.
- PDF byla peržiūrima sistemoje. Jai apskaičiuojama SHA-256 maiša, o eksportas įrašomas į veiksmų istoriją.

---

## A. Trūkstama medžiaga

1. **[!]** Dokumente minimi skyriai, kurių gautame PDF nėra: **12.1 „Duomenų tiekėjai“** (biudžeto eilutė), **17 skyrius su technologijų lentele** ir **18.1–18.6** (dabar jie, atrodo, pažymėti 6.1–6.6). Gal galite atsiųsti pilną versiją?
2. **[!]** Prototipe yra kortelė „Reguliaciniai reikalavimai (PPTFPĮ)“, kuri seka **7 reikalavimus „iš 3 skyriaus“**. Dabartiniame dokumente 3 skyrius skirtas tiksliniams klientams, o įrašuose tokios kortelės nematėme. Prašome atsiųsti tikslų šių 7 reikalavimų sąrašą ir kiekvieno įvykdymo sąlygą.
3. **[!]** Komentare EB2 parašyta: *„patys skanuojame oficialius sankcijų sąrašus, leidžiame rankiniu būdu įkelti JADIS/JANGIS išrašus, o PEP rezultatą įvesti ir pagrįsti oficialiu šaltiniu“*. Ar tai galutinis sprendimas dėl MVP? Įrašuose matyti „DEMO tiekėjas“, todėl norime įsitikinti.

## B. MVP apimtis ir terminai

4. **[!]** Kada planuojate pilotą? Kiek bus pilotinių klientų (solo brokerių / agentūrų) ir kiek naudotojų iš viso?
5. **[!]** **Baltijos šalys.** Ar pilotas ir MVP skirti tik Lietuvos brokeriams, o Latvija ir Estija bus vėliau? Kada planuojate šias rinkas? Iki 2027-07-10 kiekvienoje šalyje galioja savi nacionaliniai AML įstatymai, o įmonių ir UBO registrai skiriasi (Lietuvoje JAR, JADIS, JANGIS; Latvijoje Uzņēmumu reģistrs; Estijoje e-äriregister). *Siūlome* MVP teisinę logiką ir registrus kurti Lietuvai, o duomenų modelį iš karto pritaikyti kelioms šalims: asmens kodų formatams, šalies taisyklėms ir registrams.
6. **[!]** Ar MVP priėmimo kriterijumi galime laikyti tai, kad abu demonstracinių įrašų scenarijai (privatus klientas su galimu sankcijų sutapimu ir verslo klientas su UBO neatitikimu bei PEP) veiktų su tikrais duomenimis, išsaugota informacija ir prisijungusiais naudotojais?
7. **[!]** Įrašuose nematėme kelių PDF aprašytų ekranų: **nuomos sandorio**, **atstovo / įgaliotinio**, **vidinio įtarimo eskalavimo**, **sprendimo atsisakyti / nutraukti santykius**, **„Klientai“ ir „Peržiūros“ meniu** bei **rizikos taisyklių nustatymų**. Kurie iš jų būtini MVP? *Siūlome* į MVP įtraukti nuomą, atstovą, atsisakymą / nutraukimą ir paprastą „Klientų“ sąrašą. Eskalavimą, peržiūrų ekraną ir taisyklių redagavimą sąsajoje siūlome įgyvendinti antrame etape.
8. **Patvirtinkite:** kliento portalo ar saugios anketos MVP nėra. Duomenis suveda brokeris, o kliento anketa įkeliama kaip failas. Ar turite anketos šabloną, kurį sistema galėtų pateikti atsisiuntimui?
9. Ar MVP jau turi būti Solo / Business / Enterprise **planai ir mokėjimai**? *Siūlome* pilote planų ir mokėjimų nediegti: organizacijas sukurtume ir sąskaitas išrašytume rankiniu būdu.
10. Kadangi sistema skirta Baltijos šalims, kokia tvarka planuojate įtraukti kitas kalbas (LV, EE, EN)? Ar eksportuojamos bylos anglų kalba (prototipe yra kalbos pasirinkimas LT / EN) reikia jau MVP, ar ją įgyvendiname kartu su kitomis kalbomis vėliau?
11. Ar svarbus darbas telefonu ar planšete? *Siūlome* kurti kompiuteriui, o mobiliuosiuose įrenginiuose užtikrinti tik peržiūrą.

## C. Naudotojai, organizacijos ir prieigos

12. **[!]** Kaip naudotojai jungsis? Galimi variantai: el. paštas + slaptažodis, Google / Microsoft paskyra, Smart-ID. Ar privalomas dviejų veiksnių autentifikavimas? *Siūlome:* el. paštas + slaptažodis su privalomu 2FA (autentifikavimo programėle), Google / Microsoft prisijungimas kaip papildomas būdas. *Pastaba:* kol el. laiškų nesiunčiame, slaptažodžio atkūrimas ir naudotojų pakvietimai vyks per administratorių. Ar sutinkate, ar šiai daliai el. laiškus vis dėlto įjungiame?
13. **[!]** Ar vienas naudotojas gali priklausyti kelioms organizacijoms? Ar solo brokeris yra vieno žmogaus organizacija?
14. **[!]** Įraše matėme roles „Brokerė“ ir „Vadovė“: vadovė tvirtina PEP atvejį per užduotį, kurią mato savo paskyroje. PDF dar minimi **Admin** ir **AML/CFT atsakingas asmuo**. Ar AML atsakingas asmuo yra atskira rolė, ar papildoma teisė, kurią galima suteikti vadovui? **Kas tvirtina PEP atvejį, kai brokeris dirba vienas?** Ar brokeris gali tvirtinti savo paties bylą?
15. Ar „Admin“ yra **SkyDra platformos administratorius** (jūsų komanda), ar **agentūros administratorius**? Siūlome šias dvi roles atskirti.
16. Ar agentūros brokeris mato kolegų bylas, ar tik savo? Vadovas, suprantama, mato visas.
17. Kaip atsiras nauji klientai: ar agentūra pati užsiregistruos, ar organizacijas kursite jūs? *Siūlome* pilote organizacijas kurti rankiniu būdu.
18. Ar SkyDra komanda (palaikymas) gali matyti klientų bylų turinį? Jei ne, palaikymas galės dirbti tik su techniniais duomenimis. Tai svarbu ir BDAR sutartims.

## D. Sandorio bylos logika

19. **Patvirtinkite:** sandorio tipas (pirkimas–pardavimas / nuoma) ir objekto paskirtis (gyvenamasis būstas, biuras ir kt.) yra atskiri laukai, kaip įraše. Prašome atsiųsti pilną objekto paskirčių ir mokėjimo būdų sąrašą.
20. **[!]** Bylos tipas pasirenkamas pagal brokerio klientą (privatus / verslo), bet byloje gali būti ir kitokio tipo šalių. Pavyzdžiui, verslo byloje pardavėja buvo privatus asmuo. Kaip elgtis, kai **abi šalys yra įmonės**, kai **pirkėjų keli** (sutuoktiniai, bendraturčiai) arba kai **vienoje pusėje yra ir asmuo, ir įmonė**? *Siūlome* vieną bylą su neribotu šalių skaičiumi. Kiekvienai šaliai tikrinimo eiga būtų parenkama pagal jos tipą.
21. **[!]** **Patvirtinkite:** patikrinimai (CDD) atliekami visoms sandorio šalims, ne tik brokerio klientui. Kaip elgtis, kai kitą šalį atstovauja kitas brokeris? Ar tuomet jai pakanka sankcijų patikros?
22. **[!]** **Sandorio stadijos** skiriasi. PDF nurodyta: „Pradinis kontaktas / Rezervacija / Sutartis / Užbaigta“, o įraše matėme „Iki dalykinių santykių pradžios“. Prašome pateikti galutinį stadijų sąrašą. Ar sistema turi *blokuoti* perėjimą į kitą stadiją, kol neatlikti privalomi patikrinimai, ar tik įspėti? Kokiomis sąlygomis leidžiama tapatybės patikrinimą užbaigti vėliau?
23. Kai nuomos mokestis mažesnis nei 10 000 EUR/mėn., ar bylą vis tiek galima sukurti (pažymėtą „AML netaikomas“), ar sistema jos kurti neleidžia?
24. Kai jau patikrintas asmuo susiejamas su nauja byla (įraše: „aktualumas ir pokyčiai peržiūrėti“), kiek laiko jo tapatybės patikrinimas ir PEP / sankcijų patikros laikomi galiojančiais? Ar naujoje byloje jas reikia kartoti?
25. **[!]** Kokie galimi **sprendimai**? Įraše matėme „Pradėti dalykinius santykius“ ir „Pradėti santykius su stebėsena“, PDF minimi dar „prašyti papildomos informacijos“, „eskaluoti“, „atsisakyti“ ir „nutraukti“. Prašome patvirtinti galutinį sąrašą.
26. Ar užbaigtą bylą galima atidaryti iš naujo, pvz., kai sandoris užsitęsia arba pasikeičia šalys?

## E. Patikros: sankcijos, PEP, tapatybė, UBO

27. **[!]** **Sankcijos.** Kurie sąrašai privalomi MVP? Siūlome: ES konsoliduotas finansinių sankcijų sąrašas, JT Saugumo Tarybos sąrašas ir Lietuvos institucijų skelbiama informacija. Ar reikia ir JAV OFAC bei JK OFSI sąrašų? Kai sistema bus naudojama Latvijoje ir Estijoje, ar reikės ir šių šalių nacionalinių sankcijų sąrašų (pvz., Latvija turi savo nacionalinį sąrašą)? *Siūlome* sąrašus atnaujinti kasdien.
28. **[!]** **PEP.** Įraše PEP įrašą pateikia „DEMO tiekėjas“. Ar MVP pakanka, kad brokeris PEP rezultatą įveda pats ir prisega oficialų šaltinį (pvz., PDF)? Ar planuojate komercinį tiekėją? Jei taip, kurį ir kas pasirašys sutartį?
29. **Patvirtinkite:** MVP tapatybę patikrina brokeris, palygindamas įkeltą dokumentą su asmeniu. Ar reikia ir nuotolinio tapatybės nustatymo tiekėjo (pvz., Smart-ID, Veriff, iDenfy, Ondato) klientams, kurių brokeris gyvai nesutinka? *Siūlome* nuotolinį nustatymą įgyvendinti antrame etape.
30. **[!]** **Nuosavybės grandinė.** Patvirtinkite: grandinę (dalyvius, jų dalis, lygius) brokeris suveda ranka pagal išrašus, o sistema nubraižo schemą ir apskaičiuoja netiesiogines dalis. Kiek lygių turi būti palaikoma? Ar pilote tikitės užsienio įmonių?
31. **UBO neatitikimas registrui.** Eksportuotoje byloje parašyta: „registro neatitikimo pranešimo klausimas perduotas atskiram atsakingo asmens vertinimui“. Ar MVP pakanka šį klausimą pažymėti ir užregistruoti, ar reikia rengti pranešimą JANGIS tvarkytojui?
32. Ar MVP reikia OCR, kad laukai iš dokumentų būtų užpildomi automatiškai? *Siūlome* OCR atidėti.
33. **Tęstinė stebėsena.** Ar esamus klientus reikia automatiškai pakartotinai tikrinti, kai atnaujinami sankcijų sąrašai? Ar pakanka rodyti artėjančias peržiūras sistemoje?
34. Įraše galimas sutapimas rodomas su 82 % panašumu. Nuo kokio panašumo rezultatas turi būti laikomas „galimu sutapimu“? Ar organizacija galės šią ribą keisti pati?

## F. Rizikos vertinimas ir tvirtinimas

35. **[!]** **Rizikos modelis.** PDF ekrano nuotraukose rizika skaičiuojama **balais** (+50 sankcijos, +25 UBO, iš viso 75), o įraše – **pagal veiksnių lygius** (žema / aukšta / įvertinta) be balų. Kurį modelį renkamės?
36. **[!]** Kas pateiks pradinį **rizikos taisyklių rinkinį** (veiksniai, jų lygiai arba balai, slenksčiai)? Ar pilote naudojame prototipo taisykles, aiškiai pažymėtas kaip demonstracinės?
37. Ar rizikos taisyklės bendros visiems klientams (tvarko SkyDra), ar kiekviena agentūra jas konfigūruoja pati?
38. Kiek rizikos lygių naudojame? Įraše matėme „žema“ ir „aukšta“. Ar yra ir „vidutinė“ bei „nepriimtina“?
39. **[!]** **Tvirtinimo matrica.** Kokiais atvejais reikalingas vadovo patvirtinimas: tik PEP, ar ir aukšta rizika, nenustatytas UBO ir pan.? Ar ši matrica konfigūruojama kiekvienai organizacijai?
40. **Kitos peržiūros data.** Įraše aukštos rizikos klientui kita peržiūra nustatyta po 6 mėn. Prašome pateikti peržiūros intervalus kiekvienam rizikos lygiui (iki 5 metų). Ar brokeris gali datą pakeisti?
41. **Patvirtinkite:** pakeitus rizikos metodiką, jau užbaigtose bylose lieka ankstesnės versijos rezultatas (įraše rodoma versija DEMO-RISK-01).

## G. AML bylos eksportas

42. **[!]** Ar MVP reikalingi abu formatai, PDF ir Word, ar pakanka PDF? *Siūlome* MVP tik PDF.
43. Ar eksporte turi būti agentūros logotipas ir rekvizitai? Kaip pasirašoma: spausdinamas parašo laukas ar elektroninis parašas (pvz., Dokobit)?
44. Ar eksportuojamoje byloje turi būti ir patys pridėti dokumentai (pvz., ZIP archyvas), ar tik jų sąrašas, kaip įraše?

## H. Duomenų apsauga ir saugojimas

45. **[!]** Kas parengs **duomenų saugojimo grafiką** (terminai pagal kategorijas, termino pradžios momentas, teisinis pagrindas)? Kol jo nėra, siūlome nieko automatiškai netrinti. Ar sutinkate?
46. **[!]** BDAR vaidmenys: ar sutinkate, kad agentūra / brokeris yra **duomenų valdytojas**, o SkyDra – **duomenų tvarkytojas**? Kas parengs duomenų tvarkymo sutartį (DPA), naudojimosi sąlygas ir privatumo politiką?
47. **[!]** Ar duomenys turi būti saugomi tik ES? Google Cloud duomenų centro Baltijos šalyse nėra. *Siūlome* artimiausią ES regioną Suomijoje (europe-north1), atsarginės kopijos būtų saugomos taip pat ES. Ar Latvijos ar Estijos klientai gali turėti papildomų reikalavimų duomenų vietai?
48. Ar pilotiniai klientai tikisi saugumo įrodymų: ISO 27001, įsiskverbimo testo (pentest) ataskaitos, saugumo klausimyno?
49. Ar reikia atskiros **demonstracinės aplinkos** su fiktyviais duomenimis (kaip įrašuose) pardavimams ir investuotojams?

## I. Google Cloud, domenas ir palaikymas

50. **[!]** Dabartinis skydra.eu puslapis („kuriamas“) talpinamas Hostinger. Siūlome sistemą talpinti adresu **app.skydra.eu**, o pagrindinį puslapį palikti Hostinger. Ar sutinkate?
51. **[!]** Kieno mokėjimo kortelė ar sąskaita bus susieta su Google Cloud (billing)? Ar reikalinga Google Cloud organizacija jūsų įmonės vardu?
52. Kokio prieinamumo tikitės (pvz., 99,5 %)? Kokiomis valandomis turi veikti palaikymas? Koks priimtinas duomenų praradimo ir atstatymo laikas po incidento?
53. Kam priklauso kodo intelektinė nuosavybė ir kokiomis sąlygomis ji perduodama (repozitoriją valdo kūrėjas)?

## J. Dizainas

54. skydra.eu puslapyje yra SkyDra logotipas, kuriame vyrauja mėlyna spalva. Demonstraciniame prototipe naudojama tamsiai žalsvai mėlyna (teal). Kurį vizualinį stilių renkamės? Ar turite logotipo failus (SVG) ir prekės ženklo gaires, ar dirba dizaineris?
