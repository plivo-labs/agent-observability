import { createMDX } from 'fumadocs-mdx/next'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(__dirname, '..')
const reg = (...segments) =>
  path.join(repoRoot, 'packages/ui/registry/new-york', ...segments)

const BASE = '/agent-observability'

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath: BASE,
  assetPrefix: BASE,
  trailingSlash: true,
  images: { unoptimized: true },
  outputFileTracingRoot: repoRoot,
  // Silence the multi-lockfile root inference warning (docs + repo root
  // both carry lockfiles). Harmless, but tidy — pin the inferred root.
  turbopack: { root: repoRoot },
  // Spike: webpack COMPILES the registry fine (that's the cross-package proof);
  // we skip TS/ESLint gating because tsc would type-check the entire registry
  // dir and choke on registry items we didn't wire `paths` for. The real docs/
  // Vite build doesn't tsc the registry as part of its build either.
  typescript: { ignoreBuildErrors: true },
  webpack: (cfg) => {
    cfg.resolve.alias = {
      ...cfg.resolve.alias,

      // NOTE: deliberately NOT aliasing react / react-dom here. Doing so breaks
      // Next's server build, which swaps in the `react-server` condition for
      // RSC — a hard react->node_modules/react alias defeats that and yields
      // "Cannot read properties of null (reading 'useMemo')" during prerender.
      // bun's hoisting already gives docs + packages/ui a single React 19.

      // DEDUPE context-bearing packages onto the docs copy. The registry
      // source resolves its own deps upward into packages/ui/node_modules, so
      // without these a SECOND nuqs / react-table instance loads — and the
      // NuqsAdapter context set by docs's nuqs is then invisible to the
      // registry's useQueryState ("nuqs requires an adapter" crash). This is the
      // Next equivalent of docs/vite.config.ts `resolve.dedupe`.
      //
      // Use exact-specifier ($) aliases per imported subpath. A directory/prefix
      // alias does NOT work: webpack stops re-running the package `exports` map,
      // so `nuqs/server` fails to resolve and react-table resolves to its legacy
      // un-transpiled `module` build (index.esm.js). Pin each used entry file.
      nuqs$: path.join(__dirname, 'node_modules/nuqs/dist/index.js'),
      'nuqs/server$': path.join(__dirname, 'node_modules/nuqs/dist/server.js'),
      'nuqs/adapters/next/app$': path.join(
        __dirname,
        'node_modules/nuqs/dist/adapters/next/app.js',
      ),
      // Exact-specifier ($) alias to the proper ESM entry. A directory alias
      // here makes webpack pick the legacy `module` field (index.esm.js), which
      // Next's loader chain won't transpile; pin the exports `import` build.
      '@tanstack/react-table$': path.join(
        __dirname,
        'node_modules/@tanstack/react-table/build/lib/index.mjs',
      ),
      '@tanstack/table-core$': path.join(
        __dirname,
        'node_modules/@tanstack/table-core/build/lib/index.mjs',
      ),

      // shadcn UI + utils — local to docs (registry imports these)
      '@/components/ui': path.join(__dirname, 'components/ui'),
      '@/lib/utils': path.join(__dirname, 'lib/utils.ts'),

      // Registry lib items (mirrored from docs/vite.config.ts)
      '@/lib/observability-types': reg('observability-types/types.ts'),
      '@/lib/observability-format': reg('observability-format/format.ts'),
      '@/lib/observability-events': reg('observability-events/events.ts'),
      '@/lib/observability-api': reg('observability-api/api.ts'),
      '@/lib/observability-provider': reg('observability-provider/provider.tsx'),
      '@/lib/observability-hooks': reg('observability-hooks/hooks.ts'),
      '@/lib/labels': reg('labels/labels.ts'),

      // Registry data-table (tablecn) — all sub-files co-located under the dir
      '@/components/data-table': reg('data-table'),

      // Registry components
      '@/components/observability-chart-shared': reg(
        'observability-chart-shared/chart-shared.tsx',
      ),
      '@/components/metric-summary-cards': reg(
        'metric-summary-cards/metric-summary-cards.tsx',
      ),
      '@/components/latency-percentiles-chart': reg(
        'latency-percentiles-chart/latency-percentiles-chart.tsx',
      ),
      '@/components/pipeline-breakdown-chart': reg(
        'pipeline-breakdown-chart/pipeline-breakdown-chart.tsx',
      ),
      '@/components/latency-over-turns-chart': reg(
        'latency-over-turns-chart/latency-over-turns-chart.tsx',
      ),
      '@/components/token-usage-section': reg(
        'token-usage-section/token-usage-section.tsx',
      ),
      '@/components/talk-time-chart': reg('talk-time-chart/talk-time-chart.tsx'),
      '@/components/cache-efficiency-chart': reg(
        'cache-efficiency-chart/cache-efficiency-chart.tsx',
      ),
      '@/components/llm-throughput-chart': reg(
        'llm-throughput-chart/llm-throughput-chart.tsx',
      ),
      '@/components/session-header': reg('session-header/session-header.tsx'),
      '@/components/turn-transcript': reg('turn-transcript/turn-transcript.tsx'),
      '@/components/session-timeline': reg('session-timeline'),
      '@/components/session-events': reg('session-events/session-events.tsx'),
      '@/components/session-evaluations-drawer': reg(
        'session-evaluations-drawer/session-evaluations-drawer.tsx',
      ),
      '@/components/session-config': reg('session-config/session-config.tsx'),
      '@/components/sessions-page': reg('sessions-page/sessions-page.tsx'),
      '@/components/session-detail-page': reg(
        'session-detail-page/session-detail-page.tsx',
      ),
      '@/components/evals-page': reg('evals-page/evals-page.tsx'),
      '@/components/eval-run-detail-page': reg(
        'eval-run-detail-page/eval-run-detail-page.tsx',
      ),
      '@/components/eval-case-detail-page': reg(
        'eval-case-detail-page/eval-case-detail-page.tsx',
      ),
      '@/components/eval-run-compare-page': reg(
        'eval-run-compare-page/eval-run-compare-page.tsx',
      ),

      // Net-new registry items from the agents-first-class IA
      '@/components/obs-cells': reg('obs-cells/obs-cells.tsx'),
      '@/components/kpi': reg('kpi/kpi.tsx'),
      '@/components/agent-scope-header': reg(
        'agent-scope-header/agent-scope-header.tsx',
      ),
      '@/components/agents-page': reg('agents-page/agents-page.tsx'),
      '@/components/agent-detail-page': reg(
        'agent-detail-page/agent-detail-page.tsx',
      ),
      '@/components/agent-overview-tab': reg(
        'agent-overview-tab/agent-overview-tab.tsx',
      ),
      '@/components/agent-runs-page': reg('agent-runs-page/agent-runs-page.tsx'),
      '@/components/conversation-evals-tab': reg(
        'conversation-evals-tab/conversation-evals-tab.tsx',
      ),
      '@/components/conversation-eval-detail-drawer': reg(
        'conversation-eval-detail-drawer/conversation-eval-detail-drawer.tsx',
      ),
    }
    return cfg
  },
}

export default createMDX()(config)
