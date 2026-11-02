import type { DateFormat, TenantPreferences } from '@/types/api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Calendar parts of an instant in a timezone. */
function partsIn(date: Date, timeZone?: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: p.hour === '24' ? '00' : p.hour, mm: p.minute };
}

export function formatDateParts(y: number, m: number, d: number, fmt: DateFormat): string {
  const dd = String(d).padStart(2, '0');
  const mo = String(m).padStart(2, '0');
  switch (fmt) {
    case 'MM/DD/YYYY':
      return `${mo}/${dd}/${y}`;
    case 'YYYY-MM-DD':
      return `${y}-${mo}-${dd}`;
    case 'DD MMM YYYY':
      return `${dd} ${MONTHS[m - 1]} ${y}`;
    default:
      return `${dd}/${mo}/${y}`;
  }
}

/** Format an ISO timestamp or YYYY-MM-DD date with the organization's preferences. */
export function formatDate(value: string | null | undefined, prefs?: Pick<TenantPreferences, 'dateFormat' | 'timezone'>): string {
  if (!value) return '—';
  const fmt = prefs?.dateFormat ?? 'DD/MM/YYYY';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return formatDateParts(y, m, d, fmt);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const p = partsIn(date, prefs?.timezone);
  return formatDateParts(p.y, p.m, p.d, fmt);
}

export function formatDateTime(value: string | null | undefined, prefs?: Pick<TenantPreferences, 'dateFormat' | 'timezone'>): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const p = partsIn(date, prefs?.timezone);
  return `${formatDateParts(p.y, p.m, p.d, prefs?.dateFormat ?? 'DD/MM/YYYY')}, ${p.hh}:${p.mm}`;
}

export function relativeTime(value: string, now = Date.now()): string {
  const diff = (new Date(value).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return rtf.format(Math.round(diff / (86400 * 30)), 'month');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function greeting(timeZone?: string): string {
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(new Date()));
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Readable summary of a user-agent string for the sessions list. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : /Postman/i.test(ua) ? 'Postman' : /node|undici/i.test(ua) ? 'API client' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
