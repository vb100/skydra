# SkyDra svetainė (skydra.eu)

Statinė rinkodaros svetainė. Ją rodo nginx Cloud Run paslaugoje `skydra-landing` („ESV project“, europe-north1).

| Puslapis             | Paskirtis                                                                             |
| -------------------- | ------------------------------------------------------------------------------------- |
| `index.html`         | pagrindinis puslapis (`/`)                                                            |
| `aciu.html`          | padėka po formos išsiuntimo (formsubmit.co nukreipia į `https://skydra.eu/aciu.html`) |
| `registracija.html`  | registracija („Registruotis dabar“, „Pradėti“)                                        |
| `vertinimas.html`    | nemokamas AML testas                                                                  |
| `prisijungimas.html` | kol kas nenaudojamas; „Prisijungti“ veda į sistemos `/login`                          |
| `privatumas.html`    | privatumo politika ir slapukai                                                        |

## Struktūra ir pakeitimai, palyginti su kliento failais

Pagrindinė versija nuo šiol yra šioje repozitorijoje. Klientas pakeitimus siunčia kaip tekstą arba užduotis, o ne kaip naujus HTML failus, kitaip būtų perrašyti toliau aprašyti pataisymai.

- **Stiliai:** `css/site.css` (`index.html`) ir `css/<puslapis>.css` (kiti puslapiai). HTML'e nėra nei `<style>`, nei `style=""`, todėl CSP draudžia bet kokius įterptus stilius ir skriptus (`style-src 'self'`, `script-src 'self'`).
- **Telefono versija:** taisyklės `@media (max-width: 760px)` ir `(max-width: 380px)`, planšetės versija `(max-width: 1023px)`. Telefone yra:
  - meniu mygtukas;
  - kainos rodomos po vieną planą su skirtukais;
  - apatinė juosta su „Nemokamas AML testas“.

  Kompiuterio versija sutampa su kliento dizainu.

- **Skriptai:**
  - `js/site.js`: kainų laikotarpis ir planas, telefono meniu, apatinė juosta;
  - `js/vertinimas.js`: AML testas.
- **Kainų lentelė** parašyta vieną kartą. Metų ir mėnesio reikšmės, kurios skiriasi, pažymėtos `<span class="annual">` ir `<span class="monthly">`.
- **Šriftai** laikomi savo serveryje (`fonts/`, SIL OFL licencija), Google Fonts nenaudojami.
- **„Prisijungti“** veda į `https://skydra-demo-915954505621.europe-north1.run.app/login`.
- **Skaičiuose** naudojami nelūžtantys tarpai (`15 000 €`), kad skaičius nebūtų perkirstas tarp eilučių.
- **Kita:** `favicon.svg`, `theme-color`.

## Privatumas, slapukai ir Google Analytics

- **Privatumo politika:** `privatumas.html`. Geltonai pažymėtas vietas (`.todo`) turi užpildyti klientas: valdytojo duomenys, saugojimo terminai, FormSubmit sąlygos. Prieš skelbiant tekstą turi peržiūrėti teisininkas.
- **Slapukų juosta:** [vanilla-cookieconsent](https://github.com/orestbida/cookieconsent) 3.3.0 (MIT), laikoma `vendor/cookieconsent/`. Nustatymai ir tekstai lietuviškai yra `js/consent.js`, išvaizda `css/consent.css`. Mygtukai „Priimti“ ir „Atmesti“ vienodo svorio. Pasirinkimas saugomas `cc_cookie` slapuke 6 mėn.
- **Google Analytics 4:** įrašomas į `js/consent.js` (`GA_MEASUREMENT_ID = 'G-…'`).
  - Kol ID tuščias, juosta nerodoma ir „Slapukų nustatymai“ nuorodos paslėptos, nes nebūtinų slapukų tada nėra.
  - `gtag.js` atsisiunčiamas tik po sutikimo su „Analitika“. Google signalai ir reklamos personalizavimas išjungti, atšaukus sutikimą `_ga*` slapukai ištrinami.
  - Juosta nerodoma robotams (`hideFromBots`), todėl automatiniuose testuose ją reikia įjungti.
- **Pakeitus kategorijas ar slapukus,** padidinkite `revision` faile `js/consent.js`, kad visi lankytojai būtų paklausti iš naujo.
- **GA4 nustatymai** (Admin → Data collection and modification → Data retention): saugojimo laikas **2 mėn.**, kaip nurodyta politikoje. Google signals išjungta.

## Serveris

`nginx/default.conf`:

- `www.skydra.eu` nukreipiamas į `skydra.eu`;
- puslapiai visada pertikrinami, o šriftai saugomi podėlyje metus;
- saugumo antraštės aprašytos `nginx/security-headers.conf` (CSP, HSTS ir kt.).

## Diegimas

```bash
infra/scripts/deploy-landing.sh
```

Skriptą reikia leisti iš švarios `main` šakos. Jis atlieka tris veiksmus:

1. sukompiliuoja ir įkelia atvaizdą `skydra-landing:<commit>`;
2. Terraform (`infra/terraform/landing`) parodo planą ir paprašo įvesti `yes`;
3. atnaujina paslaugą.

Lokali peržiūra:

```bash
docker build -t skydra-landing apps/landing
docker run --rm -p 8090:8080 skydra-landing   # http://localhost:8090
```

## Domenas (vėliau)

Kol kas `skydra.eu` DNS rodo į Hostinger. Prijungimas prie šios paslaugos:

1. Patvirtinti `skydra.eu` Google Search Console (TXT įrašas Hostinger DNS).
2. Terraform pridėti domeno susiejimą `skydra.eu` ir `www.skydra.eu`.
3. Hostinger DNS pakeisti tik `A`/`AAAA` ir `www` įrašus. `MX` ir SPF įrašų neliesti, kitaip nustos veikti `info@skydra.eu` paštas.
