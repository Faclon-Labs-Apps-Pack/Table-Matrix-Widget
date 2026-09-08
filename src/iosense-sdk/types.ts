// A resolved binding value. Single-cell bindings resolve to a scalar; series
// bindings resolve to an array (or a JSON / comma string the widget parses).
export type DataValue =
  | string
  | number
  | boolean
  | null
  | Array<string | number | boolean | null>;

export interface DataEntry {
  key: string;
  value: DataValue;
  /** Bucketed time-series slots, present only for `type: 'series'` bindings.
   *  `value` carries the same buckets flattened to their values, which is what
   *  the widget spreads across cells; `slots` keeps the labels/timestamps for
   *  anything that needs the time axis. */
  slots?: ResolveSlot[];
}

// One bucket of a series result, as returned by resolveAndCompute when the
// request's config entry carries `type: 'series'`.
export interface ResolveSlot {
  from: number;                    // bucket start, epoch ms
  to: number;                      // bucket end, epoch ms
  label: string;                   // bucket label, e.g. "00:00"
  value: number | null;            // null when quality is 'no_data'
  quality?: 'good' | 'no_data';
  isPartial?: boolean;
  shift?: string;
}

// resolveAndCompute request `type`. Omitted → the topic's aggregation postfix
// (`:last`, `:avg`, …) collapses the window to one value. `'series'` → the
// window is bucketed and returned as `slots`.
export type BindingType = 'series';

// One entry of dynamicBindingPathList. `type` is carried through to the
// resolveAndCompute request so the host engine (and the dev mini-engine) know
// which bindings must come back bucketed rather than as a single value.
export interface BindingPath {
  key: string;
  topic: string;
  type?: BindingType;
}

export interface Duration {
  id: string;
  label?: string;
  x?: number;
  xPeriod: string;
}

export interface TimeConfig {
  timezone: string;
  type: 'local' | 'fixed' | string;
  startTime: number | null;
  endTime: number | null;
  defaultDuration: string;
  allDurations: Duration[];
  defaultPeriodicity: 'minute' | 'hourly' | 'daily' | 'weekly' | 'monthly';
}

export type WidgetEvent =
  | { type: 'TIME_CHANGE'; payload: { startTime: string; endTime: string; periodicity: string } }
  | { type: 'FILTER_CHANGE'; payload: Record<string, unknown> }
  // Emitted when the user edits the widget directly on the canvas (bindings,
  // cell content/formats, grid geometry). The widget stays a pure renderer —
  // it hands the updated uiConfig to the host, which persists the envelope.
  // dynamicBindingPathList is rebuilt BY THE WIDGET and carried in the payload
  // so the "binding index always matches uiConfig" invariant holds even for
  // hosts that just persist the payload verbatim.
  | { type: 'CONFIG_CHANGE'; payload: { uiConfig: TableWidgetUIConfig; dynamicBindingPathList: BindingPath[] } };

export type TextAlign = 'left' | 'center' | 'right';
export type NumberFormat = 'general' | 'number' | 'percent' | 'currency' | 'integer';
export type BorderStyle = 'solid' | 'dashed' | 'dotted';
export type BorderWidth = 1 | 2 | 3;
export type TableBorderStyle = 'none' | 'all' | 'rows' | 'columns';

export interface CellBorderSide {
  enabled: boolean;
  color: string;        // CSS hex, default '#cccccc'
  style: BorderStyle;   // default 'solid'
  width: BorderWidth;   // default 1
}

export interface CellBorders {
  top: CellBorderSide;
  right: CellBorderSide;
  bottom: CellBorderSide;
  left: CellBorderSide;
}

export interface CellFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fontSize: number;           // default 13
  textAlign: TextAlign;       // default 'left'
  numberFormat: NumberFormat; // default 'general'
  textColor: string;          // CSS hex or '' (inherits)
  cellColor: string;          // CSS hex or '' (transparent)
  borders: CellBorders;
  link: string;               // URL opened on click; '' = no link
  /** Decimal places for this cell's numeric value. null = inherit the widget's
   *  `dataPrecision`; a number overrides it (0-10). */
  decimals: number | null;
}

export interface CellData {
  value: string;
  format: CellFormat;
}

// One persisted cell in uiConfig.cells. Sparse: a key is present only when the
// cell carries manual text and/or a non-default format. Values of bound cells
// are runtime data (service-populated) and are never persisted here.
export interface PersistedCell {
  value?: string;
  format?: CellFormat;
}

export type ConditionalRuleCondition =
  | 'greaterThan' | 'lessThan' | 'greaterThanOrEqual' | 'lessThanOrEqual'
  | 'equalTo' | 'notEqualTo' | 'between'
  | 'contains' | 'isEmpty' | 'isNotEmpty';

export interface ConditionalRuleRange {
  startRow: number; startCol: number;
  endRow: number;   endCol: number;
}

export interface ConditionalRuleFormat {
  cellColor?: string;
  textColor?: string;
  bold?: boolean;
  italic?: boolean;
}

