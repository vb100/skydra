import { useQuery } from '@tanstack/react-query';
import { HealthResponse } from '@skydra/shared';
import { useTranslation } from 'react-i18next';

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return HealthResponse.parse(await res.json());
}

export function App() {
  const { t } = useTranslation();
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false });

  const apiState = health.isPending
    ? t('health.loading')
    : health.isSuccess
      ? t('health.ok')
      : t('health.unavailable');
  const dbState = health.data ? t(`health.${health.data.database}`) : '—';

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 640,
        margin: '48px auto',
        padding: '0 16px',
      }}
    >
      <h1>{t('app.name')}</h1>
      <p>{t('app.tagline')}</p>
      {health.data?.simulatedProviders && <p role="status">{t('health.simulated')}</p>}
      <h2>{t('health.title')}</h2>
      <ul>
        <li>
          {t('health.api')}: {apiState}
        </li>
        <li>
          {t('health.database')}: {dbState}
        </li>
      </ul>
    </main>
  );
}
