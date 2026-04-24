import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { handleMockRequest, type MockData } from './src/lib/mock-handler'

const reg = (...segments: string[]) =>
  resolve(__dirname, '../registry/new-york', ...segments)

const mockDataPath = resolve(__dirname, 'src/mock-data.json')

function mockApiPlugin() {
  return {
    name: 'mock-api',
    configureServer(server: any) {
      const mockData = JSON.parse(readFileSync(mockDataPath, 'utf-8')) as MockData
      server.middlewares.use(async (req: any, res: any, next: any) => {
        if (!req.url?.startsWith('/api/')) return next()
        const url = new URL(req.url, 'http://localhost')
        const response = handleMockRequest(url.pathname, url.search, mockData)
        if (!response) return next()
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        res.end(await response.text())
      })
    },
  }
}

export default defineConfig({
  base: '/agent-observability/',
  plugins: [react(), tailwindcss(), mockApiPlugin()],
  optimizeDeps: {
    include: [
      'recharts',
      'dayjs',
      'lucide-react',
      'wavesurfer.js',
      '@tanstack/react-table',
      'nuqs',
    ],
  },
  resolve: {
    dedupe: ['react', 'react-dom', 'nuqs', '@tanstack/react-table'],
    alias: [
      // shadcn UI — local to preview
      { find: '@/components/ui', replacement: resolve(__dirname, 'src/components/ui') },
      { find: '@/lib/utils', replacement: resolve(__dirname, 'src/lib/utils.ts') },

      // Registry lib items
      { find: '@/lib/observability-types', replacement: reg('observability-types/types.ts') },
      { find: '@/lib/observability-format', replacement: reg('observability-format/format.ts') },
      { find: '@/lib/observability-api', replacement: reg('observability-api/api.ts') },
      { find: '@/lib/observability-provider', replacement: reg('observability-provider/provider.tsx') },
      { find: '@/lib/observability-hooks', replacement: reg('observability-hooks/hooks.ts') },

      // Registry data-table (tablecn) — shared by sessions-page, evals-page, eval-run-detail-page
      { find: '@/components/data-table', replacement: reg('data-table') },
      { find: '@/hooks/use-data-table', replacement: reg('data-table/use-data-table.ts') },
      { find: '@/hooks/use-debounced-callback', replacement: reg('data-table/use-debounced-callback.ts') },
      { find: '@/hooks/use-callback-ref', replacement: reg('data-table/use-callback-ref.ts') },
      { find: '@/lib/parsers', replacement: reg('data-table/parsers.ts') },
      { find: '@/lib/data-table', replacement: reg('data-table/data-table-utils.ts') },
      { find: '@/types/data-table', replacement: reg('data-table/types.ts') },
      { find: '@/config/data-table', replacement: reg('data-table/data-table-config.ts') },

      // Registry components
      { find: '@/components/observability-chart-shared', replacement: reg('observability-chart-shared/chart-shared.tsx') },
      { find: '@/components/metric-summary-cards', replacement: reg('metric-summary-cards/metric-summary-cards.tsx') },
      { find: '@/components/latency-percentiles-chart', replacement: reg('latency-percentiles-chart/latency-percentiles-chart.tsx') },
      { find: '@/components/pipeline-breakdown-chart', replacement: reg('pipeline-breakdown-chart/pipeline-breakdown-chart.tsx') },
      { find: '@/components/latency-over-turns-chart', replacement: reg('latency-over-turns-chart/latency-over-turns-chart.tsx') },
      { find: '@/components/token-usage-section', replacement: reg('token-usage-section/token-usage-section.tsx') },
      { find: '@/components/talk-time-chart', replacement: reg('talk-time-chart/talk-time-chart.tsx') },
      { find: '@/components/cache-efficiency-chart', replacement: reg('cache-efficiency-chart/cache-efficiency-chart.tsx') },
      { find: '@/components/llm-throughput-chart', replacement: reg('llm-throughput-chart/llm-throughput-chart.tsx') },
      { find: '@/components/session-header', replacement: reg('session-header/session-header.tsx') },
      { find: '@/components/turn-transcript', replacement: reg('turn-transcript/turn-transcript.tsx') },
      { find: '@/components/session-timeline', replacement: reg('session-timeline') },
      { find: '@/components/session-events', replacement: reg('session-events/session-events.tsx') },
      { find: '@/components/session-config', replacement: reg('session-config/session-config.tsx') },
      { find: '@/components/sessions-page', replacement: reg('sessions-page/sessions-page.tsx') },
      { find: '@/components/session-detail-page', replacement: reg('session-detail-page/session-detail-page.tsx') },
      { find: '@/components/evals-page', replacement: reg('evals-page/evals-page.tsx') },
      { find: '@/components/eval-run-detail-page', replacement: reg('eval-run-detail-page/eval-run-detail-page.tsx') },
      { find: '@/components/eval-case-detail-page', replacement: reg('eval-case-detail-page/eval-case-detail-page.tsx') },

      // Fallback — regex so it doesn't outprioritize specific string matches
      { find: /^@\//, replacement: resolve(__dirname, 'src') + '/' },
    ],
  },
})
