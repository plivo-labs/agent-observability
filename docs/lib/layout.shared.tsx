import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
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
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
