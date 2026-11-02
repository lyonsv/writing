/**
 * Shared spacing and type for the RN-primitive UI (sidebar, quick open,
 * account, iOS screens), so panels and lists line up across desktop and iPhone.
 * The editor's own typography lives in components/editor/theme.ts.
 */
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;
export const radius = { s: 6, m: 10 } as const;
export const type = {
  /** Panel titles ("Account", screen headers on desktop). */
  title: { fontSize: 15, fontWeight: '600' as const },
  body: { fontSize: 14 },
  small: { fontSize: 12 },
  /** Small-caps section labels ("DEVICES"). */
  section: { fontSize: 11, letterSpacing: 0.8 },
} as const;
