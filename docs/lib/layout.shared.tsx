import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';
import { appName, gitConfig } from './shared';

/* Brand mark — inline copy of app/icon.svg (rounded ink square + AO
 * letterforms) so the navbar logo needs no asset-path/basePath plumbing. */
function BrandMark() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 100 100"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <rect width="100" height="100" rx="20" fill="#0c0c09" />
      <path
        fill="#fff"
        d="M20.37 71.73L14.20 70.81L25.85 29.30L40.94 30.21L49.01 70.81L43.45 71.73L39.11 61.37L22.50 62.74L20.37 71.73ZM29.05 37.15L28.60 37.15L23.64 57.94L37.74 58.09L29.05 37.15ZM85.80 57.86L85.80 57.86Q85.80 61.67 85.15 64.19Q84.51 66.70 82.91 68.68L82.91 68.68Q79.78 72.26 70.83 72.30Q61.88 72.34 56.93 68.22L56.93 68.22Q55.87 62.97 55.87 57.86L55.87 57.86Q55.87 47.51 59.75 39.35Q63.63 31.20 68.81 27.70L68.81 27.70Q76.13 30.67 80.96 38.90Q85.80 47.12 85.80 57.86ZM78.18 55.12L78.18 55.12Q78.18 45.52 75.06 38.67L75.06 38.67Q69.04 44.23 65.62 51.50Q62.19 58.78 62.19 65.79L62.19 65.79Q64.32 66.24 68.62 66.24Q72.93 66.24 77.12 64.87L77.12 64.87Q78.18 60.00 78.18 55.12Z"
      />
    </svg>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // JSX supported
      title: (
        <>
          <BrandMark />
          {appName}
        </>
      ),
    },
  };
}

/* Compact sidebar footer: GitHub link + theme toggle as one tight,
 * right-aligned group. Replaces the default footer pill, which stretches
 * a single icon link and the toggle across the full sidebar width. The
 * default is suppressed by dropping `githubUrl` from baseOptions and
 * passing `themeSwitch={{ enabled: false }}` to DocsLayout. */
export function SidebarFooter() {
  return (
    <div className="flex items-center justify-end gap-1 text-fd-muted-foreground">
      <a
        href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="GitHub"
        className="rounded-md p-2 hover:bg-fd-accent hover:text-fd-accent-foreground"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-4.5" aria-hidden>
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
      </a>
      <ThemeSwitch />
    </div>
  );
}
