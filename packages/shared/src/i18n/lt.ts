export const lt = {
  app: {
    name: 'SkyDra',
    tagline: 'AML/KYC sandorio bylos NT brokeriams',
  },
  health: {
    title: 'Sistemos būsena',
    api: 'API',
    database: 'Duomenų bazė',
    ok: 'Veikia',
    unavailable: 'Nepasiekiama',
    loading: 'Tikrinama…',
    simulated: 'DEMO režimas: patikros imituojamos',
  },
} as const;

export type Translations = typeof lt;
