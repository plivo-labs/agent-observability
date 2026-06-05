import { Tab, Tabs } from 'fumadocs-ui/components/tabs'
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock'

// ─── InstallTabs ───────────────────────────────────────────────────────────
// Reproduces docs/src/App.tsx's <InstallBlock>: tabbed pnpm/npm/yarn/bun, each
// showing the shadcn-registry install command with the correct per-manager
// prefix. Built on Fumadocs <Tabs>/<Tab> (simple mode) so it inherits the theme,
// the copy button, and persisted tab selection.
//
// Fumadocs' built-in `package-install` only knows `npm i <pkg>` shapes — it
// CANNOT express `npx … add <pkg>`, so this is necessarily custom.

const MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const

// Exact prefix map copied from App.tsx's InstallBlock.
const PREFIX: Record<(typeof MANAGERS)[number], string> = {
  pnpm: 'pnpm dlx',
  npm: 'npx',
  yarn: 'yarn dlx',
  bun: 'bunx --bun',
}

export function InstallTabs({ pkg }: { pkg: string }) {
  return (
    <Tabs items={[...MANAGERS]}>
      {MANAGERS.map((m) => (
        <Tab key={m} value={m}>
          <DynamicCodeBlock
            lang="bash"
            code={`${PREFIX[m]} agent-observability-ui@latest add ${pkg}`}
          />
        </Tab>
      ))}
    </Tabs>
  )
}

// ─── PropsTable / ParamsTable ──────────────────────────────────────────────
// Reproduces App.tsx's <PropsTable>: Prop / Type / Default / Description columns
// with a "accepts no props" empty state. Authoring API is a tidy `rows` array.
// ParamsTable is the hooks variant — titled "Parameters" with the same shape
// (mirrors App.tsx, where group === 'Hooks' renders the section as "Parameters").

export interface PropRow {
  name: string
  type: string
  default?: string
  required?: boolean
  description: string
}

function PropsTableBase({
  rows,
  variant,
}: {
  rows: PropRow[]
  variant: 'props' | 'params'
}) {
  const nameHeader = variant === 'params' ? 'Parameter' : 'Prop'
  if (rows.length === 0) {
    return (
      <p className="text-sm text-fd-muted-foreground">
        {variant === 'params'
          ? 'This hook takes no parameters.'
          : 'This component accepts no props.'}
      </p>
    )
  }
  return (
    <div className="not-prose my-4 overflow-x-auto rounded-lg border border-fd-border">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-fd-border bg-fd-muted/50">
          <tr>
            <th className="px-4 py-2 font-medium">{nameHeader}</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Default</th>
            <th className="px-4 py-2 font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b border-fd-border/60 last:border-0 align-top">
              <td className="px-4 py-2 whitespace-nowrap">
                <code className="text-fd-foreground">{r.name}</code>
                {r.required && (
                  <span className="ml-1 text-xs font-medium text-fd-primary">
                    required
                  </span>
                )}
              </td>
              <td className="px-4 py-2">
                <code className="text-fd-muted-foreground">{r.type}</code>
              </td>
              <td className="px-4 py-2">
                {r.default ? (
                  <code className="text-fd-muted-foreground">{r.default}</code>
                ) : (
                  <span className="text-fd-muted-foreground">—</span>
                )}
              </td>
              <td className="px-4 py-2 text-fd-muted-foreground">{r.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PropsTable({ rows }: { rows: PropRow[] }) {
  return <PropsTableBase rows={rows} variant="props" />
}

export function ParamsTable({ rows }: { rows: PropRow[] }) {
  return <PropsTableBase rows={rows} variant="params" />
}
