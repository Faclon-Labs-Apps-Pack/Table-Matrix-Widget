// Maps configured cell/series bindings to the grid cells they occupy so both the
// runtime widget and the configurator can render binding indicators without
// duplicating logic. This is pure UI-layer math — no fetching, no envelope work.
import { CellBinding, SeriesBinding, SeriesDirection } from '../../iosense-sdk/types';
import { CellId } from './CellDataStore';

export type BoundKind = 'cell' | 'series-base';

export interface BoundInfo {
  kind: BoundKind;
  topic: string;               // raw stored value, e.g. "{{uns:wsId://a/b/temp:last}}"
  label: string;               // short leaf label for in-cell display
  direction?: SeriesDirection; // present for series bases
}

const CELL_RE = /^R(\d+)C(\d+)$/;

// Short, human-readable label from a stored topic value. Strips the {{ }} marker
// and the "uns:wsId://" prefix, returning the last path segment (e.g. "temp:last").
export function topicLabel(topic: string): string {
  const t = (topic ?? '').trim();
  const inner = /^\{\{(.+)\}\}$/.exec(t)?.[1] ?? t;
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
