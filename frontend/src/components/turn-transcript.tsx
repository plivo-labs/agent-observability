import { useEffect, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import { Bot, Code2, MessageSquare, User, Zap } from 'lucide-react'
import { formatMs } from '@/lib/observability-format'
import type { ChatItem, SessionMetrics, TurnRecord } from '@/lib/observability-types'
import { useTranscript } from '@/lib/observability-hooks'

const LatencyPill = ({ label, ms }: { label: string; ms: number | undefined }) => {
  if (ms == null) return null
  // Monochrome: fast / ok / slow are signalled via weight + border, not hue.
  const tone =
    ms < 200
      ? 'text-foreground border border-border bg-background'
      : ms < 500
        ? 'text-foreground border border-border bg-muted/50'
        : 'text-foreground border border-foreground bg-muted font-semibold'
  return (
    <span
      title={`${label}: ${formatMs(ms)}`}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono tabular-nums ${tone}`}
    >
      {label}&nbsp;&nbsp;|&nbsp;&nbsp;{formatMs(ms)}
    </span>
  )
}

export type TranscriptAlignment = 'chat' | 'left'

const TurnCard = ({ turn, highlighted, turnRef, alignment = 'chat' }: { turn: TurnRecord; highlighted?: boolean; turnRef?: React.Ref<HTMLDivElement>; alignment?: TranscriptAlignment }) => {
  const isAgentFirst = turn.agent_first
  const isChat = alignment === 'chat'

  return (
    <div
      ref={turnRef}
      className={`group relative flex gap-3 transition-colors duration-500 rounded-lg ${highlighted ? 'bg-primary/5 ring-1 ring-primary/20' : ''}`}
    >
      {/* Timeline connector */}
      <div className="flex flex-col items-center pt-1">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-card text-xs text-muted-foreground">
          {turn.turn_number}
        </div>
        <div className="w-px flex-1 bg-border" />
      </div>

      {/* Content */}
      <div className="flex-1 pb-8 min-w-0">
        {/* Turn badges row — only flags that aren't otherwise visible in the
            layout below. Tool-call count was removed because each tool call
            renders its own detailed card under the assistant message; the
            badge at the top made it look like the user had called a tool. */}
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          {turn.interrupted && (
            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
              <Zap size={10} className="mr-0.5" />
              Interrupted
            </Badge>
          )}
          {isAgentFirst && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              <Bot size={10} className="mr-0.5" />
              Agent initiated
            </Badge>
          )}
        </div>

        {/* Messages */}
        <div className="flex flex-col gap-2">
          {turn.user_text && (
            <div className="flex items-start gap-2 max-w-[85%]">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted mt-0.5">
                <User size={11} className="text-muted-foreground" />
              </div>
              <div className="rounded-lg rounded-tl-sm bg-muted px-3 py-2">
                <span className="text-xs">{turn.user_text}</span>
              </div>
            </div>
          )}
          {/* Tool calls — rendered BEFORE the agent message so the visual
              order matches the causal order: user asked → agent called tool
              → agent replied with the result. */}
          {turn.tool_calls?.map((tc, i) => (
            <div key={i} className={`rounded-lg border bg-muted/30 overflow-hidden w-fit max-w-[85%] ${isChat ? 'self-end mr-7' : ''}`}>
              <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b">
                <Code2 size={12} className="text-primary shrink-0" />
                <span className="text-xs font-semibold text-primary">{tc.name}</span>
                {tc.is_error && <span className="text-[10px] text-foreground font-semibold uppercase tracking-wider">failed</span>}
              </div>
              <div className="px-3 py-2 space-y-1.5">
                <div>
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Arguments</span>
                  <div className="mt-1 text-xs font-mono space-y-0.5">
                    {Object.entries(tc.arguments).map(([key, val]) => (
                      <div key={key} className="flex gap-2">
                        <span className="text-muted-foreground shrink-0">{key}:</span>
                        <span className="text-foreground">{typeof val === 'string' ? val : JSON.stringify(val)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {tc.output != null && (
                  <div>
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Output</span>
                    <pre className={`mt-1 text-xs font-mono whitespace-pre-wrap break-all ${tc.is_error ? 'text-foreground font-semibold' : 'text-foreground'}`}>
                      {tc.output}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          ))}

          {turn.agent_text && (
            <div className={`flex items-start gap-2 max-w-[85%] ${isChat ? 'self-end flex-row-reverse' : ''}`}>
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 mt-0.5">
                <Bot size={11} className="text-primary" />
              </div>
              <div className={`rounded-lg px-3 py-2 bg-primary/10 ${isChat ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}>
                <span className="text-xs">{turn.agent_text}</span>
              </div>
            </div>
          )}

          {/* Latency pills — agent response pipeline */}
          {(turn.user_perceived_ms != null || turn.stt_delay_ms != null || turn.llm_ttft_ms != null || turn.tts_ttfb_ms != null) && (
            <div className={`flex items-center gap-1 flex-wrap ${isChat ? 'justify-end mr-7' : ''}`}>
              <LatencyPill label="Perceived" ms={turn.user_perceived_ms} />
              <LatencyPill label="STT" ms={turn.stt_delay_ms} />
              <LatencyPill label="LLM TTFT" ms={turn.llm_ttft_ms} />
              <LatencyPill label="TTS" ms={turn.tts_ttfb_ms} />
            </div>
          )}
        </div>

        {/* Token stats for turn */}
        {((turn.llm_total_tokens ?? 0) > 0 || (turn.tts_characters ?? 0) > 0) && (
          <div className={`mt-1 flex items-center gap-3 text-[10px] text-muted-foreground ${isChat ? 'justify-end mr-7' : ''}`}>
            {turn.llm_prompt_tokens != null && <span>{turn.llm_prompt_tokens.toLocaleString()} prompt</span>}
            {turn.llm_completion_tokens != null && <span>{turn.llm_completion_tokens.toLocaleString()} completion</span>}
            {turn.tts_characters != null && turn.tts_characters > 0 && <span>{turn.tts_characters} TTS chars</span>}
          </div>
        )}
      </div>
    </div>
  )
}

