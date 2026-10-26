/** Formato en español para la interfaz. */
const nf1 = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es', { maximumFractionDigits: 0 });

export function formatNumber(n: number): string {
  return nf0.format(n);
}

/** Minutos de corrección: "45 min", "2,5 h", "3,1 d" (jornadas de 8 h). */
export function formatEffort(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} min`;
  const hours = minutes / 60;
  if (hours < 40) return `${nf1.format(hours)} h`;
  return `${nf1.format(hours / 8)} d`;
}

export function formatPercent(ratio: number): string {
  return `${nf1.format(ratio * 100)} %`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${nf1.format(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

const dateFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${dateFmt.format(d)}, ${timeFmt.format(d)}`;
}

/** "hace un momento", "hace 5 min", "hace 3 h", "ayer", "hace 4 días" o la fecha. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const diff = (now.getTime() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return 'hace un momento';
  if (diff < 3600) return `hace ${Math.round(diff / 60)} min`;
  if (diff < 86_400) return `hace ${Math.round(diff / 3600)} h`;
  const days = Math.floor(diff / 86_400);
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  return dateFmt.format(new Date(iso));
}

/** Para buscar sin distinguir mayúsculas ni tildes. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}
