import { useState, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button, Popover, PopoverHeader, PopoverBody, ColorInput, TextInput } from '@faclon-labs/design-sdk';
import { Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight, Grid, Droplet, Type, Link as LinkIcon, Hash, Settings, XSquare } from 'react-feather';
import { CellDataStore, CellId, makeDefaultFormat } from './CellDataStore';
import { BoundInfo, GridMutation } from './bindingMap';
import { getDisplayValue, getComputedValue, evaluateConditionalRules } from './formulaEngine';
import { CellFormat, CellBorders, CellBorderSide, BorderStyle, BorderWidth, TextAlign, NumberFormat, ConditionalRule, TableBorderStyle } from '../../iosense-sdk/types';
import './VirtualGrid.css';

const ROW_HEIGHT = 32;
const ROW_NUM_WIDTH = 40;
const COL_WIDTH = 100;
const MIN_COL_WIDTH = 30;
const MIN_ROW_HEIGHT = 18;

// Snapshot of the grid state the user can change on the canvas — reported to
// the host via onUserChange so it can be persisted into uiConfig.
export interface GridGeometry {
  rows: number;
  columns: number;
  freezeRows: number;
  freezeColumns: number;
  columnWidths: number[];
  rowHeights: number[];
}

interface VirtualGridProps {
  rows: number;
  columns: number;
  freezeRows: number;
  freezeColumns: number;
  /** Persisted per-column widths / per-row heights (px). Missing entries fall
   *  back to the default size. */
  configColWidths?: number[];
  configRowHeights?: number[];
  store: CellDataStore;
  conditionalRules: ConditionalRule[];
  locked?: boolean;
  /** Lock-mode only. false = columns are scaled to fit the widget width so all
   *  of them stay visible; true = columns keep their configured widths and the
   *  table scrolls sideways. Rows always keep their heights and scroll. */
  horizontalScroll?: boolean;
  tableBorderStyle?: TableBorderStyle;
  /** Cells carrying a UNS binding — shown with a corner indicator + tooltip and
   *  locked from manual typing (their value is populated by the service). */
  boundCells?: Map<CellId, BoundInfo>;
  /** Cells a series will fill, highlighted while its config popover is open. */
  previewCells?: Set<CellId>;
  /** Default decimal places for SERVICE-POPULATED cells that carry no per-cell
   *  override. null = render the resolved number untouched. Manually typed
   *  content is never rounded by this — "10" typed by hand must not become
   *  "10.00" because a data topic elsewhere wanted 2 decimals. */
  dataPrecision?: number | null;
  /** Whether a cell's value came from the data prop (a binding or a series
   *  spill). Called at render time so it stays correct as data arrives without
   *  needing the parent to re-render. */
  isDataCell?: (cellId: CellId) => boolean;
  /** Cells matching the active in-table search, and the one the operator has
   *  stepped to — highlighted, and scrolled into view when it changes. */
  searchMatches?: Set<CellId>;
  activeMatch?: CellId | null;
  /** Double-clicking a cell calls this (with its viewport rect) instead of
   *  entering text-edit mode — the host opens the Cell Config popover. */
  onCellConfigure?: (cellId: CellId, rect: DOMRect) => void;
  /** Rows the active row filter selection hides entirely (collapsed to 0px). */
  hiddenRows?: Set<number>;
  /** Rows the active row filter selection tints — takes priority over
   *  conditional formatting and the cell's own background color. */
  rowColors?: Map<number, string>;
  /** Fires after any user-initiated grid mutation (cell edit, formatting,
   *  resize, insert/delete, freeze) with the current geometry so the host can
   *  serialize the store + geometry into the envelope. Insert/delete row/col
   *  additionally passes the structural mutation so the host can remap
   *  position-addressed config (bindings, rule ranges, the row-filter range)
   *  in the same emit. Data-driven store writes (the data prop) never fire
   *  this. */
  onUserChange?: (geo: GridGeometry, mutation?: GridMutation) => void;
}

interface ContextMenuState {
  type: 'col' | 'row' | 'cell';
  index: number;      // row/column index; for 'cell' it is the row
  col?: number;       // only for 'cell'
  x: number;
  y: number;
}

