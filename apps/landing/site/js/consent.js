// Cookie consent (vanilla-cookieconsent 3, self-hosted) and Google Analytics 4.
//
// GA4 runs in its strictest form: gtag.js is not even downloaded until the visitor accepts the
// "Analitika" category, so nothing reaches Google before consent. Ads signals stay off.
// While GA_MEASUREMENT_ID is empty the site sets no optional cookies, so no banner is shown.
(function () {
  var GA_MEASUREMENT_ID = ''; // e.g. 'G-XXXXXXXXXX', from the client's GA4 property

  // The demonstration copy (Cloud Run service skydra-landing-preview) shows the banner exactly as
  // it will work with GA4, but never loads anything after consent.
  var DEMO = /^skydra-landing-preview-/.test(location.hostname);

  // Without analytics there is nothing to choose: hide the "Slapukų nustatymai" links.
  if ((!GA_MEASUREMENT_ID && !DEMO) || !window.CookieConsent) {
    document.querySelectorAll('.cc-item').forEach(function (e) {
      e.hidden = true;
    });
    return;
  }

  var gaLoaded = false;
  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }

  function startAnalytics() {
    if (DEMO) return;
    if (gaLoaded) {
      gtag('consent', 'update', { analytics_storage: 'granted' });
      return;
    }
    gaLoaded = true;
    gtag('consent', 'default', {
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
    gtag('js', new Date());
    gtag('config', GA_MEASUREMENT_ID, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID);
    document.head.appendChild(s);
  }

  function stopAnalytics() {
    if (gaLoaded) gtag('consent', 'update', { analytics_storage: 'denied' });
  }

  function apply() {
    if (CookieConsent.acceptedCategory('analytics')) startAnalytics();
    else stopAnalytics();
  }

  var policy = '<a href="/privatumas.html#slapukai">Privatumo politika</a>';

  CookieConsent.run({
    // Bump when the categories or cookies change, so everyone is asked again.
    revision: 1,
    cookie: { name: 'cc_cookie', expiresAfterDays: 182, sameSite: 'Lax' },
    guiOptions: {
      consentModal: { layout: 'box', position: 'bottom left', equalWeightButtons: true, flipButtons: false },
      preferencesModal: { layout: 'box', equalWeightButtons: true, flipButtons: false },
    },
    categories: {
      necessary: { enabled: true, readOnly: true },
      analytics: {
        // Withdrawing consent removes the GA cookies at once.
        autoClear: { cookies: [{ name: /^_ga/ }], reloadPage: false },
      },
    },
    onConsent: apply,
    onChange: apply,
    language: {
      default: 'lt',
      translations: {
        lt: {
          consentModal: {
            title: 'Slapukai',
            description:
              'Būtini slapukai užtikrina, kad svetainė veiktų. Jums sutikus, naudosime ir analitinius slapukus (Google Analytics), kad matytume, kaip lankytojai naudojasi svetaine. Sutikimą galite bet kada pakeisti. ' +
              policy,
            acceptAllBtn: 'Priimti visus',
            acceptNecessaryBtn: 'Atmesti',
            showPreferencesBtn: 'Nustatymai',
          },
          preferencesModal: {
            title: 'Slapukų nustatymai',
            acceptAllBtn: 'Priimti visus',
            acceptNecessaryBtn: 'Atmesti visus',
            savePreferencesBtn: 'Išsaugoti pasirinkimą',
            closeIconLabel: 'Uždaryti',
            serviceCounterLabel: 'Paslauga|Paslaugos',
            sections: [
              {
                description:
                  'Pasirinkite, kuriuos slapukus leidžiate naudoti. Būtinų slapukų išjungti negalima: be jų svetainė neveiktų.',
              },
              {
                title: 'Būtini slapukai <span class="pm__badge">Visada įjungti</span>',
                description: 'Įsimena jūsų slapukų pasirinkimą.',
                linkedCategory: 'necessary',
                cookieTable: {
                  headers: { name: 'Slapukas', domain: 'Paskirtis', exp: 'Galioja' },
                  body: [{ name: 'cc_cookie', domain: 'Jūsų slapukų pasirinkimas', exp: '6 mėn.' }],
                },
              },
              {
                title: 'Analitiniai slapukai',
                description:
                  'Google Analytics 4 renka apibendrintą lankomumo statistiką: kurie puslapiai lankomi, iš kokio įrenginio ir apytikslės vietovės. Reklamos ir asmeninimo funkcijos išjungtos.',
                linkedCategory: 'analytics',
                cookieTable: {
                  headers: { name: 'Slapukas', domain: 'Paskirtis', exp: 'Galioja' },
                  body: [
                    { name: '_ga', domain: 'Atskiria lankytojus (Google Analytics)', exp: '2 m.' },
                    { name: '_ga_*', domain: 'Išsaugo sesijos būseną (Google Analytics)', exp: '2 m.' },
                  ],
                },
              },
              {
                title: 'Daugiau informacijos',
                description: 'Kaip tvarkome duomenis ir kokios jūsų teisės, rasite: ' + policy + '.',
              },
            ],
          },
        },
      },
    },
  });
})();
