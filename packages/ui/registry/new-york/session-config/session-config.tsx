import { Settings2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useOptions } from '@/lib/observability-hooks'

export const SessionConfig = () => {
  const options = useOptions()

  if (options == null) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No options captured for this session.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 size={14} className="text-muted-foreground" />
          Session options
        </CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="overflow-auto rounded-md border bg-muted/30 p-3 text-xs font-mono leading-relaxed">
          {JSON.stringify(options, null, 2)}
        </pre>
      </CardContent>
    </Card>
  )
}
