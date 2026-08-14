// Row Filter feature: a configured single-column range + named filters that
// toggle row visibility/tint above the table. Pure UI-layer math — reads
// already-resolved cell text out of CellDataStore, no fetching, no envelope
// work. Mirrors the style of bindingMap.ts.
import {
  Icon,
  Tag, Flag, Star, CheckCircle, XCircle, AlertTriangle, AlertCircle, Info,
  Circle, Square, Zap, Activity, TrendingUp, TrendingDown, Package, Truck,
  Tool, Settings, Clock, User,
} from 'react-feather';
import { RowFilterConfig } from '../../iosense-sdk/types';
import { CellDataStore, CellId } from './CellDataStore';
import { parseRangeString, getDisplayValue } from './formulaEngine';

export const ROW_FILTER_ICONS: Record<string, Icon> = {
  Tag, Flag, Star, CheckCircle, XCircle, AlertTriangle, AlertCircle, Info,
  Circle, Square, Zap, Activity, TrendingUp, TrendingDown, Package, Truck,
  Tool, Settings, Clock, User,
};

export const ROW_FILTER_ICON_NAMES = Object.keys(ROW_FILTER_ICONS);
export const DEFAULT_ROW_FILTER_ICON = ROW_FILTER_ICON_NAMES[0];

// Selected-chip background tint — a translucent wash of the filter's own
// color, matching the Angular original's rgbaWithOpacity() behavior.
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Parses a single-column range string (e.g. "A2:A10") into 0-based, inclusive
// row bounds + the column index. Returns null for empty/unparseable input or
// a range spanning more than one column — row filters only ever read one
// column of values (by design, matching the Angular original this is ported
// from).
export function parseRowFilterRange(
  rangeStr: string,
): { colIndex: number; startRow: number; endRow: number } | null {
  const range = parseRangeString(rangeStr);
  if (!range) return null;
  if (range.startCol !== range.endCol) return null;
  return { colIndex: range.startCol, startRow: range.startRow, endRow: range.endRow };
}

// For every configured filter, the 0-based row indices within the configured
// range whose display value case-insensitive-exact-matches the filter's name.
export function computeFilterInstances(
  config: RowFilterConfig,
  store: CellDataStore,
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const filter of config.filters) result.set(filter.id, []);
  if (config.colIndex === null || config.startRow === null || config.endRow === null) {
    return result;
  }
  if (config.filters.length === 0) return result;

  const names = config.filters.map((f) => ({ id: f.id, name: f.name.trim().toLowerCase() }));
  for (let row = config.startRow; row <= config.endRow; row++) {
    const cellId = `R${row}C${config.colIndex}` as CellId;
    const value = getDisplayValue(cellId, store).trim().toLowerCase();
    if (!value) continue;
    for (const { id, name } of names) {
      if (name && value === name) result.get(id)!.push(row);
    }
  }
  return result;
}

// Row visibility + tint driven by the currently-active (toggled-on) filters.
// Filtering (hiding non-matching rows) and highlighting (tinting matched rows)
// are independent, config-gated behaviors — either, both, or neither can be on.
// Visibility itself is Set-based rather than a per-row boolean toggle, so two
// active filters that both match a row never fight over it when one turns off.
export function computeRowFilterVisibility(
  config: RowFilterConfig,
  instances: Map<string, number[]>,
  activeFilterIds: Set<string>,
): { hiddenRows: Set<number>; rowColors: Map<number, string> } {
  const hiddenRows = new Set<number>();
  const rowColors = new Map<number, string>();

  if (
    activeFilterIds.size === 0 ||
    config.colIndex === null ||
    config.startRow === null ||
    config.endRow === null
  ) {
    return { hiddenRows, rowColors };
  }

  const visibleRows = new Set<number>();
  for (const filter of config.filters) {
    if (!activeFilterIds.has(filter.id)) continue;
    for (const row of instances.get(filter.id) ?? []) {
      visibleRows.add(row);
      // First active filter (in configured order) to touch a row wins the tint.
      if (config.enableColor && !rowColors.has(row)) rowColors.set(row, filter.color);
    }
  }

  if (config.hideNonMatching) {
    for (let row = config.startRow; row <= config.endRow; row++) {
      if (!visibleRows.has(row)) hiddenRows.add(row);
    }
  }

  return { hiddenRows, rowColors };
}
