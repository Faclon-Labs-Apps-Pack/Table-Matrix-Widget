// Single source of truth for the TableWidget's default uiConfig.
//
// The Lens host can mount a freshly-added widget instance with a partial (or
// empty) uiConfig before the configurator has emitted a complete envelope.
// Both the widget and the configurator default through here so every key the
// renderer reads is guaranteed present — no `config.style` / `config.title`
// crashes on missing keys.

import {
  TableWidgetUIConfig,
  TableWidgetCardStyle,
  TableWidgetTitleStyle,
  TableBorderStyle,
  RowFilterConfig,
  RowFilterItem,
} from './types';

export const DEFAULT_CARD_STYLE: TableWidgetCardStyle = {
  wrapInCard: false,
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
};

export const DEFAULT_TABLE_STYLE: TableWidgetUIConfig['style'] = {
  card: DEFAULT_CARD_STYLE,
  title: DEFAULT_TITLE_STYLE,
  tableBorderStyle: 'all',
  showExportButton: true,
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
    }>;
    rowFilter?: Partial<Omit<RowFilterConfig, 'filters'>> & { filters?: RowFilterItem[] };
  };

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
    style: {
      ...DEFAULT_TABLE_STYLE,
      ...style,
      card:  { ...DEFAULT_CARD_STYLE,  ...(style.card  ?? {}) },
      title: { ...DEFAULT_TITLE_STYLE, ...(style.title ?? {}) },
    },
    rowFilter: {
      ...DEFAULT_ROW_FILTER_CONFIG,
      ...rowFilter,
      filters: rowFilter.filters ?? DEFAULT_ROW_FILTER_CONFIG.filters,
    },
  };
}
