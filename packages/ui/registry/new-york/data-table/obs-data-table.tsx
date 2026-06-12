import { Fragment } from "react";
import type * as React from "react";
import { flexRender, type Row, type Table as TanstackTable } from "@tanstack/react-table";
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
  /** Optional full-width detail line rendered under a data row (e.g. a
   *  search-match snippet). Only rows where this returns non-null get the
   *  extra line; it shares the parent row's click handling so the pair
   *  reads as one clickable unit. */
  renderRowDetail?: (row: Row<TData>) => React.ReactNode;
}

export function ObsDataTable<TData>({
  table,
  toolbar,
  onRowClick,
  totalRowCount,
  loading,
  renderRowDetail,
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
      {/*
        Edge columns get `pl-4` / `pr-4` so the first and last cells don't
        crash into the card border — the stock shadcn TableCell ships with
        `p-2` on every cell, which reads as "no padding" against the card
        edge. Inner cells keep their default 2-unit horizontal padding.
      */}
      <div className="overflow-hidden rounded-none border border-border bg-card shadow-none [&_tr>:first-child]:pl-4 [&_tr>:last-child]:pr-4">
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
                      {/* The row-select column renders a checkbox, so a
                       *  full-width pill leaves a confusing gap. Match the
                       *  checkbox footprint instead. */}
                      <Skeleton
                        className={col.id === "select" ? "h-4 w-4 rounded-sm" : "h-4 w-24"}
                      />
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
              rows.map((row) => {
                const detail = renderRowDetail?.(row) ?? null;
                const handleClick = onRowClick
                  ? (e: React.MouseEvent) => {
                      const t = e.target as HTMLElement;
                      if (t.closest('button, a, input, select, [role="menuitem"]')) return;
                      onRowClick(row);
                    }
                  : undefined;
                return (
                  <Fragment key={row.id}>
                    <TableRow
                      data-state={row.getIsSelected() ? "selected" : undefined}
                      className={cn(
                        onRowClick && "cursor-pointer hover:bg-muted/50",
                        // The detail line belongs to this row — drop the
                        // divider between them and pair the hover states so
                        // the two <tr>s read as one unit.
                        detail != null && "border-b-0 has-[+tr:hover]:bg-muted/50",
                      )}
                      onClick={handleClick}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                    {detail != null && (
                      // Hover styling pairs with the parent row via
                      // adjacent-sibling selectors so the two <tr>s light
                      // up as one unit.
                      <TableRow
                        data-state={row.getIsSelected() ? "selected" : undefined}
                        className={cn(
                          onRowClick && "cursor-pointer hover:bg-muted/50 [:where(tr:hover)+&]:bg-muted/50",
                        )}
                        onClick={handleClick}
                      >
                        <TableCell
                          colSpan={row.getVisibleCells().length}
                          className="pt-0 pb-2.5"
                        >
                          {detail}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <DataTablePagination table={table} totalRowCount={totalRowCount} />
    </div>
  );
}
