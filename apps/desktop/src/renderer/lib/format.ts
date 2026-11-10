import { currentLocale, tr } from '../i18n.js';
import type { Locale } from '../../shared/settings.js';

/** Formato de números, tiempos y fechas en el idioma de la interfaz. */
interface Formatters {
  nf0: Intl.NumberFormat;
  nf1: Intl.NumberFormat;
  nf2: Intl.NumberFormat;
  date: Intl.DateTimeFormat;
  time: Intl.DateTimeFormat;
}

const cache = new Map<Locale, Formatters>();

function fmt(): Formatters {
  const locale = currentLocale();
  let f = cache.get(locale);
  if (!f) {
    f = {
      nf0: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      nf1: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
      nf2: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
      date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
      time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
    };
    cache.set(locale, f);
  }
  return f;
}

export function formatNumber(n: number): string {
  return fmt().nf0.format(n);
}

/** Minutos de corrección: "45 min", "2,5 h", "3,1 d" (jornadas de 8 h). */
export function formatEffort(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} min`;
  const hours = minutes / 60;
  if (hours < 40) return `${fmt().nf1.format(hours)} h`;
  return `${fmt().nf1.format(hours / 8)} d`;
}

export function formatPercent(ratio: number): string {
  return `${fmt().nf1.format(ratio * 100)} %`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${fmt().nf1.format(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${fmt().date.format(d)}, ${fmt().time.format(d)}`;
}

/** Fecha corta del eje de la evolución: "12 oct." / "Oct 12", o la hora si todo es del mismo día. */
export function formatAxisDate(iso: string, timeOnly: boolean): string {
  const d = new Date(iso);
  const locale = currentLocale();
  return timeOnly ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/** "hace un momento", "hace 5 min", "hace 3 h", "ayer", "hace 4 días" o la fecha. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const diff = (now.getTime() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return tr('hace un momento', 'just now');
  if (diff < 3600) {
    const n = Math.round(diff / 60);
    return tr(`hace ${n} min`, `${n} min ago`);
  }
  if (diff < 86_400) {
    const n = Math.round(diff / 3600);
    return tr(`hace ${n} h`, `${n} h ago`);
  }
  const days = Math.floor(diff / 86_400);
  if (days === 1) return tr('ayer', 'yesterday');
  if (days < 7) return tr(`hace ${days} días`, `${days} days ago`);
  return fmt().date.format(new Date(iso));
}

/** Para buscar sin distinguir mayúsculas ni tildes. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Tamaño en disco: "512 B", "1,5 KB", "12,3 MB", "1,25 GB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${fmt().nf1.format(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${fmt().nf1.format(n / (1024 * 1024))} MB`;
  return `${fmt().nf2.format(n / (1024 * 1024 * 1024))} GB`;
}
