import { LOCALES } from '@skydra/shared';
import { useTranslation } from 'react-i18next';
import { currentLanguage, setLanguage } from './i18n';

/** LT / EN: the other language, one click away, next to the theme toggle. */
export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const current = LOCALES.find((l) => l === i18n.language) ?? currentLanguage();
  const next = LOCALES.find((l) => l !== current) ?? 'lt';
  return (
    <button
      type="button"
      className="ghost small theme-toggle"
      onClick={() => setLanguage(next)}
      aria-label={`${t('language.label')}: ${t(`language.${next}`)}`}
      title={t(`language.${next}`)}
      lang={next}
    >
      {next.toUpperCase()}
    </button>
  );
}