const ChatMessageCard = ({ item }: { item: ChatItem }) => {
  const role = item.role ?? item.message?.role ?? 'unknown'
  const rawContent = item.content ?? item.message?.content ?? ''
  const content = Array.isArray(rawContent) ? rawContent.join(' ') : rawContent
  const isUser = role === 'user'

  return (
    <div className="flex gap-3 py-2">
      <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full mt-0.5 ${
        isUser ? 'bg-muted' : 'bg-primary/15'
      }`}>
        {isUser ? <User size={11} className="text-muted-foreground" /> : <Bot size={11} className="text-primary" />}
      </div>
      <div>
        <span className="text-xxs-400 text-muted-foreground capitalize">{role}</span>
        <p className="text-xs leading-relaxed">{content}</p>
      </div>
    </div>
  )
}

export const TurnTranscriptSection = ({
  chatHistory: chatHistoryProp,
  metrics: metricsProp,
  highlightedTurn: highlightedTurnProp,
  embedded,
  alignment = 'chat',
}: {
  chatHistory?: ChatItem[] | null
  metrics?: SessionMetrics | null
  highlightedTurn?: number | null
  embedded?: boolean
  alignment?: TranscriptAlignment
}) => {
  const hook = useTranscript()
  const chatHistory = chatHistoryProp ?? hook.chatHistory
  const metrics = metricsProp ?? hook.metrics
  const highlightedTurn = highlightedTurnProp ?? hook.highlightedTurn

  const turnRefs = useRef<Record<number, HTMLDivElement | null>>({})

  useEffect(() => {
    if (highlightedTurn == null) return
    const el = turnRefs.current[highlightedTurn]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [highlightedTurn])

  // If we have structured turn data from metrics, show that
  if (metrics?.turns?.length) {
    const content = (
      <>
        <div className="flex items-center gap-2 mb-5">
          <MessageSquare size={15} className="text-muted-foreground" />
          <span className="text-s-400 font-medium">Conversation</span>
          <span className="text-xs text-muted-foreground">
            {metrics.turns.length} turn{metrics.turns.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="mx-auto max-w-3xl flex flex-col">
          {metrics.turns.map((turn, i) => (
            <TurnCard
              key={turn.turn_id || i}
              turn={turn}
              highlighted={highlightedTurn === turn.turn_number}
              turnRef={(el) => { turnRefs.current[turn.turn_number] = el }}
              alignment={alignment}
            />
          ))}
        </div>
      </>
    )

    if (embedded) return content
    return <div className="rounded-lg border bg-card p-5">{content}</div>
  }

  // Fallback to raw chat history
  if (chatHistory?.length) {
    const messages = chatHistory.filter((item) => item.type === 'message')
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MessageSquare size={15} className="text-muted-foreground" />
          <span className="text-s-400 font-medium">Transcript</span>
          <span className="text-xs text-muted-foreground">({messages.length} messages)</span>
        </div>
        <div className="space-y-1 max-h-[600px] overflow-y-auto">
          {messages.map((item, i) => (
            <ChatMessageCard key={item.id || i} item={item} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center p-12 text-muted-foreground text-s-400">
      No turn data available
    </div>
  )
}
