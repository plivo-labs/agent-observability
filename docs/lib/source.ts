import { docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';

// See https://fumadocs.dev/docs/headless/source-api for more info
// Docs are served at the SITE ROOT (baseUrl '/') to preserve the existing flat
// URLs from the previous Vite docs site. Under GitHub Pages the whole export is
// nested beneath the `/agent-observability/` basePath (set in next.config.mjs),
// but baseUrl here is the in-app route prefix, which stays '/'.
export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  plugins: [],
});
