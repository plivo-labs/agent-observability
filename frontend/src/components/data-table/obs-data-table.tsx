import { flexRender, type Row, type Table as TanstackTable } from "@tanstack/react-table";
import type * as React from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

/**
 * Neo-styled DataTable — emits the `.obs-panel` / `.obs-toolbar` /
 * `.obs-table` / `.obs-paginate` structure that the design's CSS targets.
 *
 * Consumes the same TanStack `table` object that the default DataTable does;
 * pages can migrate to this one by swapping the import. Keeps every
 * behaviour (sorting, filters, column visibility, pagination) by reading
 * directly from tanstack state.
 */
interface ObsDataTableProps<TData> extends React.ComponentProps<"div"> {
  table: TanstackTable<TData>;
  /** Rendered inside `.obs-toolbar` above the table — filters, search, view menu. */
  toolbar?: React.ReactNode;
  onRowClick?: (row: Row<TData>) => void;
}

export function ObsDataTable<TData>({
  table,
  toolbar,
  onRowClick,
  className,
  ...props
}: ObsDataTableProps<TData>) {
  const rows = table.getRowModel().rows;
  const totalColumns = table.getAllLeafColumns().length;

  return (
    <div className={cx("obs-panel", className)} {...props}>
      {toolbar && <div className="obs-toolbar">{toolbar}</div>}
      <table className="obs-table">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => (
                <th key={header.id} colSpan={header.colSpan}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={totalColumns} style={{ textAlign: "center", padding: "40px 0", color: "hsl(var(--tertiary))" }}>
                No results.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={row.id}
                data-state={row.getIsSelected() ? "selected" : undefined}
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
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      <ObsPaginate table={table} />
    </div>
  );
}

/**
 * Matches the design's `.obs-paginate` footer: selection count on the left,
 * rows-per-page select + page indicator + chevron pager on the right.
 */
function ObsPaginate<TData>({ table }: { table: TanstackTable<TData> }) {
  const { pageIndex, pageSize } = table.getState().pagination;
  const pageCount = Math.max(1, table.getPageCount());
  const pageNum = pageIndex + 1;
  const totalRows = table.getFilteredRowModel().rows.length;
  const selectedRows = table.getFilteredSelectedRowModel().rows.length;

  return (
    <div className="obs-paginate">
      <div>{selectedRows} of {totalRows} row(s) selected.</div>
      <div className="group">
        <div className="rpp">
          <span>Rows per page</span>
          <select
            value={pageSize}
            onChange={(e) => table.setPageSize(Number(e.target.value))}
          >
            {[10, 20, 50].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div>Page {pageNum} of {pageCount}</div>
        <div className="pager">
          <button
            type="button"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
            aria-label="First page"
          >
            <ChevronsLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Next page"
          >
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            onClick={() => table.setPageIndex(pageCount - 1)}
            disabled={!table.getCanNextPage()}
            aria-label="Last page"
          >
            <ChevronsRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function cx(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" ");
}
