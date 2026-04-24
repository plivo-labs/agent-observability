import { flexRender, type Row, type Table as TanstackTable } from "@tanstack/react-table";
import type * as React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { cn } from "@/lib/utils";

interface ObsDataTableProps<TData> extends React.ComponentProps<"div"> {
  table: TanstackTable<TData>;
  /** Rendered above the table — filters, search, view menu. */
  toolbar?: React.ReactNode;
  onRowClick?: (row: Row<TData>) => void;
  /** Total row count across all pages. Required when the table uses
   *  manual pagination — tanstack's filteredRowModel only reflects the
   *  current page's rows in that mode, so the footer count would be wrong. */
  totalRowCount?: number;
  /** Shows skeleton rows in the body when true. Prevents layout shift vs
   *  an above-the-table "Loading…" banner. */
  loading?: boolean;
}

export function ObsDataTable<TData>({
  table,
  toolbar,
  onRowClick,
  totalRowCount,
  loading,
  className,
  ...props
}: ObsDataTableProps<TData>) {
  const rows = table.getRowModel().rows;
  const pageSize = table.getState().pagination.pageSize;
  const showSkeletons = loading && rows.length === 0;

  return (
    <div
      className={cn("flex w-full flex-col gap-2.5 overflow-auto", className)}
      {...props}
    >
      {toolbar}
      <div className="overflow-hidden rounded-md border bg-card shadow-sm">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead key={header.id} colSpan={header.colSpan}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {showSkeletons ? (
              Array.from({ length: Math.min(pageSize, 8) }).map((_, i) => (
                <TableRow key={`sk-${i}`} aria-hidden="true">
                  {table.getAllLeafColumns().map((col) => (
                    <TableCell key={col.id}>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={table.getAllLeafColumns().length}
                  className="h-24 text-center text-muted-foreground"
                >
                  No results.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  className={onRowClick ? "cursor-pointer hover:bg-muted/50" : undefined}
                  onClick={
                    onRowClick
                      ? (e) => {
                          const t = e.target as HTMLElement;
                          if (t.closest('button, a, input, select, [role="menuitem"]')) return;
                          onRowClick(row);
                        }
                      : undefined
                  }
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <DataTablePagination table={table} totalRowCount={totalRowCount} />
    </div>
  );
}
