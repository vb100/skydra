/** Dates and times as shown everywhere: YYYY-MM-DD and HH:mm in Lithuanian time. */
const DATE = new Intl.DateTimeFormat('lt-LT', {
  timeZone: 'Europe/Vilnius',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const TIME = new Intl.DateTimeFormat('lt-LT', {
  timeZone: 'Europe/Vilnius',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(value: string | Date | null | undefined): string {
  return value ? DATE.format(new Date(value)) : '–';
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '–';
  const d = new Date(value);
  return `${DATE.format(d)} ${TIME.format(d)}`;
}

/** Amounts with thousands separators and two decimals only when needed: 168 000 EUR. */
export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  return `${Number(value).toLocaleString('lt-LT', { maximumFractionDigits: 2 })} EUR`;
}
