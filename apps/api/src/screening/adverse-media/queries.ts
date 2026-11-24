import type { ScreeningSubject } from '../provider';

/**
 * Search queries for adverse media (client specification, module B): the person's or company's
 * name together with risk words, `("name" OR "name variant") (word1 OR word2 …)`.
 *
 * Lithuanian names are declined, so a news text often has the genitive ("Jono Jonaičio"), and
 * many sites drop the Lithuanian letters ("Jonaicio"). Company names are searched without the
 * legal form (UAB, AB, MB…) and quotation marks.
 */
export const RISK_WORDS = {
  lt: [
    'sukčiavimas',
    'pinigų plovimas',
    'kyšis',
    'korupcija',
    'nuteistas',
    'įtariamas',
    'kaltinamas',
    'sulaikytas',
    'krata',
    'FNTT',
    'STT',
    'apgaulė',
    'mokesčių vengimas',
    'bankrotas',
    'sankcijos',
  ],
  en: [
    'fraud',
    'money laundering',
    'bribery',
    'corruption',
    'convicted',
    'charged',
    'arrested',
    'sanctions',
    'tax evasion',
  ],
} as const;

const LETTERS: Record<string, string> = {
  ą: 'a',
  č: 'c',
  ę: 'e',
  ė: 'e',
  į: 'i',
  š: 's',
  ų: 'u',
  ū: 'u',
  ž: 'z',
  Ą: 'A',
  Č: 'C',
  Ę: 'E',
  Ė: 'E',
  Į: 'I',
  Š: 'S',
  Ų: 'U',
  Ū: 'U',
  Ž: 'Z',
};
/** Lithuanian letters to Latin ones, as sites without them write names. */
export const plain = (s: string) => s.replace(/[ąčęėįšųūžĄČĘĖĮŠŲŪŽ]/g, (c) => LETTERS[c]!);

/**
 * Genitive of a Lithuanian first name or surname, from its ending; null when the word does not
 * look Lithuanian (foreign names are searched as written).
 */
export function genitive(word: string): string | null {
  const rules: [RegExp, string][] = [
    [/tis$/, 'čio'], // Jonaitis → Jonaičio
    [/dis$/, 'džio'], // Mindis → Mindžio
    [/tys$/, 'čio'], // Kęstutys → Kęstučio
    [/dys$/, 'džio'],
    [/is$/, 'io'], // Jurgis → Jurgio
    [/ys$/, 'io'], // Mažeikys → Mažeikio
    [/as$/, 'o'], // Jonas → Jono, Kazlauskas → Kazlausko
    [/us$/, 'aus'], // Darius → Dariaus, Saulius → Sauliaus
    [/ė$/, 'ės'], // Petrauskienė → Petrauskienės
    [/a$/, 'os'], // Ona → Onos
  ];
  for (const [ending, replacement] of rules)
    if (ending.test(word)) return word.replace(ending, replacement);
  return null;
}

const LEGAL_FORMS =
  /^(UAB|AB|MB|VŠĮ|VšĮ|IĮ|ŽŪB|KB|TŪB|KŪB|SIA|AS|OÜ|SP\.? Z O\.?O\.?|GMBH|LTD|LLC)$/i;

/** A company name without its legal form and quotation marks: UAB „Pavyzdys“ → Pavyzdys. */
export function companyName(name: string): string {
  return name
    .replace(/[„“”"«»]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL_FORMS.test(w))
    .join(' ')
    .trim();
}

/** The name forms to search, Lithuanian (with declension) and international. */
export function nameVariants(subject: ScreeningSubject): { lt: string[]; en: string[] } {
  if (subject.partyType === 'LEGAL') {
    const name = companyName(subject.name) || subject.name.trim();
    const forms = [...new Set([name, plain(name)])];
    return { lt: forms, en: forms };
  }
  const words = subject.name.trim().split(/\s+/);
  const declined = words.map((w) => genitive(w));
  const genitiveName = declined.every((d) => d !== null) ? declined.join(' ') : null;
  const nominative = words.join(' ');
  const lt = [nominative, genitiveName, plain(nominative), genitiveName && plain(genitiveName)];
  return {
    lt: [...new Set(lt.filter((v): v is string => !!v))],
    en: [...new Set([nominative, plain(nominative)])],
  };
}

const quote = (s: string) => `"${s.replace(/"/g, '')}"`;

/** `("Jonas Jonaitis" OR "Jono Jonaičio") (sukčiavimas OR "pinigų plovimas" OR …)` */
export function searchQuery(names: readonly string[], words: readonly string[]): string {
  const any = (terms: string[]) => (terms.length === 1 ? terms[0]! : `(${terms.join(' OR ')})`);
  return `${any(names.map(quote))} ${any(words.map((w) => (w.includes(' ') ? quote(w) : w)))}`;
}

/**
 * Terms to highlight in a snippet: the name forms and the stems of the risk words, so that
 * declined forms ("sukčiavimu", "nuteistam") are marked too.
 */
export function highlightTerms(names: readonly string[]): string[] {
  // The ending of the last word varies ("pinigų plovimu", "nuteistam"); short words and
  // abbreviations (STT, FNTT, kyšis) are kept whole.
  const stems = [...RISK_WORDS.lt, ...RISK_WORDS.en].map((w) => {
    const last = w.split(' ').at(-1)!;
    return last.length <= 5 ? w : w.slice(0, -2);
  });
  return [...new Set([...names, ...stems])];
}

/**
 * A query within a service's limits (Brave: 400 characters, 50 words): the names always stay,
 * risk words are dropped from the end of the list until it fits.
 */
export function fittedQuery(
  names: readonly string[],
  words: readonly string[],
  limits: { maxChars: number; maxWords: number },
): string {
  for (let n = words.length; n > 0; n--) {
    const q = searchQuery(names, words.slice(0, n));
    if (q.length <= limits.maxChars && q.split(/\s+/).length <= limits.maxWords) return q;
  }
  return searchQuery(names.slice(0, 2), words.slice(0, 1));
}

const foldText = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/**
 * What a result's title or snippet must contain to be about the subject: the surname's stem
 * shared by its forms (Jonaitis, Jonaičio → "jonai"), or the company name.
 */
export function relevanceStems(subject: ScreeningSubject): string[] {
  if (subject.partyType === 'LEGAL')
    return [foldText(companyName(subject.name) || subject.name.trim())];
  const surname = subject.name.trim().split(/\s+/).at(-1) ?? '';
  const nominative = foldText(surname);
  const declined = genitive(surname);
  if (!declined) return [nominative];
  const other = foldText(declined);
  let i = 0;
  while (i < nominative.length && nominative[i] === other[i]) i++;
  return [i >= 3 ? nominative.slice(0, i) : nominative];
}

export const mentions = (text: string, stems: readonly string[]) => {
  const folded = foldText(text);
  return stems.some((s) => folded.includes(s));
};
