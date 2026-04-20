# agent-observability-ui

shadcn registry for agent observability dashboard components. Components auto-connect to data via a provider and hooks — zero props needed by default. Consumers install individual components or the full dashboard via `npx shadcn add`.

## Architecture

```
AgentObservabilityProvider (baseUrl, sessionId?)
├── useSessions()      → paginated session list
├── useSession()       → current session from context
├── useTimeline()      → timeline data (metrics, recording, highlighted turn)
├── useTranscript()    → transcript data (turns, chat history)
└── usePerformance()   → performance metrics and summary
```

Components use hooks internally. Wrap your app in the provider and render components with zero props — or use hooks directly for custom UI.

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- A running [agent-observability](../../README.md) server (for the API)

### Install dependencies

```bash
cd packages/ui
bun install
```

### Build the registry

```bash
npx shadcn build
```

This generates `public/r/*.json` files — one per registry item.

### Serve locally

```bash
cd packages/ui && npx serve public -p 3001
```

### Install into a consumer project

```bash
# Individual components
npx agent-observability-ui@latest add metric-summary-cards
npx agent-observability-ui@latest add session-timeline

# Multiple at once
npx agent-observability-ui@latest add session-timeline turn-transcript

# Full dashboard (installs all transitive dependencies)
npx agent-observability-ui@latest add session-detail-page
```

### Local development

To test installation from a local registry build:

```bash
cd packages/ui && npx serve public -p 3001

# Then from your consumer project:
npx shadcn add http://localhost:3001/r/metric-summary-cards.json
```

## Usage

### Provider + auto-connected components

Wrap your app in `AgentObservabilityProvider`. The `baseUrl` prop is required — it points to your observability server's API.

```tsx
import { AgentObservabilityProvider } from '@/lib/observability-provider'
import { SessionDetailPage } from '@/components/session-detail-page'

function App() {
  return (
    <AgentObservabilityProvider baseUrl="https://your-server.com/api" sessionId="abc123">
      <SessionDetailPage />
    </AgentObservabilityProvider>
  )
}
```

### Hooks for custom UI

Use hooks to get typed data and build your own interface:

```tsx
import { usePerformance, useTranscript } from '@/lib/observability-hooks'

function MyDashboard() {
  const { metrics, summary } = usePerformance()
  const { turns } = useTranscript()

  return (
    <div>
      <h1>{summary?.total_turns} turns, {summary?.total_tool_calls} tool calls</h1>
      {turns.map(t => (
        <p key={t.turn_number}>{t.agent_text}</p>
      ))}
    </div>
  )
}
```

### Mix and match

Every component accepts optional props to override hook data:

```tsx
// Auto-connect (reads from provider context)
<MetricSummaryCards />

// Manual override (ignores hook, uses provided data)
<MetricSummaryCards metrics={myCustomMetrics} />
```

## Available Hooks

| Hook | Returns |
|------|---------|
| `useSessions(limit?, offset?)` | `{ sessions, meta, loading, error, setOffset }` |
| `useSession()` | `{ session, loading, error }` |
| `useTimeline()` | `{ metrics, recordUrl, sessionCreatedAt, highlightedTurn, setHighlightedTurn }` |
| `useTranscript()` | `{ turns, chatHistory, metrics, highlightedTurn, setHighlightedTurn }` |
| `usePerformance()` | `{ metrics, summary }` |

## Available Components

### Charts
| Component | Description |
|-----------|-------------|
| `metric-summary-cards` | 6-stat card grid (turns, interruptions, tool calls, latency, tokens) |
| `latency-percentiles-chart` | Avg/P95 bar chart for STT, LLM, TTS latency |
| `pipeline-breakdown-chart` | Stacked bar showing time in STT/LLM/TTS/other |
| `latency-over-turns-chart` | Per-turn latency line chart |
| `token-usage-section` | Token pie chart + prompt/completion stats |
| `talk-time-chart` | User vs agent speaking duration per turn |
| `cache-efficiency-chart` | LLM prompt cache hit ratio over turns |
| `llm-throughput-chart` | Token generation speed (tok/s) over turns |