function colLetter(index: number): string {
  let result = '';
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

function cellRefStr(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`;
}

function extractFormulaRefs(content: string): Set<CellId> {
  if (!content.startsWith('=')) return new Set();
  const refs = new Set<CellId>();
  for (const m of content.slice(1).matchAll(/([A-Z]+)(\d+)/g)) {
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    refs.add(`R${parseInt(m[2], 10) - 1}C${col - 1}` as CellId);
  }
  return refs;
}

function moveCursor(el: HTMLDivElement, pos: number): void {
  const textNode = el.firstChild;
  if (!textNode) return;
  const clampedPos = Math.min(pos, (textNode as Text).length);
  const range = document.createRange();
  range.setStart(textNode, clampedPos);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// Inserts `ref` at cursor, replacing any cell-ref token the cursor is within/at-end-of.
// If cursor is right after `=` or an operator with no existing ref token, it appends.
// If a ref like A1 surrounds the cursor (e.g. cursor at end of A1), it replaces that ref.
function insertOrReplaceRef(el: HTMLDivElement, ref: string): void {
  const text = el.textContent ?? '';
  const sel = window.getSelection();

  let cursorPos = text.length;
  let selEnd = text.length;
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (el.contains(range.startContainer)) {
      cursorPos = range.startOffset;
      selEnd = range.endOffset;
    }
  }

  // Non-collapsed selection → replace selected text
  if (cursorPos !== selEnd) {
    const newText = text.slice(0, cursorPos) + ref + text.slice(selEnd);
    el.textContent = newText;
    moveCursor(el, cursorPos + ref.length);
    return;
  }

  // Detect cell-ref token around cursor: scan back over digits then letters, forward over letters then digits
  let s = cursorPos;
  while (s > 0 && /\d/.test(text[s - 1])) s--;
  while (s > 0 && /[A-Z]/i.test(text[s - 1])) s--;

  let e = cursorPos;
  while (e < text.length && /[A-Z]/i.test(text[e])) e++;
  while (e < text.length && /\d/.test(text[e])) e++;

  const candidate = text.slice(s, e);
  const [insertStart, insertEnd] = /^[A-Z]+\d+$/i.test(candidate)
    ? [s, e]
    : [cursorPos, cursorPos];

  el.textContent = text.slice(0, insertStart) + ref + text.slice(insertEnd);
  moveCursor(el, insertStart + ref.length);
}

function stickyStyle(
  isHeaderRow: boolean,
  isRowNum: boolean,
  dataRow: number,
  dataCol: number,
  fr: number,
  fc: number,
  cw: number[],
  rh: number[],
  headersVisible: boolean = true,
): React.CSSProperties {
  const isFrozenRow = dataRow >= 0 && dataRow < fr;
  const isFrozenCol = dataCol >= 0 && dataCol < fc;
  const stickyV = isHeaderRow || isFrozenRow;
  const stickyH = isRowNum || isFrozenCol;
  if (!stickyV && !stickyH) return {};
  const style: React.CSSProperties = { position: 'sticky' };
  if (isHeaderRow) {
    style.top = 0;
  } else if (isFrozenRow) {
    // When headers are hidden there is no header row consuming space at top
    const headerOffset = headersVisible ? ROW_HEIGHT : 0;
    style.top = headerOffset + rh.slice(0, dataRow).reduce((a, b) => a + b, 0);
  }
  if (isRowNum) {
    style.left = 0;
  } else if (isFrozenCol) {
    // When headers are hidden there is no row-number column consuming space at left
    const rowNumOffset = headersVisible ? ROW_NUM_WIDTH : 0;
    style.left = rowNumOffset + cw.slice(0, dataCol).reduce((a, b) => a + b, 0);
  }
  if (stickyV && stickyH) style.zIndex = 3;
  else if (isHeaderRow || isRowNum) style.zIndex = 2;
  else style.zIndex = 1;
  return style;
}

// Box-shadow that makes scrolling content appear to slide underneath frozen panes.
// right=true  → shadow on the right edge  (last frozen col / row-number col)
// bottom=true → shadow on the bottom edge (last frozen row / header row)
function frozenEdgeShadow(right: boolean, bottom: boolean): React.CSSProperties {
  const parts: string[] = [];
  if (right)  parts.push('4px 0 8px -2px rgba(0,0,0,0.18)');
  if (bottom) parts.push('0 4px 8px -2px rgba(0,0,0,0.18)');
  return parts.length ? { boxShadow: parts.join(', ') } : {};
}

function cellBorderInlineStyle(borders: CellBorders): React.CSSProperties {
  const result: React.CSSProperties = {};
  if (borders.top.enabled)
    result.borderTop = `${borders.top.width}px ${borders.top.style} ${borders.top.color}`;
  if (borders.right.enabled)
    result.borderRight = `${borders.right.width}px ${borders.right.style} ${borders.right.color}`;
  if (borders.bottom.enabled)
    result.borderBottom = `${borders.bottom.width}px ${borders.bottom.style} ${borders.bottom.color}`;
  if (borders.left.enabled)
    result.borderLeft = `${borders.left.width}px ${borders.left.style} ${borders.left.color}`;
  return result;
}

// Wheel-on-hover for the toolbar's two native number inputs: no click needed,
// and the gesture never also scrolls the toolbar underneath.
//
// React's onWheel is delegated at the root as a passive listener, where
// preventDefault is a no-op — the value would change AND the page would scroll.
// A non-passive listener on the element itself is the only way to stop that.
function attachWheelStep(input: HTMLInputElement | null): void {
  if (!input) return;

  input.addEventListener('wheel', (event: WheelEvent) => {
    if (event.deltaY === 0) return;
    event.preventDefault();

    const min = input.min === '' ? -Infinity : Number(input.min);
    const max = input.max === '' ? Infinity : Number(input.max);
    const current = input.value === '' ? min : Number(input.value);
    if (!Number.isFinite(current)) return;

    // Scrolling up raises the value, matching the arrow keys.
    const next = Math.min(max, Math.max(min, current + (event.deltaY < 0 ? 1 : -1)));
    if (next === current) return;

    // Assign through the prototype setter so React's onChange still fires —
    // setting .value directly is invisible to React's synthetic event system.
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value',
    )?.set;
    setValue?.call(input, String(next));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { passive: false });
}

export function VirtualGrid({ rows, columns, freezeRows, freezeColumns, configColWidths, configRowHeights, store, conditionalRules, locked = false, horizontalScroll = false, tableBorderStyle = 'all', boundCells, previewCells, dataPrecision = null, isDataCell, searchMatches, activeMatch, onCellConfigure, hiddenRows, rowColors, onUserChange }: VirtualGridProps) {
  // Bound cells are service-populated — never manually editable.
  const isBound = (cellId: CellId) => boundCells?.has(cellId) ?? false;
  // Effective precision for one cell: the widget default applies only to
  // service-populated values; a per-cell override (set from the toolbar) wins
  // over both and is handled inside getDisplayValue.
  const decimalsFor = (cellId: CellId): number | null =>
    (isDataCell?.(cellId) ?? isBound(cellId)) ? dataPrecision : null;
  // Live refs for the document-level copy/paste listeners (registered once with
  // [store] deps) — without them the handlers keep mount-time values forever,
  // e.g. paste staying dead after the widget is unlocked.
  const boundCellsRef = useRef(boundCells);
  boundCellsRef.current = boundCells;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // ── Selection ──────────────────────────────────────────────────────────────
  const [selectedCells, setSelectedCells] = useState<Set<CellId>>(new Set());
  const [tick, setTick] = useState(0);
  const selectedCellsRef = useRef<Set<CellId>>(new Set());
  useEffect(() => { selectedCellsRef.current = selectedCells; }, [selectedCells]);

  // ── Resize state — seeded from persisted widths/heights when present ──────
  const [colWidths, setColWidths] = useState<number[]>(() =>
    Array.from({ length: columns }, (_, i) => configColWidths?.[i] ?? COL_WIDTH),
  );
  const [rowHeights, setRowHeights] = useState<number[]>(() =>
    Array.from({ length: rows }, (_, i) => configRowHeights?.[i] ?? ROW_HEIGHT),
  );
  const resizingRef = useRef<{
    type: 'col' | 'row'; index: number; startPos: number; startSize: number;
  } | null>(null);

  // ── Local grid dimensions ─────────────────────────────────────────────────
  const [localRows, setLocalRows] = useState(rows);
  const [localCols, setLocalCols] = useState(columns);
  const localRowsRef = useRef(rows);
  const localColsRef = useRef(columns);
  useEffect(() => { localRowsRef.current = localRows; }, [localRows]);
  useEffect(() => { localColsRef.current = localCols; }, [localCols]);

  // ── Local freeze ──────────────────────────────────────────────────────────
  const [localFR, setLocalFR] = useState(freezeRows);
  const [localFC, setLocalFC] = useState(freezeColumns);

  // ── User-change reporting ─────────────────────────────────────────────────
  // Live refs (assigned every render) so document-level listeners with []
  // dependencies read current state; overrides cover values set in the same
  // tick where the state hasn't re-rendered yet.
  const colWidthsRef = useRef(colWidths);   colWidthsRef.current = colWidths;
  const rowHeightsRef = useRef(rowHeights); rowHeightsRef.current = rowHeights;
  const localFRRef = useRef(localFR);       localFRRef.current = localFR;
  const localFCRef = useRef(localFC);       localFCRef.current = localFC;
  const onUserChangeRef = useRef(onUserChange); onUserChangeRef.current = onUserChange;

  function emitUserChange(overrides?: Partial<GridGeometry>, mutation?: GridMutation) {
    onUserChangeRef.current?.({
      rows: localRowsRef.current,
      columns: localColsRef.current,
      freezeRows: localFRRef.current,
      freezeColumns: localFCRef.current,
      columnWidths: colWidthsRef.current,
      rowHeights: rowHeightsRef.current,
      ...overrides,
    }, mutation);
  }

  // ── Border panel ──────────────────────────────────────────────────────────
  const [borderConfig, setBorderConfig] = useState<{
    color: string; style: BorderStyle; width: BorderWidth;
  }>({ color: '#cccccc', style: 'solid', width: 1 });

  // ── Context menu ──────────────────────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // ── Edit mode (separate from selection) ──────────────────────────────────
  const [editingCell, setEditingCell] = useState<CellId | null>(null);
  const editingCellRef = useRef<CellId | null>(null); // sync ref to avoid stale closures
  const discardOnBlurRef = useRef(false);             // set true on Escape to skip save

  // ── Formula pick mode ─────────────────────────────────────────────────────
  const [formulaEditingCell, setFormulaEditingCell] = useState<CellId | null>(null);
  const [formulaRefCells, setFormulaRefCells] = useState<Set<CellId>>(new Set());

  // ── Refs ──────────────────────────────────────────────────────────────────
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const cellRefsMap = useRef<Map<CellId, HTMLDivElement>>(new Map());

  // ── Sync from config props ─────────────────────────────────────────────────
  useEffect(() => {
    setLocalRows(rows);
    setRowHeights((prev) => {
      const next = prev.slice();
      while (next.length < rows) next.push(ROW_HEIGHT);
      return next.slice(0, rows);
    });
    setLocalFR(freezeRows);
  }, [rows, freezeRows]);

  useEffect(() => {
    setLocalCols(columns);
    setColWidths((prev) => {
      const next = prev.slice();
      while (next.length < columns) next.push(COL_WIDTH);
      return next.slice(0, columns);
    });
    setLocalFC(freezeColumns);
  }, [columns, freezeColumns]);

  // Persisted sizes can arrive AFTER mount — a host may mount with a partial
  // config and hand the saved envelope in a later update. Re-apply them then;
  // the JSON guard keeps our own emit round-trips (equal values, fresh array
  // identity) from causing render churn or clobbering an in-progress resize.
  useEffect(() => {
    if (!configColWidths || configColWidths.length === 0) return;
    setColWidths((prev) => {
      const next = prev.map((w, i) => configColWidths[i] ?? w);
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  }, [configColWidths]);

  useEffect(() => {
    if (!configRowHeights || configRowHeights.length === 0) return;
    setRowHeights((prev) => {
      const next = prev.map((h, i) => configRowHeights[i] ?? h);
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  }, [configRowHeights]);

  // Clear selection immediately when locked so no cell stays highlighted
  useEffect(() => {
    if (locked) setSelectedCells(new Set());
  }, [locked]);

  // ── Store subscription ────────────────────────────────────────────────────
  useEffect(() => store.subscribe(() => setTick((t) => t + 1)), [store]);
  void tick;

  // Stepping through search results must bring the match on screen — with
  // virtualization an off-screen match isn't even rendered, so highlighting
  // alone would look like the search found nothing.
  const scrollToRef = useRef<((r: number, c: number) => void) | null>(null);
  useEffect(() => {
    if (!activeMatch) return;
    const m = /^R(\d+)C(\d+)$/.exec(activeMatch);
    if (m) scrollToRef.current?.(parseInt(m[1], 10), parseInt(m[2], 10));
  }, [activeMatch]);

  // ── Fit-to-width (locked mode) ────────────────────────────────────────────
  // A locked table is a finished read-only surface: every column has to be on
  // screen at once, with no strip of background showing past the last one.
  // Scaling all column widths by a single factor keeps the operator's relative
  // proportions intact. Rows are deliberately NOT scaled — squeezing 200 rows
  // into the widget height makes them unreadable, so the table scrolls
  // vertically instead.
  //
  // clientWidth (not contentRect.width) is what the columns must add up to: it
  // already excludes the vertical scrollbar, so the fit doesn't overflow by the
  // scrollbar's width the moment the rows are taller than the box.
  const [viewportW, setViewportW] = useState<number | null>(null);
  useEffect(() => {
    const el = gridWrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = el.clientWidth;
      setViewportW((prev) => (prev !== null && Math.abs(prev - w) < 0.5 ? prev : w));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // Scale `sizes` so they sum to `target`, distributing the rounding remainder
  // into the last track — a per-track round alone leaves a 1-2px seam.
  function fitSizes(sizes: number[], target: number): number[] {
    const total = sizes.reduce((a, b) => a + b, 0);
    if (total <= 0 || target <= 0) return sizes;
    const k = target / total;
    const scaled = sizes.map((s) => Math.max(0, Math.floor(s * k)));
    const used = scaled.reduce((a, b) => a + b, 0);
    // Grow the last visible (non-collapsed) track by whatever pixel remains.
    for (let i = scaled.length - 1; i >= 0; i--) {
      if (sizes[i] > 0) { scaled[i] += target - used; break; }
    }
    return scaled;
  }

  // ── TanStack Virtual ──────────────────────────────────────────────────────
  // Row-filter-hidden rows collapse to 0px tracks in the grid template, so the
  // virtualizer MUST estimate them at 0 too — otherwise its offsets place the
  // rows after a hidden block kilometers below the collapsed layout and they
  // never render even though they're on screen. rowHeights itself stays
  // untouched (it's the persisted/user-set size, restored when unhidden).
  const naturalRowHeights = rowHeights
    .slice(0, localRows)
    .map((h, i) => (hiddenRows?.has(i) ? 0 : h));
  const naturalColWidths = colWidths.slice(0, localCols);

  // Locked with the Scroll bar setting off: compact the columns into the box.
  // Locked with it on, or unlocked: natural widths, the wrapper scrolls.
  const fitToWidth = locked && !horizontalScroll && viewportW !== null && viewportW > 0;
  const effectiveRowHeights = naturalRowHeights;
  const layoutColWidths     = fitToWidth ? fitSizes(naturalColWidths, viewportW) : naturalColWidths;

  const rowVirt = useVirtualizer({
    count: localRows,
    getScrollElement: () => gridWrapRef.current,
    estimateSize: (i) => effectiveRowHeights[i] ?? ROW_HEIGHT,
    overscan: 5,
  });

  const colVirt = useVirtualizer({
    count: localCols,
    getScrollElement: () => gridWrapRef.current,
    estimateSize: (i) => layoutColWidths[i] ?? COL_WIDTH,
    overscan: 3,
    horizontal: true,
  });

  // The virtualizers cache estimateSize results — invalidate them whenever a
  // resize or hide/show changes the real track sizes.
  const rowSizesKey = effectiveRowHeights.join(',');
  const colSizesKey = layoutColWidths.join(',');
  useEffect(() => { rowVirt.measure(); }, [rowSizesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { colVirt.measure(); }, [colSizesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  scrollToRef.current = (r: number, c: number) => {
    rowVirt.scrollToIndex(r, { align: 'auto' });
    colVirt.scrollToIndex(c, { align: 'auto' });
  };

  // ── Drag resize ───────────────────────────────────────────────────────────
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      const r = resizingRef.current;
      if (!r) return;
      if (r.type === 'col') {
        const w = Math.max(MIN_COL_WIDTH, r.startSize + e.clientX - r.startPos);
        setColWidths((prev) => { const next = [...prev]; next[r.index] = w; return next; });
      } else {
        const h = Math.max(MIN_ROW_HEIGHT, r.startSize + e.clientY - r.startPos);
        setRowHeights((prev) => { const next = [...prev]; next[r.index] = h; return next; });
      }
    }
    function onMouseUp() {
      const wasResizing = resizingRef.current !== null;
      resizingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (wasResizing) emitUserChange();
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // ── Copy / paste ──────────────────────────────────────────────────────────
  useEffect(() => {
    function buildCopyText(cells: Set<CellId>): string {
      const coords = [...cells].map((id) => {
        const m = /^R(\d+)C(\d+)$/.exec(id)!;
        return { r: parseInt(m[1], 10), c: parseInt(m[2], 10) };
      });
      const minR = Math.min(...coords.map((x) => x.r));
      const maxR = Math.max(...coords.map((x) => x.r));
      const minC = Math.min(...coords.map((x) => x.c));
      const maxC = Math.max(...coords.map((x) => x.c));
      const lines: string[] = [];
      for (let r = minR; r <= maxR; r++) {
        const cols: string[] = [];
        for (let c = minC; c <= maxC; c++) {
          const id: CellId = `R${r}C${c}`;
          cols.push(cells.has(id) ? getDisplayValue(id, store, decimalsFor(id)) : '');
        }
        lines.push(cols.join('\t'));
      }
      return lines.join('\n');
    }

    // The grid only owns copy/paste while focus is actually inside it — the
    // wrapper (selection mode) or a cell (edit mode). Without this check the
    // document-level listeners hijack clipboard events aimed at any other
    // field on the page (configurator inputs, the topic popover) whenever a
    // grid selection happens to exist.
    function focusInsideGrid(): boolean {
      return gridWrapRef.current?.contains(document.activeElement) ?? false;
    }

    function onCopy(e: ClipboardEvent) {
      if (!focusInsideGrid()) return;
      const sel = selectedCellsRef.current;
      if (sel.size === 0) return;
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', buildCopyText(sel));
    }

    function onPaste(e: ClipboardEvent) {
      if (lockedRef.current) return;
      if (!focusInsideGrid()) return;
      if ((document.activeElement as HTMLElement | null)?.classList?.contains('vg-data-cell')) return;
      const sel = selectedCellsRef.current;
      if (sel.size === 0) return;
      e.preventDefault();
      const raw = e.clipboardData?.getData('text/plain') ?? '';
      if (!raw) return;
      const pasteRows = raw
        .replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()
        .split('\n').map((row) => row.split('\t'));
      const coords = [...sel].map((id) => {
        const m = /^R(\d+)C(\d+)$/.exec(id)!;
        return { r: parseInt(m[1], 10), c: parseInt(m[2], 10) };
      });
      const anchorR = Math.min(...coords.map((x) => x.r));
      const anchorC = Math.min(...coords.map((x) => x.c));
      // One setValues batch → one listener fan-out for the whole block, however
      // large the pasted region is.
      const entries: Array<{ cellId: CellId; value: string }> = [];
      pasteRows.forEach((pasteRow, ri) => {
        pasteRow.forEach((value, ci) => {
          const r = anchorR + ri;
          const c = anchorC + ci;
          const target = `R${r}C${c}` as CellId;
          if (r < localRowsRef.current && c < localColsRef.current && !boundCellsRef.current?.has(target)) {
            entries.push({ cellId: target, value });
          }
        });
      });
      if (entries.length > 0) {
        store.setValues(entries);
        emitUserChange();
      }
    }

    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  }, [store]);

  // ── Context menu escape ───────────────────────────────────────────────────
  useEffect(() => {
    if (!contextMenu) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setContextMenu(null); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [contextMenu]);

  // ── Navigate to a cell — select only, focus stays on grid wrapper ─────────
  function navigateTo(row: number, col: number) {
    const r = Math.max(0, Math.min(localRows - 1, row));
    const c = Math.max(0, Math.min(localCols - 1, col));
    const id: CellId = `R${r}C${c}`;
    editingCellRef.current = null;
    setEditingCell(null);
    setSelectedCells(new Set([id]));
    rowVirt.scrollToIndex(r, { align: 'auto' });
    colVirt.scrollToIndex(c, { align: 'auto' });
    requestAnimationFrame(() => gridWrapRef.current?.focus());
  }

  // ── Enter edit mode for a cell ────────────────────────────────────────────
  function enterEditMode(cellId: CellId, initialChar?: string) {
    const m = /^R(\d+)C(\d+)$/.exec(cellId);
    if (!m) return;
    if (isBound(cellId)) return; // bound cells are service-populated, not editable
    editingCellRef.current = cellId;
    setEditingCell(cellId);
    setSelectedCells(new Set([cellId]));
    setFormulaEditingCell(null);
    setFormulaRefCells(new Set());
    requestAnimationFrame(() => {
      const el = cellRefsMap.current.get(cellId);
      if (!el) return;
      if (initialChar !== undefined) {
        el.textContent = initialChar;
        if (initialChar === '=') {
          setFormulaEditingCell(cellId);
        }
      } else {
        el.textContent = store.getValue(cellId);
        if (el.textContent.startsWith('=')) {
          setFormulaEditingCell(cellId);
          setFormulaRefCells(extractFormulaRefs(el.textContent));
        }
      }
      el.focus();
      moveCursor(el, el.textContent?.length ?? 0);
    });
  }

  // ── Selection handlers ─────────────────────────────────────────────────────
  function handleCellClick(e: React.MouseEvent, cellId: CellId) {
    e.stopPropagation();
    setContextMenu(null);
    if (locked) return;

    // Formula pick mode: insert ref into formula cell
    if (formulaEditingCell && formulaEditingCell !== cellId) {
      const m = /^R(\d+)C(\d+)$/.exec(cellId)!;
      const ref = cellRefStr(parseInt(m[1], 10), parseInt(m[2], 10));
      const editingEl = cellRefsMap.current.get(formulaEditingCell);
      if (editingEl) {
        insertOrReplaceRef(editingEl, ref);
        setFormulaRefCells(extractFormulaRefs(editingEl.textContent ?? ''));
      }
      return;
    }

    // Clicking a different cell while in edit mode: save current edit, then select
    if (editingCellRef.current && editingCellRef.current !== cellId) {
      const prev = editingCellRef.current;
      const editingEl = cellRefsMap.current.get(prev);
      if (editingEl) {
        const nextValue = editingEl.textContent ?? '';
        if (store.getValue(prev) !== nextValue) {
          store.setValue(prev, nextValue);
          emitUserChange();
        }
        editingCellRef.current = null;
        setEditingCell(null);
        setFormulaEditingCell(null);
        setFormulaRefCells(new Set());
        requestAnimationFrame(() => {
          if (document.activeElement !== editingEl)
            editingEl.textContent = getDisplayValue(prev, store, decimalsFor(prev));
        });
      }
    }

    if (e.ctrlKey || e.metaKey) {
      setSelectedCells((prev) => {
        const next = new Set(prev);
        if (next.has(cellId)) next.delete(cellId); else next.add(cellId);
        return next;
      });
    } else {
      setSelectedCells(new Set([cellId]));
    }
    requestAnimationFrame(() => gridWrapRef.current?.focus());
  }

  function handleCornerClick(e: React.MouseEvent) {
    e.stopPropagation();
    setContextMenu(null);
    const all = new Set<CellId>();
    for (let r = 0; r < localRows; r++)
      for (let c = 0; c < localCols; c++)
        all.add(`R${r}C${c}`);
    setSelectedCells(all);
  }

  function handleColHeaderClick(e: React.MouseEvent, col: number) {
    e.stopPropagation();
    setContextMenu(null);
    const cells = new Set<CellId>();
    for (let r = 0; r < localRows; r++) cells.add(`R${r}C${col}`);
    if (e.ctrlKey || e.metaKey)
      setSelectedCells((prev) => new Set([...prev, ...cells]));
    else
      setSelectedCells(cells);
  }

  function handleRowHeaderClick(e: React.MouseEvent, row: number) {
    e.stopPropagation();
    setContextMenu(null);
    const cells = new Set<CellId>();
    for (let c = 0; c < localCols; c++) cells.add(`R${row}C${c}`);
    if (e.ctrlKey || e.metaKey)
      setSelectedCells((prev) => new Set([...prev, ...cells]));
    else
      setSelectedCells(cells);
  }

  // ── Cell actions (context menu + toolbar) ─────────────────────────────────
  // Cells the menu/toolbar act on: the current selection when the clicked cell
  // is part of it, otherwise just the clicked cell (matching Excel).
  function targetCells(cellId?: CellId): CellId[] {
    if (cellId && !selectedCells.has(cellId)) return [cellId];
    return [...selectedCells];
  }

  /** Clear cell CONTENT (not formatting). Bound cells are skipped — their value
   *  is service-populated and would come straight back on the next resolve. */
  function clearContents(ids: CellId[]) {
    const toClear = ids.filter((id) => !isBound(id) && store.getValue(id) !== '');
    if (toClear.length === 0) return;
    store.setValues(toClear.map((cellId) => ({ cellId, value: '' })));
    emitUserChange();
  }

  /** Reset formatting (font, colors, borders, link, precision) to the default. */
  function clearFormatting(ids: CellId[]) {
    if (ids.length === 0) return;
    ids.forEach((id) => store.setFormat(id, makeDefaultFormat()));
    emitUserChange();
  }

  function handleCellContextMenu(e: React.MouseEvent, cellId: CellId, row: number, col: number) {
    if (!selectedCells.has(cellId)) setSelectedCells(new Set([cellId]));
    const x = Math.min(e.clientX, window.innerWidth - 210);
    const y = Math.min(e.clientY, window.innerHeight - 300);
    setContextMenu({ type: 'cell', index: row, col, x: Math.max(0, x), y: Math.max(0, y) });
  }

  // ── Context menu open ──────────────────────────────────────────────────────
  function handleColContextMenu(e: React.MouseEvent, col: number) {
    e.preventDefault();
    e.stopPropagation();
    if (locked) return;
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 180);
    setContextMenu({ type: 'col', index: col, x: Math.max(0, x), y: Math.max(0, y) });
  }

  function handleRowContextMenu(e: React.MouseEvent, row: number) {
    e.preventDefault();
    e.stopPropagation();
    if (locked) return;
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 210);
    setContextMenu({ type: 'row', index: row, x: Math.max(0, x), y: Math.max(0, y) });
  }

  // ── Insert / delete rows ───────────────────────────────────────────────────
  function insertRowAt(at: number) {
    store.insertRow(at);
    const nextHeights = [...rowHeights]; nextHeights.splice(at, 0, ROW_HEIGHT);
    const nextFR = localFR > at ? localFR + 1 : localFR;
    setLocalRows((r) => r + 1);
    setRowHeights(nextHeights);
    setLocalFR(nextFR);
    setSelectedCells(new Set());
    setContextMenu(null);
    emitUserChange({ rows: localRows + 1, rowHeights: nextHeights, freezeRows: nextFR }, { kind: 'insertRow', index: at });
  }

  function deleteRowAt(at: number) {
    if (localRows <= 1) return;
    store.deleteRow(at);
    const nextHeights = [...rowHeights]; nextHeights.splice(at, 1);
    const nextFR = localFR > at ? Math.max(0, localFR - 1) : localFR;
    setLocalRows((r) => r - 1);
    setRowHeights(nextHeights);
    setLocalFR(nextFR);
    setSelectedCells(new Set());
    setContextMenu(null);
    emitUserChange({ rows: localRows - 1, rowHeights: nextHeights, freezeRows: nextFR }, { kind: 'deleteRow', index: at });
  }

  // ── Insert / delete columns ────────────────────────────────────────────────
  function insertColAt(at: number) {
    store.insertCol(at);
    const nextWidths = [...colWidths]; nextWidths.splice(at, 0, COL_WIDTH);
    const nextFC = localFC > at ? localFC + 1 : localFC;
    setLocalCols((c) => c + 1);
    setColWidths(nextWidths);
    setLocalFC(nextFC);
    setSelectedCells(new Set());
    setContextMenu(null);
    emitUserChange({ columns: localCols + 1, columnWidths: nextWidths, freezeColumns: nextFC }, { kind: 'insertCol', index: at });
  }

  function deleteColAt(at: number) {
    if (localCols <= 1) return;
    store.deleteCol(at);
    const nextWidths = [...colWidths]; nextWidths.splice(at, 1);
    const nextFC = localFC > at ? Math.max(0, localFC - 1) : localFC;
    setLocalCols((c) => c - 1);
    setColWidths(nextWidths);
    setLocalFC(nextFC);
    setSelectedCells(new Set());
    setContextMenu(null);
    emitUserChange({ columns: localCols - 1, columnWidths: nextWidths, freezeColumns: nextFC }, { kind: 'deleteCol', index: at });
  }

  // ── Format helpers ────────────────────────────────────────────────────────
  const selectedArr = [...selectedCells];
  const hasSelection = selectedArr.length > 0;

  const isAllBold      = hasSelection && selectedArr.every((id) => store.getFormat(id).bold);
  const isAllItalic    = hasSelection && selectedArr.every((id) => store.getFormat(id).italic);
  const isAllUnderline = hasSelection && selectedArr.every((id) => store.getFormat(id).underline);

  const firstFmt = hasSelection ? store.getFormat(selectedArr[0]) : null;
  const currentAlign: TextAlign    = firstFmt?.textAlign    ?? 'left';
  const currentFontSize            = firstFmt?.fontSize     ?? 13;
  const currentTextColor           = firstFmt?.textColor    ?? '';
  const currentCellColor           = firstFmt?.cellColor    ?? '';
  const currentNumberFormat: NumberFormat = firstFmt?.numberFormat ?? 'general';
  const currentDecimals: number | null     = firstFmt?.decimals     ?? null;

  const currentLink = firstFmt?.link ?? '';

  // Draft for the link popover input — re-seeded whenever the anchor cell of
  // the selection changes so the field always shows that cell's current link.
  const [linkDraft, setLinkDraft] = useState('');
  const linkAnchor = selectedArr[0] ?? '';
  useEffect(() => {
    setLinkDraft(linkAnchor ? store.getFormat(linkAnchor).link : '');
  }, [linkAnchor, store]);

  const isSideActive = (side: keyof CellBorders) =>
    hasSelection && selectedArr.every((id) => store.getFormat(id).borders[side].enabled);

  // Keyboard activation for the div-based popover triggers (role="button") —
  // Enter/Space must work wherever click does.
  const keyActivate = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      (e.currentTarget as HTMLElement).click();
    }
  };

  function applyFmt(patch: Partial<CellFormat>) {
    selectedArr.forEach((id) => store.setFormat(id, { ...store.getFormat(id), ...patch }));
    if (selectedArr.length > 0) emitUserChange();
  }

  function toggleSide(side: keyof CellBorders) {
    selectedArr.forEach((id) => {
      const fmt = store.getFormat(id);
      const current: CellBorderSide = fmt.borders[side];
      const enabling = !current.enabled;
      store.setFormat(id, {
        ...fmt,
        borders: {
          ...fmt.borders,
          [side]: enabling
            ? { enabled: true, ...borderConfig }
            : { ...current, enabled: false },
        },
      });
    });
    if (selectedArr.length > 0) emitUserChange();
  }

  function applyAllBorders(enabled: boolean) {
    (['top', 'right', 'bottom', 'left'] as const).forEach((side) => {
      selectedArr.forEach((id) => {
        const fmt = store.getFormat(id);
        store.setFormat(id, {
          ...fmt,
          borders: {
            ...fmt.borders,
            [side]: enabled
              ? { enabled: true, ...borderConfig }
              : { ...fmt.borders[side], enabled: false },
          },
        });
      });
    });
    if (selectedArr.length > 0) emitUserChange();
  }

  // ── Build visible row/col sets (virtual + frozen) ─────────────────────────
  const virtualRowItems = rowVirt.getVirtualItems();
  const virtualColItems = colVirt.getVirtualItems();

  const rowSet = new Set<number>([
    ...virtualRowItems.map((v) => v.index),
    ...Array.from({ length: localFR }, (_, i) => i),
  ]);
  const colSet = new Set<number>([
    ...virtualColItems.map((v) => v.index),
    ...Array.from({ length: localFC }, (_, i) => i),
  ]);

  // ── Active cell reference label (for formula bar) ─────────────────────────
  const activeRef = (() => {
    const id = formulaEditingCell ?? (hasSelection ? selectedArr[0] : null);
    if (!id) return '';
    const m = /^R(\d+)C(\d+)$/.exec(id);
    return m ? cellRefStr(parseInt(m[1], 10), parseInt(m[2], 10)) : '';
  })();

  // ── Build grid cells ───────────────────────────────────────────────────────
  const gridCells: React.ReactElement[] = [];

  // Corner cell + column headers — hidden in locked mode
  if (!locked) {
    gridCells.push(
      <div
        key="corner"
        className="vg-cell vg-header-cell vg-corner-cell"
        style={{ gridRow: 1, gridColumn: 1, ...stickyStyle(true, true, -1, -1, localFR, localFC, layoutColWidths, effectiveRowHeights), ...frozenEdgeShadow(true, true) }}
        onClick={handleCornerClick}
      />,
    );

    for (let col = 0; col < localCols; col++) {
      gridCells.push(
        <div
          key={`H${col}`}
          className="vg-cell vg-header-cell"
          style={{
            gridRow: 1,
            gridColumn: col + 2,
            position: 'relative',
            ...stickyStyle(true, false, -1, col, localFR, localFC, layoutColWidths, effectiveRowHeights),
            ...frozenEdgeShadow(localFC > 0 && col === localFC - 1, true),
          }}
          onClick={(e) => handleColHeaderClick(e, col)}
          onContextMenu={(e) => handleColContextMenu(e, col)}
        >
          {colLetter(col)}
          <div
            className="vg-resize-handle vg-resize-handle--col"
            onMouseDown={(e) => {
              if (locked) return;
              e.preventDefault();
              e.stopPropagation();
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
              resizingRef.current = {
                type: 'col', index: col,
                startPos: e.clientX, startSize: colWidths[col] ?? COL_WIDTH,
              };
            }}
          />
        </div>,
      );
    }
  }

  // Data rows — only visible rows (rowSet)
  for (const row of rowSet) {
    if (hiddenRows?.has(row)) continue; // row filter hid this row — collapsed via gridTemplateRows below
    const rh = effectiveRowHeights[row] ?? ROW_HEIGHT;

    // Row number cell — hidden in locked mode
    if (!locked) {
      gridCells.push(
        <div
          key={`RN${row}`}
          className="vg-cell vg-rownum-cell"
          style={{
            gridRow: row + 2,
            gridColumn: 1,
            position: 'relative',
            height: rh,
            ...stickyStyle(false, true, row, -1, localFR, localFC, layoutColWidths, effectiveRowHeights),
            ...frozenEdgeShadow(true, localFR > 0 && row === localFR - 1),
          }}
          onClick={(e) => handleRowHeaderClick(e, row)}
          onContextMenu={(e) => handleRowContextMenu(e, row)}
        >
          {row + 1}
          <div
            className="vg-resize-handle vg-resize-handle--row"
            onMouseDown={(e) => {
              if (locked) return;
              e.preventDefault();
              e.stopPropagation();
              document.body.style.cursor = 'row-resize';
              document.body.style.userSelect = 'none';
              resizingRef.current = {
                type: 'row', index: row,
                startPos: e.clientY, startSize: rh,
              };
            }}
          />
        </div>,
      );
    }

    // When locked: grid starts at row 1 / col 1 (no header row or row-num column)
    const gridRowOffset = locked ? 1 : 2;
    const gridColOffset = locked ? 1 : 2;

    // Data cells — only visible columns (colSet)
    for (const col of colSet) {
      const cellId: CellId = `R${row}C${col}`;
      const fmt = store.getFormat(cellId);
      // Rules compare the COMPUTED value, not the formatted display string:
      // "1,234.50" parseFloats to 1 and "$1,234.50" to NaN, so threshold rules
      // on formatted columns would silently misfire.
      const cfPatch = evaluateConditionalRules(getComputedValue(cellId, store), conditionalRules, row, col);

      // In locked mode headers are absent so the first row/col have no outer border.
      // Add border-top on row 0 when horizontal lines are visible (all | rows),
      // and border-left on col 0 when vertical lines are visible (all | columns).
      const lockedTopBorder: React.CSSProperties =
        locked && row === 0 && (tableBorderStyle === 'all' || tableBorderStyle === 'rows')
          ? { borderTop: '1px solid var(--border-gray-default, #c4c4c4)' } : {};
      const lockedLeftBorder: React.CSSProperties =
        locked && col === 0 && (tableBorderStyle === 'all' || tableBorderStyle === 'columns')
          ? { borderLeft: '1px solid var(--border-gray-default, #c4c4c4)' } : {};

      const cellInlineStyle: React.CSSProperties = {
        gridRow: row + gridRowOffset,
        gridColumn: col + gridColOffset,
        height: rh,
        lineHeight: `${rh}px`,
        fontWeight: cfPatch.bold != null ? (cfPatch.bold ? 'bold' : 'normal') : (fmt.bold ? 'bold' : 'normal'),
        fontStyle: cfPatch.italic != null ? (cfPatch.italic ? 'italic' : 'normal') : (fmt.italic ? 'italic' : 'normal'),
        textDecoration: fmt.underline ? 'underline' : 'none',
        fontSize: fmt.fontSize,
        textAlign: fmt.textAlign,
        color: cfPatch.textColor ?? (fmt.textColor || undefined),
        backgroundColor: rowColors?.get(row) ?? cfPatch.cellColor ?? (fmt.cellColor || undefined),
        ...lockedTopBorder,
        ...lockedLeftBorder,
        ...cellBorderInlineStyle(fmt.borders),
        ...stickyStyle(false, false, row, col, localFR, localFC, layoutColWidths, effectiveRowHeights, !locked),
        ...frozenEdgeShadow(localFC > 0 && col === localFC - 1, localFR > 0 && row === localFR - 1),
        ...(formulaEditingCell !== null && formulaEditingCell !== cellId ? { cursor: 'cell' } : {}),
        ...(locked && fmt.link ? { cursor: 'pointer' } : {}),
      };

      const bound = boundCells?.get(cellId);
      const classNames = [
        'vg-cell',
        'vg-data-cell',
        selectedCells.has(cellId) ? 'vg-cell--selected' : '',
        formulaRefCells.has(cellId) ? 'vg-cell--formula-ref' : '',
        bound ? 'vg-cell--bound' : '',
        bound?.kind === 'series-base' ? 'vg-cell--series-base' : '',
        fmt.link ? 'vg-cell--link' : '',
        searchMatches?.has(cellId) ? 'vg-cell--match' : '',
        activeMatch === cellId ? 'vg-cell--match-active' : '',
        previewCells?.has(cellId) ? 'vg-cell--preview' : '',
        row < localFR ? 'vg-cell--frozen-row' : '',
        col < localFC ? 'vg-cell--frozen-col' : '',
      ]
        .filter(Boolean)
        .join(' ');

      gridCells.push(
        <div
          key={cellId}
          className={classNames}
          style={cellInlineStyle}
          title={bound ? bound.topic : (fmt.link || undefined)}
          contentEditable={!locked && !bound}
          suppressContentEditableWarning
          ref={(el: HTMLDivElement | null) => {
            if (el) {
              cellRefsMap.current.set(cellId, el);
              // Don't overwrite content while this cell is in edit mode
              if (editingCellRef.current !== cellId && document.activeElement !== el) {
                el.textContent = getDisplayValue(cellId, store, decimalsFor(cellId));
              }
            } else {
              cellRefsMap.current.delete(cellId);
            }
          }}
          onMouseDown={(e) => {
            // Locked or bound: never take browser focus — click still selects,
            // double-click still opens the config popover.
            if (locked || bound) { e.preventDefault(); return; }
            // Formula pick mode: keep focus on the formula cell
            if (formulaEditingCell && formulaEditingCell !== cellId) {
              e.preventDefault();
              return;
            }
            // Selection mode: prevent focus — single click only selects
            if (editingCellRef.current === null) {
              e.preventDefault();
            }
            // Edit mode on this cell or switching cells: allow natural browser focus
          }}
          onClick={(e) => {
            // A linked cell acts as a hyperlink for the viewer (locked mode) and
            // on Ctrl/Cmd-click while editing — the spreadsheet convention, so
            // the author can test a link without locking the table first.
            if (fmt.link && (locked || e.ctrlKey || e.metaKey)) {
              e.stopPropagation();
              window.open(fmt.link, '_blank', 'noopener,noreferrer');
              return;
            }
            handleCellClick(e, cellId);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (locked) return;
            // Standard spreadsheet convention: double-click edits the cell's
            // text. Bound cells aren't manually editable, so there double-click
            // opens the binding popover instead; unbound cells reach it via
            // right-click (context menu handler below).
            if (bound && onCellConfigure) {
              onCellConfigure(cellId, e.currentTarget.getBoundingClientRect());
            } else {
              enterEditMode(cellId);
            }
          }}
          onContextMenu={!locked ? (e) => {
            // Right-click opens the cell menu (clear, format, bind, row/column
            // ops). Left-click selection is preserved when the cell is already
            // part of the selection so a menu action can act on the whole block.
            e.preventDefault();
            e.stopPropagation();
            handleCellContextMenu(e, cellId, row, col);
          } : undefined}
          onFocus={(e) => {
            const el = e.currentTarget;
            // Focus that arrives OUTSIDE enterEditMode (click-through while
            // another cell was being edited) must still become a real edit
            // session: load the RAW value into the DOM. Otherwise the cell
            // holds its formatted display string ("5" for "=A1+1", "50.00%"
            // for 0.5) and the eventual blur-save destroys the formula/value.
            if (editingCellRef.current !== cellId) {
              editingCellRef.current = cellId;
              setEditingCell(cellId);
              el.textContent = store.getValue(cellId);
              moveCursor(el, el.textContent?.length ?? 0);
            }
            const content = el.textContent ?? '';
            if (content.startsWith('=')) {
              setFormulaEditingCell(cellId);
              setFormulaRefCells(extractFormulaRefs(content));
            }
          }}
          onInput={(e) => {
            const content = e.currentTarget.textContent ?? '';
            if (content.startsWith('=')) {
              if (formulaEditingCell !== cellId) setFormulaEditingCell(cellId);
              setFormulaRefCells(extractFormulaRefs(content));
            } else if (formulaEditingCell === cellId) {
              setFormulaEditingCell(null);
              setFormulaRefCells(new Set());
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
              navigateTo(row + 1, col);
            } else if (e.key === 'Tab') {
              e.preventDefault();
              e.currentTarget.blur();
              const dc = e.shiftKey ? -1 : 1;
              let nr = row, nc = col + dc;
              if (nc >= localCols) { nc = 0; nr++; }
              if (nc < 0) { nc = localCols - 1; nr--; }
              navigateTo(nr, nc);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              discardOnBlurRef.current = true;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            if (formulaEditingCell === cellId) {
              setFormulaEditingCell(null);
              setFormulaRefCells(new Set());
            }
            const wasEditing = editingCellRef.current === cellId;
            if (wasEditing) {
              editingCellRef.current = null;
              setEditingCell(null);
            }
            // Save ONLY when this blur ends an actual edit session — a cell
            // that was merely focused still shows its formatted display text,
            // and writing that back would overwrite the raw value/formula.
            if (wasEditing && !discardOnBlurRef.current) {
              const nextValue = e.currentTarget.textContent ?? '';
              if (store.getValue(cellId) !== nextValue) {
                store.setValue(cellId, nextValue);
                emitUserChange();
              }
            }
            discardOnBlurRef.current = false;
            requestAnimationFrame(() => {
              const el = cellRefsMap.current.get(cellId);
              if (el && document.activeElement !== el) {
                el.textContent = getDisplayValue(cellId, store, decimalsFor(cellId));
              }
            });
          }}
        />,
      );
    }
  }

  // ── Grid template strings ─────────────────────────────────────────────────
  // In locked mode headers are hidden: no row-num column and no header row in the template
  const gridTemplateColumns = locked
    ? layoutColWidths.map((w) => `${w}px`).join(' ')
    : `${ROW_NUM_WIDTH}px ${layoutColWidths.map((w) => `${w}px`).join(' ')}`;
  // effectiveRowHeights (hidden rows collapsed to 0) is computed above, next to
  // the virtualizer that shares it.
  const gridTemplateRows = locked
    ? effectiveRowHeights.map((h) => `${h}px`).join(' ')
    : `${ROW_HEIGHT}px ${effectiveRowHeights.map((h) => `${h}px`).join(' ')}`;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className="vg-root"
      onClick={() => { setSelectedCells(new Set()); setContextMenu(null); }}
    >
      {/* ── Formatting toolbar — not rendered at all when locked ── */}
      {!locked && <div
        className={`vg-toolbar${hasSelection ? '' : ' vg-toolbar--hidden'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <Button iconOnly aria-label="Bold" leadingIcon={<Bold size={14} />}      variant={isAllBold      ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ bold:      !isAllBold      })} />
        <Button iconOnly aria-label="Italic" leadingIcon={<Italic size={14} />}    variant={isAllItalic    ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ italic:    !isAllItalic    })} />
        <Button iconOnly aria-label="Underline" leadingIcon={<Underline size={14} />} variant={isAllUnderline ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ underline: !isAllUnderline })} />

        <span className="vg-divider" />

        <input
          ref={attachWheelStep}
          className="vg-font-size-input"
          type="number"
          min={8}
          max={72}
          value={currentFontSize}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === '-') e.preventDefault();
          }}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const size = Math.abs(parseInt(e.target.value, 10));
            if (!isNaN(size) && size >= 8 && size <= 72) applyFmt({ fontSize: size });
          }}
        />

        <span className="vg-divider" />

        <Button iconOnly aria-label="Align left" leadingIcon={<AlignLeft   size={14} />} variant={currentAlign === 'left'   ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ textAlign: 'left'   })} />
        <Button iconOnly aria-label="Align center" leadingIcon={<AlignCenter size={14} />} variant={currentAlign === 'center' ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ textAlign: 'center' })} />
        <Button iconOnly aria-label="Align right" leadingIcon={<AlignRight  size={14} />} variant={currentAlign === 'right'  ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ textAlign: 'right'  })} />

        <span className="vg-divider" />

        {/* Number format picker */}
        <select
          className="vg-numfmt-select"
          value={currentNumberFormat}
          onChange={(e) => applyFmt({ numberFormat: e.target.value as NumberFormat })}
        >
          <option value="general">General</option>
          <option value="number">1,234.56</option>
          <option value="integer">1,234</option>
          <option value="percent">%</option>
          <option value="currency">$</option>
        </select>

        {/* Decimal places for the selection — blank inherits the widget default */}
        <span className="vg-numfmt-decimals" title="Decimal places (blank = widget default)">
          <Hash size={11} />
          <input
            ref={attachWheelStep}
            className="vg-font-size-input vg-font-size-input--narrow"
            type="number"
            min={0}
            max={10}
            placeholder={dataPrecision === null ? '—' : String(dataPrecision)}
            value={currentDecimals === null ? '' : currentDecimals}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === '-') e.preventDefault();
            }}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const raw = e.target.value;
              if (raw === '') { applyFmt({ decimals: null }); return; }
              const d = Math.abs(parseInt(raw, 10));
              if (!isNaN(d) && d <= 10) applyFmt({ decimals: d });
            }}
          />
        </span>

        <span className="vg-divider" />

        {/* Clear the selected cells' contents */}
        <Button
          iconOnly
          aria-label="Clear cell contents"
          leadingIcon={<XSquare size={14} />}
          variant="Gray"
          size="XSmall"
          onClick={() => clearContents(selectedArr)}
        />

        <span className="vg-divider" />

        {/* Text color */}
        <Popover
          trigger={
            <div className="vg-color-trigger" role="button" tabIndex={0} title="Text color" onKeyDown={keyActivate}>
              <Type size={13} />
              <span className="vg-color-trigger__bar" style={{ backgroundColor: currentTextColor || '#1a1a1a' }} />
            </div>
          }
          placement="Bottom Start"
        >
          <PopoverHeader title="Text Color" showClose />
          <PopoverBody>
            <div className="vg-color-panel" onClick={(e) => e.stopPropagation()}>
              <ColorInput
                value={currentTextColor || '#1a1a1a'}
                onChange={(color: string) => applyFmt({ textColor: color })}
              />
            </div>
          </PopoverBody>
        </Popover>

        {/* Fill color */}
        <Popover
          trigger={
            <div className="vg-color-trigger" role="button" tabIndex={0} title="Fill color" onKeyDown={keyActivate}>
              <Droplet size={13} />
              <span
                className="vg-color-trigger__bar"
                style={{
                  backgroundColor: currentCellColor || 'transparent',
                  border: currentCellColor ? 'none' : '1px solid var(--fds-border-subtle, #ddd)',
                }}
              />
            </div>
          }
          placement="Bottom Start"
        >
          <PopoverHeader title="Fill Color" showClose />
          <PopoverBody>
            <div className="vg-color-panel" onClick={(e) => e.stopPropagation()}>
              <ColorInput
                value={currentCellColor || '#ffffff'}
                onChange={(color: string) => applyFmt({ cellColor: color })}
              />
            </div>
          </PopoverBody>
        </Popover>

        <span className="vg-divider" />

        {/* Cell hyperlink */}
        <Popover
          trigger={
            <Button iconOnly aria-label="Cell link" leadingIcon={<LinkIcon size={14} />} variant={currentLink ? 'Primary' : 'Gray'} size="XSmall" />
          }
          placement="Bottom Start"
        >
          <PopoverHeader title="Cell Link" showClose />
          <PopoverBody>
            <div className="vg-link-panel" onClick={(e) => e.stopPropagation()}>
              <TextInput
                label="URL"
                placeholder="https://…"
                value={linkDraft}
                onChange={({ value }: { name: string; value: string }) => setLinkDraft(value)}
              />
              <div className="vg-link-panel__row">
                <Button variant="Primary" size="XSmall" label="Apply" onClick={() => applyFmt({ link: linkDraft.trim() })} />
                <Button variant="Secondary" size="XSmall" label="Remove" onClick={() => { setLinkDraft(''); applyFmt({ link: '' }); }} />
              </div>
              <p className="vg-link-panel__hint">Opens on click when the table is locked, or on Ctrl/Cmd-click while editing.</p>
            </div>
          </PopoverBody>
        </Popover>

        <span className="vg-divider" />

        {/* Cell borders */}
        <Popover
          trigger={
            <Button iconOnly aria-label="Cell borders" leadingIcon={<Grid size={14} />} variant="Gray" size="XSmall" />
          }
          placement="Bottom End"
        >
          <PopoverHeader title="Cell Borders" showClose />
          <PopoverBody>
            <div className="vg-border-panel" onClick={(e) => e.stopPropagation()}>

              <div className="vg-border-diagram">
                <div className="vg-border-diagram__top"    data-active={String(isSideActive('top'))}    title="Top border"    onClick={() => toggleSide('top')}    />
                <div className="vg-border-diagram__bottom" data-active={String(isSideActive('bottom'))} title="Bottom border" onClick={() => toggleSide('bottom')} />
                <div className="vg-border-diagram__left"   data-active={String(isSideActive('left'))}   title="Left border"   onClick={() => toggleSide('left')}   />
                <div className="vg-border-diagram__right"  data-active={String(isSideActive('right'))}  title="Right border"  onClick={() => toggleSide('right')}  />
                <div className="vg-border-diagram__cell" />
              </div>

              <div className="vg-border-panel__row">
                <Button variant="Secondary" size="XSmall" label="All"  onClick={() => applyAllBorders(true)}  />
                <Button variant="Secondary" size="XSmall" label="None" onClick={() => applyAllBorders(false)} />
              </div>

              <p className="vg-border-panel__label">Style</p>
              <div className="vg-border-panel__row">
                {(['solid', 'dashed', 'dotted'] as const).map((s) => (
                  <div
                    key={s}
                    className={`vg-border-style-btn${borderConfig.style === s ? ' vg-border-style-btn--active' : ''}`}
                    onClick={() => setBorderConfig((c) => ({ ...c, style: s }))}
                    title={s}
                  >
                    <div className="vg-border-style-btn__line" style={{ borderTopStyle: s }} />
                  </div>
                ))}
              </div>

              <p className="vg-border-panel__label">Width</p>
              <div className="vg-border-panel__row">
                {([1, 2, 3] as const).map((w) => (
                  <div
                    key={w}
                    className={`vg-border-style-btn${borderConfig.width === w ? ' vg-border-style-btn--active' : ''}`}
                    onClick={() => setBorderConfig((c) => ({ ...c, width: w }))}
                    title={`${w}px`}
                  >
                    <div className="vg-border-style-btn__line" style={{ borderTopWidth: w }} />
                  </div>
                ))}
              </div>

              <p className="vg-border-panel__label">Color</p>
              <div className="vg-color-panel">
                <ColorInput
                  value={borderConfig.color}
                  onChange={(color: string) => setBorderConfig((c) => ({ ...c, color }))}
                />
              </div>

            </div>
          </PopoverBody>
        </Popover>

      </div>}

      {/* ── Formula bar — not rendered at all when locked ── */}
      {!locked && (
        <div className="vg-formula-bar" onClick={(e) => e.stopPropagation()}>
          <div className="vg-formula-bar__name">{activeRef}</div>
          <span className="vg-formula-bar__fx">ƒx</span>
          <div className={`vg-formula-bar__content${formulaEditingCell ? ' vg-formula-bar__content--picking' : ''}`}>
            {formulaEditingCell
              ? 'Click a cell to insert its reference'
              : hasSelection ? store.getValue(selectedArr[0]) : ''}
          </div>
        </div>
      )}

      {/* ── Grid ── */}
      <div
        className={`vg-grid-wrap${fitToWidth ? ' vg-grid-wrap--fit-x' : ''}`}
        ref={gridWrapRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (document.activeElement !== gridWrapRef.current) return;
          const id = [...selectedCells][0];

          if (!locked && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            if (!id) return;
            const m = /^R(\d+)C(\d+)$/.exec(id)!;
            let r = parseInt(m[1], 10), c = parseInt(m[2], 10);
            if (e.key === 'ArrowDown')  r++;
            if (e.key === 'ArrowUp')    r--;
            if (e.key === 'ArrowRight') c++;
            if (e.key === 'ArrowLeft')  c--;
            r = Math.max(0, Math.min(localRows - 1, r));
            c = Math.max(0, Math.min(localCols - 1, c));
            const nextId: CellId = `R${r}C${c}`;
            setSelectedCells(new Set([nextId]));
            rowVirt.scrollToIndex(r, { align: 'auto' });
            colVirt.scrollToIndex(c, { align: 'auto' });
          } else if (!locked && (e.key === 'Enter' || e.key === 'F2')) {
            e.preventDefault();
            if (id) enterEditMode(id);
          } else if (!locked && (e.key === 'Backspace' || e.key === 'Delete')) {
            e.preventDefault();
            clearContents([...selectedCells]);
          } else if (!locked && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
            // Printable char: enter edit mode with that character (overwrites)
            if (id && !isBound(id)) {
              e.preventDefault();
              enterEditMode(id, e.key);
            }
          }
        }}
      >
        <div
          className={`vg-grid vg-grid--border-${tableBorderStyle}`}
          style={{ gridTemplateColumns, gridTemplateRows }}
        >
          {gridCells}
        </div>
      </div>

      {/* ── Context menu ── */}
      {contextMenu && (
        <div
          className="vg-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'cell' ? (
            <>
              <button
                className="vg-context-menu__item"
                onClick={() => {
                  const ids = targetCells(`R${contextMenu.index}C${contextMenu.col}`);
                  setContextMenu(null);
                  clearContents(ids);
                }}
              >Clear contents</button>
              <button
                className="vg-context-menu__item"
                onClick={() => {
                  const ids = targetCells(`R${contextMenu.index}C${contextMenu.col}`);
                  setContextMenu(null);
                  clearFormatting(ids);
                }}
              >Clear formatting</button>
              {onCellConfigure && (
                <>
                  <div className="vg-context-menu__sep" />
                  <button
                    className="vg-context-menu__item"
                    onClick={() => {
                      const cellId: CellId = `R${contextMenu.index}C${contextMenu.col}`;
                      const el = cellRefsMap.current.get(cellId);
                      setContextMenu(null);
                      if (el) onCellConfigure(cellId, el.getBoundingClientRect());
                    }}
                  >
                    <Settings size={11} /> Bind to UNS topic…
                  </button>
                </>
              )}
              <div className="vg-context-menu__sep" />
              <button className="vg-context-menu__item" onClick={() => insertRowAt(contextMenu.index)}>Insert row above</button>
              <button className="vg-context-menu__item" onClick={() => insertColAt(contextMenu.col ?? 0)}>Insert column left</button>
              <div className="vg-context-menu__sep" />
              <button className="vg-context-menu__item vg-context-menu__item--danger" onClick={() => deleteRowAt(contextMenu.index)}>Delete row</button>
              <button className="vg-context-menu__item vg-context-menu__item--danger" onClick={() => deleteColAt(contextMenu.col ?? 0)}>Delete column</button>
            </>
          ) : contextMenu.type === 'col' ? (
            <>
              <button className="vg-context-menu__item" onClick={() => insertColAt(contextMenu.index)}>Insert column left</button>
              <button className="vg-context-menu__item" onClick={() => insertColAt(contextMenu.index + 1)}>Insert column right</button>
              <div className="vg-context-menu__sep" />
              <button className="vg-context-menu__item vg-context-menu__item--danger" onClick={() => deleteColAt(contextMenu.index)}>Delete column</button>
              <div className="vg-context-menu__sep" />
              <button className="vg-context-menu__item" onClick={() => { setLocalFC(contextMenu.index + 1); setContextMenu(null); emitUserChange({ freezeColumns: contextMenu.index + 1 }); }}>Freeze up to here</button>
              {localFC > 0 && (
                <button className="vg-context-menu__item" onClick={() => { setLocalFC(0); setContextMenu(null); emitUserChange({ freezeColumns: 0 }); }}>Unfreeze columns</button>
              )}
            </>
          ) : (
            <>
              <button className="vg-context-menu__item" onClick={() => insertRowAt(contextMenu.index)}>Insert row above</button>
              <button className="vg-context-menu__item" onClick={() => insertRowAt(contextMenu.index + 1)}>Insert row below</button>
              <div className="vg-context-menu__sep" />
              <button className="vg-context-menu__item vg-context-menu__item--danger" onClick={() => deleteRowAt(contextMenu.index)}>Delete row</button>
              <div className="vg-context-menu__sep" />
              <button className="vg-context-menu__item" onClick={() => { setLocalFR(contextMenu.index + 1); setContextMenu(null); emitUserChange({ freezeRows: contextMenu.index + 1 }); }}>Freeze up to here</button>
              {localFR > 0 && (
                <button className="vg-context-menu__item" onClick={() => { setLocalFR(0); setContextMenu(null); emitUserChange({ freezeRows: 0 }); }}>Unfreeze rows</button>
              )}
            </>
          )}
        </div>
      )}

    </div>
  );
}
