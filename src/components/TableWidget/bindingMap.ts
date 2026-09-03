// Maps configured cell/series bindings to the grid cells they occupy so both the
// runtime widget and the configurator can render binding indicators without
// duplicating logic. This is pure UI-layer math — no fetching, no envelope work.
import { CellBinding, SeriesBinding, SeriesDirection, ConditionalRule, RowFilterConfig } from '../../iosense-sdk/types';
import { extractTopic } from '../../iosense-sdk/bindings';
import { rangeToString } from './formulaEngine';
import { CellId } from './CellDataStore';

export type BoundKind = 'cell' | 'series-base';

export interface BoundInfo {
  kind: BoundKind;
  topic: string;               // raw stored value, e.g. "{{uns:wsId://a/b/temp:last}}"
  label: string;               // short leaf label for in-cell display
  direction?: SeriesDirection; // present for series bases
}

const CELL_RE = /^R(\d+)C(\d+)$/;

// Short, human-readable label from a stored topic value. Delegates the {{ }}
// unwrap to the canonical extractTopic (the same parser the binding index
// uses), then strips the "uns:wsId://" prefix and keeps the last path segment
// (e.g. "temp:last").
export function topicLabel(topic: string): string {
  const inner = extractTopic(topic);
  if (!inner) return '';
  const afterProto = inner.replace(/^uns:[^/]+:\/\//, '');
  const seg = afterProto.split('/').filter(Boolean).pop();
  return seg ?? afterProto;
}

// One entry per configured cell binding and series base. Series *fill* cells
// (beyond the base) are intentionally excluded — the real spill depends on the
// live array length and is applied at runtime by the widget from the data prop.
export function computeBoundCells(
  cellBindings: CellBinding[],
  seriesBindings: SeriesBinding[],
): Map<CellId, BoundInfo> {
  const map = new Map<CellId, BoundInfo>();

  for (const b of cellBindings) {
    if (!b.cellId || !CELL_RE.test(b.cellId)) continue;
    const topic = (b.topic ?? '').trim();
    if (!topic) continue;
    map.set(b.cellId, { kind: 'cell', topic, label: topicLabel(topic) });
  }

  // Series bases win over a single-cell binding on the same cell (a cell can only
  // be one kind at a time; the configurator enforces this, this is just a guard).
  for (const s of seriesBindings) {
    if (!s.baseCellId || !CELL_RE.test(s.baseCellId)) continue;
    const topic = (s.topic ?? '').trim();
    if (!topic) continue;
    map.set(s.baseCellId, {
      kind: 'series-base',
      topic,
      label: topicLabel(topic),
      direction: s.direction,
    });
  }

  return map;
}

// ── Grid-mutation remapping ────────────────────────────────────────────────
// When the user inserts or deletes a row/column, the CellDataStore shifts cell
// CONTENTS — everything in uiConfig that addresses cells by position must shift
// with it or bindings land on the wrong rows and the misalignment persists in
// the envelope.

export type GridMutation = {
  kind: 'insertRow' | 'deleteRow' | 'insertCol' | 'deleteCol';
  index: number;
};

export interface RemappableConfig {
  cellBindings: CellBinding[];
  seriesBindings: SeriesBinding[];
  conditionalRules: ConditionalRule[];
  rowFilter: RowFilterConfig;
}

// New cell id after the mutation, or null when the cell's row/column was deleted.
function shiftCellId(cellId: string, mut: GridMutation): string | null {
  const m = CELL_RE.exec(cellId);
  if (!m) return cellId;
  let r = parseInt(m[1], 10);
  let c = parseInt(m[2], 10);
  const at = mut.index;
  switch (mut.kind) {
    case 'insertRow': if (r >= at) r += 1; break;
    case 'deleteRow': if (r === at) return null; if (r > at) r -= 1; break;
    case 'insertCol': if (c >= at) c += 1; break;
    case 'deleteCol': if (c === at) return null; if (c > at) c -= 1; break;
  }
  return `R${r}C${c}`;
}

// Shift one inclusive [start, end] span. Returns null when the span collapsed
// to nothing (its only row/column was deleted).
function shiftSpan(start: number, end: number, mut: GridMutation, axis: 'row' | 'col'): [number, number] | null {
  const rowMut = mut.kind === 'insertRow' || mut.kind === 'deleteRow';
  if ((axis === 'row') !== rowMut) return [start, end];
  const at = mut.index;
  if (mut.kind === 'insertRow' || mut.kind === 'insertCol') {
    return [start >= at ? start + 1 : start, end >= at ? end + 1 : end];
  }
  const s = start > at ? start - 1 : start;
  const e = end >= at ? end - 1 : end;
  return e < s ? null : [s, e];
}

export function remapForGridMutation(cfg: RemappableConfig, mut: GridMutation): RemappableConfig {
  const cellBindings = cfg.cellBindings.flatMap((b) => {
    const next = shiftCellId(b.cellId, mut);
    return next === null ? [] : [{ ...b, cellId: next }];
  });

  const seriesBindings = cfg.seriesBindings.flatMap((s) => {
    const next = shiftCellId(s.baseCellId, mut);
    return next === null ? [] : [{ ...s, baseCellId: next }];
  });

  const conditionalRules = cfg.conditionalRules.map((rule) => {
    if (rule.range === null) return rule; // all-cells rules are position-free
    const rows = shiftSpan(rule.range.startRow, rule.range.endRow, mut, 'row');
    const cols = shiftSpan(rule.range.startCol, rule.range.endCol, mut, 'col');
    if (!rows || !cols) {
      // The rule's entire range was deleted. Disabling (rather than dropping,
      // or letting range become null = all cells) keeps the user's rule
      // visible in the panel without silently applying it elsewhere; the
      // clamped single-cell range is just a placeholder they can re-point.
      const r0 = rows ? rows[0] : Math.max(0, rule.range.startRow - 1);
      const c0 = cols ? cols[0] : Math.max(0, rule.range.startCol - 1);
      return { ...rule, enabled: false, range: { startRow: r0, endRow: r0, startCol: c0, endCol: c0 } };
    }
    return { ...rule, range: { startRow: rows[0], endRow: rows[1], startCol: cols[0], endCol: cols[1] } };
  });

  let rowFilter = cfg.rowFilter;
  if (rowFilter.colIndex !== null && rowFilter.startRow !== null && rowFilter.endRow !== null) {
    const rows = shiftSpan(rowFilter.startRow, rowFilter.endRow, mut, 'row');
    const cols = shiftSpan(rowFilter.colIndex, rowFilter.colIndex, mut, 'col');
    if (!rows || !cols) {
      // The filtered column/range no longer exists — unconfigure the range but
      // keep the user's filter definitions.
      rowFilter = { ...rowFilter, colIndex: null, startRow: null, endRow: null, range: '' };
    } else {
      const colIndex = cols[0];
      rowFilter = {
        ...rowFilter,
        colIndex,
        startRow: rows[0],
        endRow: rows[1],
        range: rangeToString({ startRow: rows[0], endRow: rows[1], startCol: colIndex, endCol: colIndex }),
      };
    }
  }

  return { cellBindings, seriesBindings, conditionalRules, rowFilter };
}

// The strip of cells a series would fill from its base, for a design-time preview.
// `count` is the max cells to show (limit, or a small default when limit is 0).
export function seriesPreviewCells(
  baseCellId: string,
  direction: SeriesDirection,
  count: number,
  rows: number,
  columns: number,
): Set<CellId> {
  const set = new Set<CellId>();
  const m = CELL_RE.exec(baseCellId);
  if (!m) return set;
  const r0 = parseInt(m[1], 10);
  const c0 = parseInt(m[2], 10);
  for (let i = 0; i < count; i++) {
    const r = direction === 'vertical' ? r0 + i : r0;
    const c = direction === 'horizontal' ? c0 + i : c0;
    if (r >= rows || c >= columns) break;
    set.add(`R${r}C${c}` as CellId);
  }
  return set;
}
