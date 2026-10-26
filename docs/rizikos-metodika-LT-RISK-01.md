# LT-RISK-01: rizikos vertinimo metodika

*Dabartinė versija: **DEMO-1** (2026-10-26). Tai laikina, programuotojo parengta lentelė, skirta prototipui. Jos nėra patvirtinęs AML konsultantas.*

Šiuo dokumentu prašome AML konsultanto pateikti tikrąją lentelę. Pakeisime tik duomenis, programos kodas nesikeis.

## Kaip veikia vertinimas

1. Sistema iš bylos duomenų surenka **faktus**: patikrų rezultatus, KYC atsakymus, šalis, atsiskaitymo būdą ir sandorio vertę.
2. Kiekvienas **veiksnys** yra sąlyga, taikoma vienam faktui. Jei sąlyga tenkinama, veiksnys suteikia lygį: **žema**, **vidutinė** arba **didelė** rizika. Balai nenaudojami.
3. **Bendras lygis** lygus didžiausiam suveikusio veiksnio lygiui. Jei suveikia **3 ar daugiau vidutinių** veiksnių, rizika tampa didelė.
4. **Privalomas** veiksnys nustato minimumą, žemiau kurio rizikos sumažinti negali niekas.
5. **Galutinis lygis:**
   - Brokeris gali jį padidinti, nurodęs pagrindimą.
   - Sumažinti gali tik tvirtintojas, kuris nėra atsakingas brokeris.
6. **Didelei rizikai** reikia sustiprinto tikrinimo ir kito asmens (tvirtintojo) patvirtinimo.
7. **Kita peržiūra:** žema rizika – po 5 m., vidutinė – po 3 m., didelė – po 1 m.

## DEMO-1 veiksniai

| Kodas | Grupė | Sąlyga | Lygis | Privalomas |
|---|---|---|---|---|
| PEP | PEP | patvirtintas PEP ar artimo asmens sutapimas, arba klientas pats deklaravo PEP statusą | didelė | taip |
| SANCTIONS | Sankcijos | patvirtintas sankcijų sutapimas | didelė | taip |
| ADVERSE_MEDIA | Sankcijos / neigiama informacija | patvirtinta neigiama informacija | didelė | |
| NOT_OWN_BEHALF | Klientas | klientas veikia ne savo vardu | didelė | |
| LEGAL_ENTITY | Klientas | mūsų klientas – juridinis asmuo | vidutinė | |
| REPRESENTATIVE | Klientas | sandoryje dalyvauja atstovas | vidutinė | |
| REMOTE_IDENTIFICATION | Klientas | tapatybė nustatyta tik nuotoliu | vidutinė | |
| HIGH_RISK_COUNTRY | Geografija | pilietybė, gyvenamoji ar registracijos šalis yra didelės rizikos trečiųjų šalių sąraše | didelė | taip |
| NON_EEA_COUNTRY | Geografija | ryšys su šalimi už EEE ribų | vidutinė | |
| CASH | Mokėjimas | atsiskaitymas grynaisiais | didelė | |
| MIXED_PAYMENT | Mokėjimas | mišrus atsiskaitymas | vidutinė | |
| THIRD_PARTY_PAYER | Mokėjimas | moka trečiasis asmuo | vidutinė | |
| HIGH_VALUE | Mokėjimas | sandorio vertė ≥ 1 000 000 EUR (nuomai – metinė suma) | vidutinė | |
| SOURCE_OF_FUNDS_MISSING | Mokėjimas | mūsų klientui nenurodyta lėšų kilmė | vidutinė | |

**Didelės rizikos trečiųjų šalių sąrašas (DEMO):** AF, BF, CD, CM, DZ, HT, IR, KP, LB, ML, MM, MZ, NG, SS, SY, TZ, VE, VN, YE, ZA. Prašome patvirtinti galiojantį ES sąrašą ir nurodyti, kaip dažnai jį atnaujinti.

## Ko prašome iš AML konsultanto

1. Patvirtinti, papildyti arba pakeisti veiksnius, jų lygius ir požymį „privalomas“.
2. Nurodyti, kiek vidutinių veiksnių kartu daro riziką didele, arba patvirtinti, kad tokios taisyklės nereikia.
3. Patvirtinti peržiūros intervalus.
4. Patvirtinti didelės rizikos šalių sąrašą ir jo šaltinį.
5. Jei reikia veiksnių, kurių sistema dar nerenka (pvz., įmonės veiklos sritis ar nuosavybės struktūros sudėtingumas), juos aprašyti. Juos pridėsime kaip naujus faktus.
