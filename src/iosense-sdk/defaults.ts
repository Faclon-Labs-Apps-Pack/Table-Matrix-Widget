// Single source of truth for the TableWidget's default uiConfig.
//
// The Lens host can mount a freshly-added widget instance with a partial (or
// empty) uiConfig before the configurator has emitted a complete envelope.
// Both the widget and the configurator default through here so every key the
// renderer reads is guaranteed present — no `config.style` / `config.title`
// crashes on missing keys.

import {
  TableWidgetUIConfig,
  TimeDisplayMode,
  TableWidgetCardStyle,
  TableWidgetTitleStyle,
  TableBorderStyle,
  RowFilterConfig,
  RowFilterItem,
} from './types';

export const DEFAULT_CARD_STYLE: TableWidgetCardStyle = {
  // On by default: a bare table sitting flush against the dashboard tile reads
  // as unfinished, and the card is what gives it an edge. Both the widget and
  // the configurator resolve this through withTableWidgetDefaults, so the two
  // can never disagree about the starting state.
  wrapInCard: true,
  bg: '',
  borderColor: '#e0e0e0',
  borderWidth: 1,
  borderRadius: 8,
  padding: 16,
};

export const DEFAULT_TITLE_STYLE: TableWidgetTitleStyle = {
  color: '',
  fontSize: 16,
  fontWeight: 'regular',
  align: 'left',
};

export const DEFAULT_TABLE_STYLE: TableWidgetUIConfig['style'] = {
  card: DEFAULT_CARD_STYLE,
  title: DEFAULT_TITLE_STYLE,
  tableBorderStyle: 'all',
  showExportButton: true,
  showSearch: false,
};

export const DEFAULT_ROW_FILTER_CONFIG: RowFilterConfig = {
  colIndex: null,
  startRow: null,
  endRow: null,
  range: '',
  filterType: 'chips',
  enableCount: false,
  hideNonMatching: true, // default behavior is pure filtering — no color
  enableColor: false,    // highlighting is an opt-in extra
  filters: [],
};

export const DEFAULT_TABLE_WIDGET_UI_CONFIG: TableWidgetUIConfig = {
  title: '',
  rows: 10,
  columns: 10,
  freezeRows: 0,
  freezeColumns: 0,
  widgetWidth: 700,
  widgetHeight: 500,
  locked: false,
  conditionalRules: [],
  cellBindings: [],
  seriesBindings: [],
  rowFilter: DEFAULT_ROW_FILTER_CONFIG,
  timeDisplay: 'local',
  cells: {},
  columnWidths: [],
  rowHeights: [],
  lockedHorizontalScroll: false,
  style: DEFAULT_TABLE_STYLE,
};

// A uiConfig as it may arrive from the host: any subset of keys, with `style`
// itself possibly partial or absent.
export type PartialTableWidgetUIConfig =
  Partial<Omit<TableWidgetUIConfig, 'style' | 'rowFilter'>> & {
    style?: Partial<{
      card: Partial<TableWidgetCardStyle>;
      title: Partial<TableWidgetTitleStyle>;
      tableBorderStyle: TableBorderStyle;
      showExportButton: boolean;
      showSearch: boolean;
    }>;
    rowFilter?: Partial<Omit<RowFilterConfig, 'filters'>> & { filters?: RowFilterItem[] };
  };

// A spread merge only replaces keys that are `undefined` — a host that stores
// an unset list as `null` (or as an object, after a JSON round-trip through a
// schema that drops empty arrays) would otherwise hand the renderer a `null`
// where it iterates. These two coercions make every collection key safe to
// `.map` / `.find` / `Object.entries` without a call-site guard.
function arr<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}

function obj<T>(value: unknown, fallback: Record<string, T>): Record<string, T> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, T>)
    : fallback;
}

// Deep-merge an incoming (possibly partial / undefined) uiConfig over the
// defaults, returning a fully-populated config safe for the renderer.
export function withTableWidgetDefaults(
  config: PartialTableWidgetUIConfig | undefined | null,
): TableWidgetUIConfig {
  const c = config ?? {};
  const style = c.style ?? {};
  const rowFilter = c.rowFilter ?? {};
  return {
    ...DEFAULT_TABLE_WIDGET_UI_CONFIG,
    ...c,
    conditionalRules: arr(c.conditionalRules, DEFAULT_TABLE_WIDGET_UI_CONFIG.conditionalRules),
    cellBindings:     arr(c.cellBindings,     DEFAULT_TABLE_WIDGET_UI_CONFIG.cellBindings),
    seriesBindings:   arr(c.seriesBindings,   DEFAULT_TABLE_WIDGET_UI_CONFIG.seriesBindings),
    columnWidths:     arr(c.columnWidths,     DEFAULT_TABLE_WIDGET_UI_CONFIG.columnWidths),
    rowHeights:       arr(c.rowHeights,       DEFAULT_TABLE_WIDGET_UI_CONFIG.rowHeights),
    cells:            obj(c.cells,            DEFAULT_TABLE_WIDGET_UI_CONFIG.cells),
    // A host that round-trips the flag as null / 0 / "false" must not end up
    // with a truthy object where the renderer expects a boolean.
    lockedHorizontalScroll: c.lockedHorizontalScroll === true,
    timeDisplay: (c.timeDisplay === 'utc' ? 'utc' : 'local') as TimeDisplayMode,
    style: {
      ...DEFAULT_TABLE_STYLE,
      ...style,
      card:  { ...DEFAULT_CARD_STYLE,  ...(style.card  ?? {}) },
      title: { ...DEFAULT_TITLE_STYLE, ...(style.title ?? {}) },
    },
    rowFilter: {
      ...DEFAULT_ROW_FILTER_CONFIG,
      ...rowFilter,
      filters: arr(rowFilter.filters, DEFAULT_ROW_FILTER_CONFIG.filters),
    },
  };
}
