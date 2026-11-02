import type { SidebarColors } from '../../components/library/Sidebar';

/** Same palette as the desktop workspace (app/index.tsx). */
export const LIGHT: SidebarColors & { bg: string } = { bg: '#fbfbfa', background: '#fbfbfa', text: '#1f1f1f', muted: '#8a8a86', active: '#ecece8', danger: '#c2410c' };
export const DARK: SidebarColors & { bg: string } = { bg: '#1b1b1c', background: '#1b1b1c', text: '#d9d9d6', muted: '#77776f', active: '#2a2a2c', danger: '#f97316' };
