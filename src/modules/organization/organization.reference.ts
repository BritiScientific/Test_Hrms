/**
 * Allowed values for organization preferences. The API validates against
 * these lists and serves them to the UI (GET /organization/options), so the
 * browser and server can never disagree about what is valid.
 */

export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY'] as const;

export const LOCALES: { code: string; label: string }[] = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-US', label: 'English (United States)' },
  { code: 'en-GB', label: 'English (United Kingdom)' },
  { code: 'en-AU', label: 'English (Australia)' },
  { code: 'en-CA', label: 'English (Canada)' },
  { code: 'en-SG', label: 'English (Singapore)' },
  { code: 'en-AE', label: 'English (UAE)' },
  { code: 'hi-IN', label: 'हिन्दी (भारत)' },
  { code: 'ta-IN', label: 'தமிழ் (இந்தியா)' },
  { code: 'te-IN', label: 'తెలుగు (భారతదేశం)' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ (ಭಾರತ)' },
  { code: 'mr-IN', label: 'मराठी (भारत)' },
  { code: 'bn-IN', label: 'বাংলা (ভারত)' },
  { code: 'ar-AE', label: 'العربية (الإمارات)' },
  { code: 'de-DE', label: 'Deutsch (Deutschland)' },
  { code: 'fr-FR', label: 'Français (France)' },
  { code: 'es-ES', label: 'Español (España)' },
];
export const LOCALE_CODES = new Set(LOCALES.map((l) => l.code));

export const TIMEZONES: string[] = Intl.supportedValuesOf('timeZone');
export const TIMEZONE_SET = new Set(TIMEZONES);

const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' });
export const CURRENCIES = Intl.supportedValuesOf('currency').map((code) => ({
  code,
  label: currencyNames.of(code) ?? code,
}));
export const CURRENCY_SET = new Set(CURRENCIES.map((c) => c.code));

// ISO 3166-1 alpha-2 codes known to ICU, minus macro-regions / reserved codes.
const NOT_COUNTRIES = new Set(['AC', 'CP', 'DG', 'EA', 'EU', 'EZ', 'IC', 'QO', 'TA', 'UN', 'XA', 'XB', 'ZZ']);
const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
export const COUNTRIES: { code: string; label: string }[] = (() => {
  const out: { code: string; label: string }[] = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code)) continue;
      let label: string | undefined;
      try {
        label = regionNames.of(code);
      } catch {
        label = undefined;
      }
      if (label && label !== code) out.push({ code, label });
    }
  }
  return out.sort((x, y) => x.label.localeCompare(y.label));
})();
export const COUNTRY_SET = new Set(COUNTRIES.map((c) => c.code));

/** Country-aware postal code rules where the format is unambiguous; others get a generic check. */
const POSTAL_RULES: Record<string, { re: RegExp; example: string }> = {
  IN: { re: /^\d{6}$/, example: '560001' },
  US: { re: /^\d{5}(-\d{4})?$/, example: '94105 or 94105-1234' },
  GB: { re: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i, example: 'SW1A 1AA' },
  CA: { re: /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i, example: 'K1A 0B1' },
  AU: { re: /^\d{4}$/, example: '2000' },
  SG: { re: /^\d{6}$/, example: '018989' },
  DE: { re: /^\d{5}$/, example: '10115' },
  FR: { re: /^\d{5}$/, example: '75001' },
};
const GENERIC_POSTAL = /^[A-Za-z0-9][A-Za-z0-9 -]{1,18}[A-Za-z0-9]$/;

export function postalCodeError(country: string | null, postal: string): string | null {
  const rule = country ? POSTAL_RULES[country] : undefined;
  if (rule) return rule.re.test(postal) ? null : `Postal code should look like ${rule.example}`;
  return GENERIC_POSTAL.test(postal) ? null : 'Postal code is not valid';
}
