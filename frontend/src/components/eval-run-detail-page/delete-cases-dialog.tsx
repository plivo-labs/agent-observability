import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export function DeleteCasesDialog({
  open,
  onOpenChange,
  count,
  deleting,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  deleting: boolean
  error: string | null
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !deleting && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Delete {count} case{count === 1 ? '' : 's'}?
          </DialogTitle>
          <DialogDescription>
            This permanently removes the selected case{count === 1 ? '' : 's'} and
            every event and judgment captured under {count === 1 ? 'it' : 'them'}.
            This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="text-s-400 text-[hsl(var(--destructive))]">
            Failed to delete: {error}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="text-[hsl(var(--destructive))] border-[hsl(var(--destructive-border))] hover:bg-[hsl(var(--destructive-bg))]"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : `Delete ${count}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
