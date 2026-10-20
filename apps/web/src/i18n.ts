import { lt } from '@skydra/shared';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

void i18n.use(initReactI18next).init({
  resources: { lt: { translation: lt } },
  lng: 'lt',
  fallbackLng: 'lt',
  interpolation: { escapeValue: false },
});

export default i18n;