### Components
| Component | Description |
|-----------|-------------|
| `session-header` | Session metadata display (ID, capabilities, duration, dates) |
| `turn-transcript` | Conversation transcript with latency pills and tool calls |

### Component Props

All components accept optional props to override data from hooks. Below are additional configuration props:

#### `TurnTranscriptSection`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `chatHistory` | `ChatItem[] \| null` | from hook | Raw chat history (fallback if no structured turns) |
| `metrics` | `SessionMetrics \| null` | from hook | Session metrics with structured turn data |
| `highlightedTurn` | `number \| null` | from hook | Turn number to highlight and scroll to |
| `embedded` | `boolean` | `false` | Render without outer border (for embedding in other containers) |
| `alignment` | `'chat' \| 'left'` | `'chat'` | `chat`: user left, agent right. `left`: everything left-aligned |

```tsx
// Chat style (default) — user messages left, agent messages right
<TurnTranscriptSection />

// Left-aligned — all messages on the left
<TurnTranscriptSection alignment="left" />

// Embedded in a parent card without its own border
<TurnTranscriptSection embedded />
```

#### `SessionTimeline`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `metrics` | `SessionMetrics \| null` | from hook | Session metrics for trace visualization |
| `recordUrl` | `string \| null` | from hook | Audio recording URL for waveform player |
| `onTurnClick` | `(turnNumber: number) => void` | sets `highlightedTurn` | Callback when a turn is clicked in the trace |
| `sessionCreatedAt` | `string` | from hook | Session creation timestamp for recording offset |

#### `SessionHeader`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `session` | `AgentSessionRow` | from hook | Session data to display |

#### Chart Components

All chart components accept a single optional prop:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `metrics` | `SessionMetrics \| null` | from hook | Session metrics to visualize |
| `session-timeline` | Audio waveform player + turn-by-turn trace visualization |

### Pages
| Component | Description |
|-----------|-------------|
| `sessions-page` | Paginated sessions list table (requires react-router) |
| `session-detail-page` | Full dashboard with Session and Performance tabs (requires react-router) |

## Preview

A minimal app to showcase all components and pages with mock data:

```bash
cd packages/ui/preview
bun install
bun run dev
```

Opens at http://localhost:5174. The sidebar lets you browse individual components, charts, and full pages. The preview imports directly from registry source — changes to components reflect immediately with hot reload.

## Tests

```bash
cd packages/ui
bun test
```

Tests cover utility functions: `formatMs`, `formatDuration`, `formatDate`, `computeAvg`, `computePercentile`, `parseMs`, `computeTickInterval`, `computeSessionBounds`, and `createObservabilityApi`.

## Project Structure

```
packages/ui/
├── registry.json                    # Registry item definitions
├── registry/new-york/               # Component source (source of truth)
│   ├── observability-types/         # TypeScript types
│   ├── observability-format/        # Formatting utilities
│   ├── observability-api/           # API client factory
│   ├── observability-provider/      # React context provider
│   ├── observability-hooks/         # 5 data hooks
│   ├── observability-chart-shared/  # Shared chart wrappers
│   ├── metric-summary-cards/        # Chart components
│   ├── latency-percentiles-chart/
│   ├── pipeline-breakdown-chart/
│   ├── latency-over-turns-chart/
│   ├── token-usage-section/
│   ├── talk-time-chart/
│   ├── cache-efficiency-chart/
│   ├── llm-throughput-chart/
│   ├── session-header/              # Non-chart components
│   ├── turn-transcript/
│   ├── session-timeline/            # Multi-file (3 files)
│   ├── sessions-page/               # Page blocks
│   └── session-detail-page/
├── public/r/                        # Built registry JSON (committed; served via raw.githubusercontent.com)
├── tests/                           # Unit tests
├── preview/                         # Preview app
└── package.json
```

## Releasing

Releases are automated via GitHub Actions. See the [Releasing section in the root CLAUDE.md](../../CLAUDE.md#releasing) for the full flow.

TL;DR: bump `version` here → open PR → add label `release-ui-pkg` → merge to `main`. The `Publish UI Package` workflow publishes `bin/cli.mjs` to npm and cuts a `ui-v<version>` GitHub Release automatically.
