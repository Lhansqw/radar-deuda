/** Iconos de trazo fino (1,5 px), dibujados para la aplicación. */
const PATHS = {
  folder: 'M2.5 5.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H9L7.5 4h-4a1 1 0 0 0-1 1.5Z',
  github: 'M9 2.5a6.5 6.5 0 0 0-2.06 12.67c.33.06.44-.14.44-.31v-1.1c-1.8.39-2.18-.87-2.18-.87-.3-.75-.72-.95-.72-.95-.59-.4.04-.39.04-.39.65.05 1 .67 1 .67.58 1 1.52.71 1.89.54.06-.42.23-.71.41-.87-1.44-.16-2.95-.72-2.95-3.2 0-.71.25-1.29.67-1.74-.07-.17-.29-.83.06-1.72 0 0 .55-.18 1.79.66a6.2 6.2 0 0 1 3.26 0c1.24-.84 1.79-.66 1.79-.66.35.89.13 1.55.06 1.72.42.45.67 1.03.67 1.74 0 2.49-1.52 3.04-2.96 3.2.23.2.44.6.44 1.21v1.79c0 .17.11.38.45.31A6.5 6.5 0 0 0 9 2.5Z',
  plus: 'M9 3.5v11M3.5 9h11',
  play: 'M5.5 3.8v10.4a.5.5 0 0 0 .77.42l8.1-5.2a.5.5 0 0 0 0-.84l-8.1-5.2a.5.5 0 0 0-.77.42Z',
  stop: 'M4.5 4.5h9v9h-9z',
  settings: 'M9 11.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM14.6 10.6l1.15.9-1.25 2.17-1.38-.53a5.3 5.3 0 0 1-1.58.92L11.3 15.5H8.8l-.24-1.44a5.3 5.3 0 0 1-1.58-.92l-1.38.53-1.25-2.17 1.15-.9a5.4 5.4 0 0 1 0-1.82l-1.15-.9 1.25-2.17 1.38.53c.47-.4 1-.71 1.58-.92L8.8 2.5h2.5l.24 1.44c.58.21 1.11.52 1.58.92l1.38-.53 1.25 2.17-1.15.9a5.4 5.4 0 0 1 0 1.2Z',
  panel: 'M3 3h5v5H3zM10 3h5v3h-5zM10 8h5v7h-5zM3 10h5v5H3z',
  list: 'M6.5 5h8.5M6.5 9h8.5M6.5 13h8.5M3 5h.01M3 9h.01M3 13h.01',
  tree: 'M3 3v10.5a1 1 0 0 0 1 1h3M3 7.5h4M10 3h5v3h-5zM10 6.5h5v3h-5zM10 12h5v3h-5z',
  history: 'M3 9a6 6 0 1 0 1.76-4.24L3 6.5M3 3v3.5h3.5M9 6v3.25l2.25 1.5',
  close: 'M4.5 4.5l9 9M13.5 4.5l-9 9',
  alert: 'M9 6.5v3.5M9 12.5h.01M7.86 2.98 1.94 13.25A1.3 1.3 0 0 0 3.08 15.2h11.84a1.3 1.3 0 0 0 1.14-1.95L10.14 2.98a1.3 1.3 0 0 0-2.28 0Z',
  check: 'M3.5 9.5l3.5 3.5 7.5-8',
  chevron: 'M6.5 4l5 5-5 5',
  trash: 'M3.5 5h11M7.5 5V3.5h3V5M5 5l.7 9.1a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L13 5',
  external: 'M10.5 3h4.5v4.5M15 3l-7 7M13 10.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3.5',
  chat: 'M3 4.75A1.75 1.75 0 0 1 4.75 3h8.5A1.75 1.75 0 0 1 15 4.75v5.5A1.75 1.75 0 0 1 13.25 12H8.5L5 15v-3h-.25A1.75 1.75 0 0 1 3 10.25ZM6.5 6.75h5M6.5 9h3',
  sparkle: 'M9 2.5l1.3 4.2 4.2 1.3-4.2 1.3L9 13.5l-1.3-4.2L3.5 8l4.2-1.3L9 2.5Z',
  search: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM15.5 15.5l-3.6-3.6',
  file: 'M10 2.5H5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.5l-4-4ZM10 2.5v4h4',
  reveal: 'M2.5 5.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H9L7.5 4h-4a1 1 0 0 0-1 1.5ZM9 9v4M7 11l2 2 2-2',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Marca de la aplicación: anillos de radar con un barrido y dos ecos. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10.25" fill="none" stroke="var(--linea-fuerte)" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="5.5" fill="none" stroke="var(--linea-fuerte)" strokeWidth="1.5" />
      <path d="M12 12 L19.2 4.8" stroke="var(--tiza)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16.4" cy="14.6" r="1.9" fill="var(--sev-medium)" />
      <circle cx="8.6" cy="9.2" r="1.6" fill="var(--sev-critical)" />
    </svg>
  );
}
