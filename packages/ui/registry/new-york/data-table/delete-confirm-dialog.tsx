import type { ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** Destructive-button styling shared by the toolbar Delete and the dialog
 * confirm — token-tinted text/border/hover, current-color icon. */
const DESTRUCTIVE_BUTTON =
  'text-[hsl(var(--destructive))] [&_svg]:text-current hover:[&_svg]:text-current border-[hsl(var(--destructive-border))] hover:bg-[hsl(var(--destructive-bg))]'

/**
 * "N selected … Cancel / Delete" selection toolbar shared by the list pages.
 * Built on the `ao-toolbar` / `ao-badge` primitives so sessions + evals read
 * identically. Renders nothing when no rows are selected.
 */
export function SelectionToolbar({
  count,
  onCancel,
  onDelete,
  className,
}: {
  count: number
  onCancel: () => void
  onDelete: () => void
  className?: string
}) {
  if (count <= 0) return null
  return (
    <div className={className ? `ao-toolbar ${className}` : 'ao-toolbar'}>
      <span className="ao-badge is-accent">
        <b>{count}</b>&nbsp;selected
      </span>
      <span className="ao-toolbar-spacer" />
      <Button variant="outline" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button
        variant="outline"
        size="sm"
        className={DESTRUCTIVE_BUTTON}
        onClick={onDelete}
      >
        <Trash2 /> Delete
      </Button>
    </div>
  )
}

/**
 * Confirm dialog for the bulk-delete flow. Title + description are passed in
 * so each page keeps its own copy (sessions vs eval runs); the destructive
 * confirm button, error surface, and disabled-while-deleting behavior are
 * shared.
 */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  deleting,
  deleteError,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  deleting: boolean
  deleteError: string | null
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !deleting && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {deleteError && (
          <div className="text-s-400 text-[hsl(var(--destructive))]">
            Failed to delete: {deleteError}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="text-[hsl(var(--destructive))] border-[hsl(var(--destructive-border))] hover:bg-[hsl(var(--destructive-bg))]"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
