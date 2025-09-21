const CORPORATE_TOKENS = [
  'sarl',
  'sas',
  'sasu',
  'eurl',
  'earl',
  'sa',
  'sca',
  'scop',
  'sci',
  'selarl',
  'selas',
  'association',
  'centre de formation',
  'centre formation',
  'organisme de formation',
  'organisme formation',
  'formation',
];

type NullableString = string | null | undefined;

const removeAccents = (value: string): string =>
  value.normalize('NFD').replace(/\p{Diacritic}+/gu, '');

const stripCorporateTokens = (value: string): string => {
  let result = value;
  for (const token of CORPORATE_TOKENS) {
    const pattern = new RegExp(`\\b${token.replace(/\s+/g, '\\s+')}\\b`, 'gi');
    result = result.replace(pattern, ' ');
  }
  return result;
};

export const normalizeCenterName = (rawName: string): string => {
  const withoutAccents = removeAccents(rawName)
    .replace(/&/g, ' et ')
    .toLowerCase();

  const sanitized = stripCorporateTokens(withoutAccents);

  const normalized = sanitized
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length === 0) {
    return removeAccents(rawName)
      .replace(/&/g, ' et ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return normalized;
};

export const sanitizeCity = (value: NullableString): string | undefined => {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  if (/distance/i.test(cleaned)) return undefined;
  return cleaned;
};

export const sanitizePostalCode = (value: NullableString): string | undefined => {
  if (!value) return undefined;
  const match = value.match(/\d{4,6}/);
  if (!match) return undefined;
  return match[0].slice(0, 5);
};

export const sanitizeRegion = (value: NullableString): string | undefined => {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  if (/distance/i.test(cleaned)) return undefined;
  return cleaned;
};

export const sanitizeCountry = (value: NullableString): string | undefined => {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length === 2 ? cleaned.toUpperCase() : cleaned;
};