export interface ConditionalRule {
  id: string;
  enabled: boolean;
  range: ConditionalRuleRange | null; // null = all cells
  condition: ConditionalRuleCondition;
  value1: string;
  value2: string;
  format: ConditionalRuleFormat;
}

export interface CellBinding {
  cellId: string;  // "R{row}C{col}" — zero-indexed
  topic: string;   // mapped UNS path, stored wrapped as "{{uns:wsId://path}}"
}

// Series population: a single base cell is bound to a topic that resolves to an
// array. The array is laid out from the base cell either across columns
// (horizontal) or down rows (vertical).
export type SeriesDirection = 'horizontal' | 'vertical';

export interface SeriesBinding {
  id: string;
  baseCellId: string;          // "R{row}C{col}" — anchor cell, zero-indexed
  topic: string;               // mapped UNS path, "{{uns:wsId://path}}" (resolves to an array)
  direction: SeriesDirection;  // layout direction from the base cell
  limit: number;               // max cells to fill; 0 = no cap (fill whole array)
}

export type RowFilterType = 'chips' | 'dropdown';

export interface RowFilterItem {
  id: string;
  name: string;
  color: string; // CSS hex
  icon: string;  // key into the curated icon registry (rowFilter.ts)
}

export interface RowFilterConfig {
  colIndex: number | null; // 0-based; null = not configured
  startRow: number | null; // 0-based inclusive
  endRow: number | null;   // 0-based inclusive
  range: string;           // raw text shown in the configurator input, e.g. "A2:A10"
  filterType: RowFilterType;
  enableCount: boolean;
  hideNonMatching: boolean; // filtering — hide rows not matched by any active filter
  enableColor: boolean;     // highlighting — tint matched rows with the filter's color (optional, independent of hideNonMatching)
  filters: RowFilterItem[];
}

export interface TableWidgetCardStyle {
  wrapInCard: boolean;
  bg: string;
  borderColor: string;
  borderWidth: number;   // 1 | 2 | 3
  borderRadius: number;  // px
  padding: number;       // px
}

export type TitleFontWeight = 'regular' | 'medium' | 'bold';
export type TitleAlign = 'left' | 'center' | 'right';

export interface TableWidgetTitleStyle {
  color: string;
  fontSize: number;
  fontWeight: TitleFontWeight;
  align: TitleAlign;
}

/** Clock used for the resolve window and for the time labels a series carries.
 *  'local' = the viewer's browser timezone, 'utc' = UTC (the platform's
 *  "global" time), so the same table reads identically for every operator. */
export type TimeDisplayMode = 'local' | 'utc';

export interface TableWidgetUIConfig {
  title: string;
  rows: number;
  columns: number;
  freezeRows: number;
  freezeColumns: number;
  /** Nominal widget box. The widget itself always fills its host container
   *  (100% x 100%) and no longer reads these, so there is no size form in the
   *  configurator; the dev harness sizes its preview tile from them and they
   *  ride through the envelope untouched. */
  widgetWidth: number;
  widgetHeight: number;
  locked: boolean;
  conditionalRules: ConditionalRule[];
  cellBindings: CellBinding[];
  seriesBindings: SeriesBinding[];
  rowFilter: RowFilterConfig;
  /** Default decimal places for numeric values that carry no per-cell override.
   *  null = render the value exactly as it resolved. */
  dataPrecision: number | null;
  /** Whether time-bucketed (series) data is labelled in the viewer's local
   *  timezone or in UTC. Also drives the mini-engine's resolve request. */
  timeDisplay: TimeDisplayMode;
  /** Persisted manual cell content + per-cell formatting, keyed "R{r}C{c}".
   *  Hydrated into the CellDataStore on mount and re-emitted (via CONFIG_CHANGE)
   *  whenever the user edits or formats cells on the canvas. */
  cells: Record<string, PersistedCell>;
  /** Per-column widths in px, index = column. Missing entries fall back to the
   *  default width; [] = all defaults. */
  columnWidths: number[];
  /** Per-row heights in px, index = row. Same fallback rules as columnWidths. */
  rowHeights: number[];
  /** Lock-mode horizontal behaviour. `false` (default) scales the columns so
   *  they fit the widget width exactly — every column stays visible, nothing
   *  scrolls sideways. `true` keeps each column at its configured width and
   *  scrolls horizontally instead, which is the readable choice once the
   *  compacted columns get too narrow. Rows always keep their configured
   *  heights and scroll vertically either way.
   *
   *  Widget-owned: toggled from the table's own Settings (gear) menu, never
   *  from the configurator — which must pass it through untouched. */
  lockedHorizontalScroll: boolean;
  style: {
    card: TableWidgetCardStyle;
    title: TableWidgetTitleStyle;
    tableBorderStyle: TableBorderStyle;
    showExportButton: boolean;
    /** Show the in-table search field in the widget header. */
    showSearch: boolean;
  };
}

export interface TableWidgetEnvelope {
  _id: string;
  type: 'TableWidget';
  general: { title: string };
  timeConfig?: TimeConfig;
  uiConfig: TableWidgetUIConfig;
  dynamicBindingPathList: BindingPath[];
}
