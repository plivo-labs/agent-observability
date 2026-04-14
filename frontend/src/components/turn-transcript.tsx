import { useEffect, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import { Bot, CircleDot, Code2, MessageSquare, User, Zap } from 'lucide-react'
import { formatMs } from '@/lib/format'
import type { ChatItem, SessionMetrics, TurnRecord } from '@/lib/types'

const LatencyPill = ({ label, ms }: { label: string; ms: number | undefined }) => {
  if (ms == null) return null
  const color =
    ms < 200
      ? 'text-green-600 bg-green-500/10'
      : ms < 500
        ? 'text-yellow-600 bg-yellow-500/10'
        : 'text-red-500 bg-red-500/10'
  return (
    <span
      title={`${label}: ${formatMs(ms)}`}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono tabular-nums ${color}`}
    >
      {label}&nbsp;&nbsp;|&nbsp;&nbsp;{formatMs(ms)}
    </span>
  )
}

const TurnCard = ({ turn, highlighted, turnRef }: { turn: TurnRecord; highlighted?: boolean; turnRef?: React.Ref<HTMLDivElement> }) => {
  const isAgentFirst = turn.agent_first

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
      <div className="flex-1 pb-5 min-w-0">
        {/* Turn badges row */}
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
          {turn.tool_calls && turn.tool_calls.length > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              <Code2 size={10} className="mr-0.5" />
              {turn.tool_calls.length} tool call{turn.tool_calls.length > 1 ? 's' : ''}
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1">
            <LatencyPill label="Perceived" ms={turn.user_perceived_ms} />
            <LatencyPill label="STT" ms={turn.stt_delay_ms} />
            <LatencyPill label="LLM TTFT" ms={turn.llm_ttft_ms} />
            <LatencyPill label="TTS" ms={turn.tts_ttfb_ms} />
          </div>
        </div>

        {/* Messages */}
        <div className="flex flex-col gap-2">
          {turn.user_text && (
            <div className="flex items-start gap-2 max-w-[85%]">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted mt-0.5">
                <User size={11} className="text-muted-foreground" />
              </div>
              <div className="rounded-lg rounded-tl-sm bg-muted px-3 py-2">
                <span className="text-s-400">{turn.user_text}</span>
              </div>
            </div>
          )}
          {turn.agent_text && (
            <div className="flex items-start gap-2 max-w-[85%] self-end flex-row-reverse">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 mt-0.5">
                <Bot size={11} className="text-primary" />
              </div>
              <div className="rounded-lg rounded-tr-sm bg-primary/10 px-3 py-2">
                <span className="text-s-400">{turn.agent_text}</span>
              </div>
            </div>
          )}

          {/* Tool calls */}
          {turn.tool_calls?.map((tc, i) => (
            <div key={i} className="ml-7 flex items-start gap-2">
              <CircleDot size={12} className="text-muted-foreground mt-1.5 shrink-0" />
              <div className="rounded border border-dashed bg-muted/50 px-3 py-1.5 text-xs font-mono w-fit">
                <span className="text-primary">{tc.name}</span>
                <span className="text-muted-foreground">(</span>
                <span className="text-foreground">{JSON.stringify(tc.arguments)}</span>
                <span className="text-muted-foreground">)</span>
                {tc.output != null && (
                  <>
                    <span className="text-muted-foreground"> → </span>
                    <span className={tc.is_error ? 'text-red-500' : 'text-green-600'}>
                      {tc.output}
                    </span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Token stats for turn — below agent bubble, right-aligned */}
        {((turn.llm_total_tokens ?? 0) > 0 || (turn.tts_characters ?? 0) > 0) && (
          <div className="mt-1 flex items-center justify-end gap-3 text-[10px] text-muted-foreground mr-7">
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
        <p className="text-s-400 leading-relaxed">{content}</p>
      </div>
    </div>
  )
}

export const TurnTranscriptSection = ({
  chatHistory,
  metrics,
  highlightedTurn,
  embedded,
}: {
  chatHistory: ChatItem[] | null
  metrics: SessionMetrics | null
  highlightedTurn?: number | null
  embedded?: boolean
}) => {
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
            />
          ))}
        </div>
      </>
    )

    if (embedded) return content
    return <div className="rounded-lg border p-5">{content}</div>
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
