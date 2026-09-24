import { useMemo } from 'react';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useTranslation } from 'react-i18next';
import { RTL_LANGUAGES } from '../i18n';

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: 'inherit',
  headerFontWeight: 600,
  borderRadius: 6,
  wrapperBorderRadius: 8,
  spacing: 7,
});

export interface DataGridProps<T> {
  rows: T[] | undefined;
  columns: ColDef<T>[];
  rowId: (row: T) => string;
  loading?: boolean;
  quickFilter?: string;
  height?: number;
}

/** AG Grid with the app theme, RTL support and sensible defaults. */
export function DataGrid<T>({
  rows,
  columns,
  rowId,
  loading,
  quickFilter,
  height = 520,
}: DataGridProps<T>) {
  const { i18n } = useTranslation();
  const defaultColDef = useMemo<ColDef<T>>(
    () => ({ sortable: true, filter: true, resizable: true, flex: 1, minWidth: 120 }),
    [],
  );
  return (
    <div style={{ height }}>
      <AgGridReact<T>
        theme={theme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={defaultColDef}
        getRowId={(p: GetRowIdParams<T>) => rowId(p.data)}
        loading={loading}
        quickFilterText={quickFilter}
        enableRtl={RTL_LANGUAGES.has(i18n.language)}
        pagination
        paginationPageSize={50}
        paginationPageSizeSelector={[25, 50, 100, 200]}
        animateRows
      />
    </div>
  );
}
