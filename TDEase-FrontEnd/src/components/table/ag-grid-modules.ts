import {
  CellStyleModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  CsvExportModule,
  CustomFilterModule,
  DateFilterModule,
  ModuleRegistry,
  NumberFilterModule,
  PaginationModule,
  QuickFilterModule,
  RenderApiModule,
  RowSelectionModule,
  TextFilterModule,
  TooltipModule,
  ValidationModule,
} from 'ag-grid-community'

let registered = false

export function ensureAgGridModulesRegistered(): void {
  if (registered) {
    return
  }
  ModuleRegistry.registerModules([
    ClientSideRowModelModule,
    RowSelectionModule,
    PaginationModule,
    QuickFilterModule,
    TextFilterModule,
    NumberFilterModule,
    DateFilterModule,
    CustomFilterModule,
    CsvExportModule,
    ColumnApiModule,
    ColumnAutoSizeModule,
    RenderApiModule,
    CellStyleModule,
    TooltipModule,
    ValidationModule,
  ])
  registered = true
}
