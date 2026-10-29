# Registrų duomenys ir naudos gavėjai (UBO)

*Būsena 2026-10-29: prototipe registrų duomenys yra **sintetiniai**, o eiga veikia iki galo. Laukiame Ondato sutarties, sandbox prieigos ir užpildytų JADIS / JANGIS išrašų pavyzdžių.*

## Kaip veikia prototipe

1. Brokeris prie bylos prideda juridinį asmenį ir įveda jo kodą.
2. Mygtuku „Gauti registrų duomenis“ sistema gauna:
   - iš **JAR**: pavadinimą, teisinę formą, adresą ir vadovą;
   - iš **JADIS**: akcininkus ir jų dalis;
   - iš **JANGIS**: deklaruotus naudos gavėjus.
   Jei akcininkas yra kita įmonė, sistema gauna ir jos duomenis.
3. Sistema apskaičiuoja **netiesiogines dalis** (pvz., 60 % × 100 % = 60 %) ir nustato naudos gavėjus, turinčius **daugiau kaip 25 %**. Jei tokių nėra, naudos gavėju laikomas **vadovas**.
4. Rezultatas palyginamas su JANGIS duomenimis. Jei jie **nesutampa** arba grandinės nepavyksta atsekti iki fizinių asmenų (pvz., savininkas registruotas už ES ribų), bylos užbaigti negalima, kol brokeris užfiksuoja:
   - kaip neatitikimas išspręstas (patikslinta su klientu, priimti kliento dokumentai arba pranešta JANGIS tvarkytojui);
   - pagrindimą;
   - įrodymą.
5. Visi nustatyti naudos gavėjai tampa bylos šalimis: jiems atliekama sankcijų ir PEP patikra, o jų duomenys vertinami rizikos metodikoje.

## Bandomieji įmonių kodai (demo)

| Kodas | Scenarijus |
|---|---|
| 300000001 | vienas savininkas, duomenys sutampa |
| 300000002 | savininkas per holdingo įmonę (netiesioginė dalis 60 %) |
| 300000003 | vienas iš dviejų 50 % savininkų nedeklaruotas JANGIS |
| 300000004 | 80 % valdo įmonė už ES ribų – grandinė neatsekama |

## Ko prašome iš kliento

1. **Ondato:** ar per Ondato API gausime JAR, JADIS ir JANGIS duomenis, kokiu formatu ir už kokią kainą vienai užklausai.
2. **Išrašų pavyzdžiai:** užpildyti JADIS ir JANGIS išrašų pavyzdžiai su nuasmenintais duomenimis, kad galėtume patikrinti duomenų struktūrą.
3. **Užsienio įmonės:** ar MVP užsienio savininkų duomenys gaunami per Ondato KYB, ar brokeris juos įveda ir įkelia dokumentus rankiniu būdu.
4. **Riba ir kontrolė:** patvirtinkite 25 % ribą. Ar reikia papildomų kontrolės požymių (balsavimo teisės, susitarimai, nominalūs savininkai)?
5. **Neatitikimo sprendimas:** ar pakanka trijų sprendimo būdų, ar „pranešta JANGIS tvarkytojui“ atveju reikia ir tvirtintojo patvirtinimo.
