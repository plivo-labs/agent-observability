import { useState } from 'react'
import type { Table } from '@tanstack/react-table'

/**
 * Shared bulk-delete state machine for the selectable list pages
 * (sessions, eval runs). Owns the confirm-dialog open state, the in-flight /
 * error flags, and the delete handler — which calls the caller-supplied
 * `deleteFn` with the selected row ids, then resets selection + refetches.
 *
 * Selection is read straight off the table's row-selection state, so the ids
 * are the table `getRowId` values (session_id / run_id).
 */
export function useBulkDelete<TData>({
  table,
  deleteFn,
  refetch,
}: {
  table: Table<TData>
  deleteFn: (ids: string[]) => Promise<unknown>
  refetch: () => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const selectedIds = Object.keys(table.getState().rowSelection)
  const selectedCount = selectedIds.length

  const handleDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteFn(selectedIds)
      table.resetRowSelection()
      refetch()
      setConfirmOpen(false)
    } catch (e) {
      setDeleteError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  return {
    confirmOpen,
    setConfirmOpen,
    deleting,
    deleteError,
    selectedIds,
    selectedCount,
    handleDelete,
    cancelSelection: () => table.resetRowSelection(),
  }
}
