import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const reg = (...segments: string[]) =>
  resolve(__dirname, '../registry/new-york', ...segments)

const mockDataPath = resolve(__dirname, 'src/mock-data.json')

function mockApiPlugin() {
  return {
    name: 'mock-api',
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        if (!req.url?.startsWith('/api/')) return next()

        const mockData = JSON.parse(readFileSync(mockDataPath, 'utf-8'))
        res.setHeader('Content-Type', 'application/json')

        if (req.url === '/api/sessions' || req.url?.startsWith('/api/sessions?')) {
          res.end(JSON.stringify({
            api_id: 'preview-mock',
            meta: { limit: 20, offset: 0, total_count: mockData.sessions.length, next: null, previous: null },
            objects: mockData.sessions,
          }))
        } else if (req.url?.match(/^\/api\/sessions\/[^?]+$/)) {
          const id = req.url.split('/api/sessions/')[1]
          const session = mockData.sessions.find((s: any) => s.session_id === id) ?? mockData.sessions[0]
          res.end(JSON.stringify(session))
        } else if (req.url === '/api/evals' || req.url?.startsWith('/api/evals?')) {
          const runs = (mockData.evals ?? []).map((r: any) => {
            const { cases: _cases, ...row } = r
            return row
          })
          res.end(JSON.stringify({
            api_id: 'preview-mock',
            meta: { limit: 20, offset: 0, total_count: runs.length, next: null, previous: null },
            objects: runs,
          }))
        } else if (req.url?.match(/^\/api\/evals\/[^/?]+\/cases\/[^?]+$/)) {
          const m = req.url.match(/^\/api\/evals\/([^/?]+)\/cases\/([^?]+)$/)
          const runId = m?.[1]
          const caseId = m?.[2]
          const run = (mockData.evals ?? []).find((r: any) => r.run_id === runId)
          const c = run?.cases?.find((x: any) => x.case_id === caseId) ?? run?.cases?.[0]
          if (!c) { res.statusCode = 404; res.end(JSON.stringify({ error: 'Not found' })); return }
          res.end(JSON.stringify({ ...c, api_id: 'preview-mock' }))
        } else if (req.url?.match(/^\/api\/evals\/[^/?]+$/)) {
          const runId = req.url.split('/api/evals/')[1].split('?')[0]
          const run = (mockData.evals ?? []).find((r: any) => r.run_id === runId) ?? (mockData.evals ?? [])[0]
          if (!run) { res.statusCode = 404; res.end(JSON.stringify({ error: 'Not found' })); return }
          res.end(JSON.stringify({ ...run, api_id: 'preview-mock' }))
        } else {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'Not found' }))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mockApiPlugin()],
  optimizeDeps: {
    include: ['recharts', 'dayjs', 'lucide-react', 'wavesurfer.js'],
  },
  resolve: {
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
