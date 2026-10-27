export type Theme = 'light' | 'dark' | 'system';
const KEY = 'mc-theme';

export function getTheme(): Theme {
  try {
    return (localStorage.getItem(KEY) as Theme) || 'system';
  } catch {
    return 'system';
  }
}
export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable */
  }
}
export function isDark(): boolean {
  const a = document.documentElement.getAttribute('data-theme');
  if (a) return a === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
