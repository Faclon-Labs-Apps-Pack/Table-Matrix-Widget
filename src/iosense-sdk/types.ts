export interface DataEntry {
  key: string;
  value: string | number | null;
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
  | { type: 'FILTER_CHANGE'; payload: Record<string, unknown> };

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
}

export interface CellData {
  value: string;
  format: CellFormat;
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
  topic: string;   // raw UNS topic, no {{ }} braces
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

export interface TableWidgetTitleStyle {
  color: string;
  fontSize: number;
  fontWeight: TitleFontWeight;
}

export interface TableWidgetUIConfig {
  title: string;
  rows: number;
  columns: number;
  freezeRows: number;
  freezeColumns: number;
  widgetWidth: number;
  widgetHeight: number;
  locked: boolean;
  conditionalRules: ConditionalRule[];
  cellBindings: CellBinding[];
  style: {
    card: TableWidgetCardStyle;
    title: TableWidgetTitleStyle;
    tableBorderStyle: TableBorderStyle;
    showExportButton: boolean;
  };
}

export interface TableWidgetEnvelope {
  _id: string;
  type: 'TableWidget';
  general: { title: string };
  timeConfig?: TimeConfig;
  uiConfig: TableWidgetUIConfig;
  dynamicBindingPathList: Array<{ key: string; topic: string }>;
}
