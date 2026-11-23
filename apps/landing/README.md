# SkyDra svetainė (skydra.eu)

Statinė rinkodaros svetainė. Ją rodo nginx Cloud Run paslaugoje `skydra-landing` („ESV project“, europe-north1).

| Puslapis             | Paskirtis                                                                             |
| -------------------- | ------------------------------------------------------------------------------------- |
| `index.html`         | pagrindinis puslapis (`/`)                                                            |
| `aciu.html`          | padėka po formos išsiuntimo (formsubmit.co nukreipia į `https://skydra.eu/aciu.html`) |
| `registracija.html`  | registracija („Registruotis dabar“, „Pradėti“)                                        |
| `vertinimas.html`    | nemokamas AML testas                                                                  |
| `prisijungimas.html` | kol kas nenaudojamas; „Prisijungti“ veda į sistemos `/login`                          |

## Kas pakeista kliento pateiktuose failuose

Pakeitimai tik techniniai, tekstai ir dizainas nekeisti:

- Google Fonts pakeisti savo serveryje laikomais šriftais (`site/fonts/`, SIL OFL licencija). Taip lankytojų IP adresai nepatenka pas Google, kartu tenkinama CSP.
- `index.html` ir `vertinimas.html` įterpti skriptai perkelti į `site/js/`. Tai leidžia CSP drausti bet kokius kitus skriptus.
- „Prisijungti“ veda į `https://skydra-demo-915954505621.europe-north1.run.app/login`.
- Ištaisyta sugadinta žymė `<//span>`.

Gavus naują kliento versiją, failą įkelkite į `site/` ir pakartokite šiuos keturis pakeitimus. Prettier šių failų neformatuoja, todėl palyginimas su kliento versija lieka tikslus.

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
