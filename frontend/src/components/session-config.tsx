import { Settings2 } from 'lucide-react'
import { useOptions } from '@/lib/observability-hooks'

export const SessionConfig = () => {
  const options = useOptions()

  if (options == null) {
    return (
      <div className="ao-empty">
        <div className="ao-empty-icon">
          <Settings2 />
        </div>
        <div className="ao-empty-title">No options</div>
        <div className="ao-empty-text">No options were captured for this session.</div>
      </div>
    )
  }

  return (
    <section className="ao-panel">
      <div className="ao-panel-head">
        <div className="ao-panel-title">
          <Settings2 /> Session options
        </div>
      </div>
      <div className="ao-panel-body">
        <pre className="m-0 overflow-auto rounded-md border border-border bg-[hsl(var(--bg2))] p-4 font-mono text-xs leading-relaxed text-[hsl(var(--secondary))]">
          {JSON.stringify(options, null, 2)}
        </pre>
      </div>
    </section>
  )
}
