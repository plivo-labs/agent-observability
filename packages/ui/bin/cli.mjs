#!/usr/bin/env node

import { execSync } from 'child_process'

const REGISTRY_URL =
  process.env.AGENT_OBS_REGISTRY_URL ||
  'https://raw.githubusercontent.com/plivo-labs/agent-observability/main/packages/ui/public/r'

const [command, ...args] = process.argv.slice(2)

function printUsage() {
  console.log(`
  Usage: npx agent-observability-ui <command> [options]

  Commands:
    add <component...>   Install one or more components into your project

  Examples:
    npx agent-observability-ui add metric-summary-cards
    npx agent-observability-ui add session-detail-page
    npx agent-observability-ui add session-timeline turn-transcript

  Available components:
    observability-types          TypeScript types
    observability-format         Formatting utilities
    observability-api            API client factory
    observability-provider       React context provider
    observability-hooks          Data hooks (useSessions, useSession, etc.)
    metric-summary-cards         6-stat card grid
    latency-percentiles-chart    Avg/P95 latency bar chart
    pipeline-breakdown-chart     STT/LLM/TTS time breakdown
    latency-over-turns-chart     Per-turn latency line chart
    token-usage-section          Token pie chart + stats
    talk-time-chart              User vs agent talk time
    cache-efficiency-chart       LLM cache hit ratio
    llm-throughput-chart         Token generation speed
    session-header               Session metadata display
    turn-transcript              Conversation transcript
    session-timeline             Audio waveform + trace
    sessions-page                Sessions list page
    session-detail-page          Full dashboard (installs everything)
`)
}

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printUsage()
  process.exit(0)
}

if (command !== 'add') {
  console.error(`Unknown command: ${command}\n`)
  printUsage()
  process.exit(1)
}

if (args.length === 0) {
  console.error('No components specified.\n')
  printUsage()
  process.exit(1)
}

const urls = args
  .filter((a) => !a.startsWith('-'))
  .map((name) => `${REGISTRY_URL}/${name}.json`)

const flags = args.filter((a) => a.startsWith('-')).join(' ')

const cmd = `npx shadcn@latest add ${urls.join(' ')} ${flags}`.trim()

try {
  execSync(cmd, { stdio: 'inherit' })
} catch {
  process.exit(1)
}
