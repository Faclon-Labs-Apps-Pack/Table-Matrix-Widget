import { useState, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button, Popover, PopoverHeader, PopoverBody, ColorPicker } from '@faclon-labs/design-sdk';
import { Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight, Grid, Droplet, Type } from 'react-feather';
import { CellDataStore, CellId } from './CellDataStore';
import { getDisplayValue, applyNumberFormat, evaluateConditionalRules } from './formulaEngine';
import { CellFormat, CellBorders, CellBorderSide, BorderStyle, BorderWidth, TextAlign, NumberFormat, ConditionalRule, TableBorderStyle } from '../../iosense-sdk/types';
import './VirtualGrid.css';

const ROW_HEIGHT = 32;
const ROW_NUM_WIDTH = 40;
const COL_WIDTH = 100;
const MIN_COL_WIDTH = 30;
const MIN_ROW_HEIGHT = 18;

interface VirtualGridProps {
  rows: number;
  columns: number;
  freezeRows: number;
  freezeColumns: number;
  store: CellDataStore;
  conditionalRules: ConditionalRule[];
  locked?: boolean;
  tableBorderStyle?: TableBorderStyle;
}

interface ContextMenuState {
  type: 'col' | 'row';
  index: number;
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

export function VirtualGrid({ rows, columns, freezeRows, freezeColumns, store, conditionalRules, locked = false, tableBorderStyle = 'all' }: VirtualGridProps) {
  // ── Selection ──────────────────────────────────────────────────────────────
  const [selectedCells, setSelectedCells] = useState<Set<CellId>>(new Set());
  const [tick, setTick] = useState(0);
  const selectedCellsRef = useRef<Set<CellId>>(new Set());
  useEffect(() => { selectedCellsRef.current = selectedCells; }, [selectedCells]);

  // ── Resize state ───────────────────────────────────────────────────────────
  const [colWidths, setColWidths] = useState<number[]>(() => Array(columns).fill(COL_WIDTH));
  const [rowHeights, setRowHeights] = useState<number[]>(() => Array(rows).fill(ROW_HEIGHT));
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

  // Clear selection immediately when locked so no cell stays highlighted
  useEffect(() => {
    if (locked) setSelectedCells(new Set());
  }, [locked]);

  // ── Store subscription ────────────────────────────────────────────────────
  useEffect(() => store.subscribe(() => setTick((t) => t + 1)), [store]);
  void tick;

  // ── TanStack Virtual ──────────────────────────────────────────────────────
  const rowVirt = useVirtualizer({
    count: localRows,
    getScrollElement: () => gridWrapRef.current,
    estimateSize: (i) => rowHeights[i] ?? ROW_HEIGHT,
    overscan: 5,
  });

  const colVirt = useVirtualizer({
    count: localCols,
    getScrollElement: () => gridWrapRef.current,
    estimateSize: (i) => colWidths[i] ?? COL_WIDTH,
    overscan: 3,
    horizontal: true,
  });

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
      resizingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
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
          cols.push(cells.has(id) ? getDisplayValue(id, store) : '');
        }
        lines.push(cols.join('\t'));
      }
      return lines.join('\n');
    }

    function onCopy(e: ClipboardEvent) {
      const sel = selectedCellsRef.current;
      if (sel.size === 0) return;
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', buildCopyText(sel));
    }

    function onPaste(e: ClipboardEvent) {
      if (locked) return;
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
      pasteRows.forEach((pasteRow, ri) => {
        pasteRow.forEach((value, ci) => {
          const r = anchorR + ri;
          const c = anchorC + ci;
          if (r < localRowsRef.current && c < localColsRef.current)
            store.setValue(`R${r}C${c}`, value);
        });
      });
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
        store.setValue(prev, editingEl.textContent ?? '');
        editingCellRef.current = null;
        setEditingCell(null);
        setFormulaEditingCell(null);
        setFormulaRefCells(new Set());
        requestAnimationFrame(() => {
          if (document.activeElement !== editingEl)
            editingEl.textContent = getDisplayValue(prev, store);
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
    setLocalRows((r) => r + 1);
    setRowHeights((prev) => { const n = [...prev]; n.splice(at, 0, ROW_HEIGHT); return n; });
    if (localFR > at) setLocalFR((f) => f + 1);
    setSelectedCells(new Set());
    setContextMenu(null);
  }

  function deleteRowAt(at: number) {
    if (localRows <= 1) return;
    store.deleteRow(at);
    setLocalRows((r) => r - 1);
    setRowHeights((prev) => { const n = [...prev]; n.splice(at, 1); return n; });
    if (localFR > at) setLocalFR((f) => Math.max(0, f - 1));
    setSelectedCells(new Set());
    setContextMenu(null);
  }

  // ── Insert / delete columns ────────────────────────────────────────────────
  function insertColAt(at: number) {
    store.insertCol(at);
    setLocalCols((c) => c + 1);
    setColWidths((prev) => { const n = [...prev]; n.splice(at, 0, COL_WIDTH); return n; });
    if (localFC > at) setLocalFC((f) => f + 1);
    setSelectedCells(new Set());
    setContextMenu(null);
  }

  function deleteColAt(at: number) {
    if (localCols <= 1) return;
    store.deleteCol(at);
    setLocalCols((c) => c - 1);
    setColWidths((prev) => { const n = [...prev]; n.splice(at, 1); return n; });
    if (localFC > at) setLocalFC((f) => Math.max(0, f - 1));
    setSelectedCells(new Set());
    setContextMenu(null);
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

  const isSideActive = (side: keyof CellBorders) =>
    hasSelection && selectedArr.every((id) => store.getFormat(id).borders[side].enabled);

  function applyFmt(patch: Partial<CellFormat>) {
    selectedArr.forEach((id) => store.setFormat(id, { ...store.getFormat(id), ...patch }));
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
        style={{ gridRow: 1, gridColumn: 1, ...stickyStyle(true, true, -1, -1, localFR, localFC, colWidths, rowHeights), ...frozenEdgeShadow(true, true) }}
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
            ...stickyStyle(true, false, -1, col, localFR, localFC, colWidths, rowHeights),
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
    const rh = rowHeights[row] ?? ROW_HEIGHT;

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
            ...stickyStyle(false, true, row, -1, localFR, localFC, colWidths, rowHeights),
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
      const cfPatch = evaluateConditionalRules(getDisplayValue(cellId, store), conditionalRules, row, col);

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
        backgroundColor: cfPatch.cellColor ?? (fmt.cellColor || undefined),
        ...lockedTopBorder,
        ...lockedLeftBorder,
        ...cellBorderInlineStyle(fmt.borders),
        ...stickyStyle(false, false, row, col, localFR, localFC, colWidths, rowHeights, !locked),
        ...frozenEdgeShadow(localFC > 0 && col === localFC - 1, localFR > 0 && row === localFR - 1),
        ...(formulaEditingCell !== null && formulaEditingCell !== cellId ? { cursor: 'cell' } : {}),
      };

      const classNames = [
        'vg-cell',
        'vg-data-cell',
        selectedCells.has(cellId) ? 'vg-cell--selected' : '',
        formulaRefCells.has(cellId) ? 'vg-cell--formula-ref' : '',
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
          contentEditable={!locked}
          suppressContentEditableWarning
          ref={(el: HTMLDivElement | null) => {
            if (el) {
              cellRefsMap.current.set(cellId, el);
              // Don't overwrite content while this cell is in edit mode
              if (editingCellRef.current !== cellId && document.activeElement !== el) {
                el.textContent = getDisplayValue(cellId, store);
              }
            } else {
              cellRefsMap.current.delete(cellId);
            }
          }}
          onMouseDown={(e) => {
            // Locked: always prevent browser focus — selection still works via click
            if (locked) { e.preventDefault(); return; }
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
          onClick={(e) => handleCellClick(e, cellId)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (!locked) enterEditMode(cellId);
          }}
          onFocus={(e) => {
            // Content is set by enterEditMode; just detect formula mode from current content
            const content = e.currentTarget.textContent ?? '';
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
            if (editingCellRef.current === cellId) {
              editingCellRef.current = null;
              setEditingCell(null);
            }
            if (!discardOnBlurRef.current) {
              store.setValue(cellId, e.currentTarget.textContent ?? '');
            }
            discardOnBlurRef.current = false;
            requestAnimationFrame(() => {
              const el = cellRefsMap.current.get(cellId);
              if (el && document.activeElement !== el) {
                el.textContent = getDisplayValue(cellId, store);
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
    ? colWidths.slice(0, localCols).map((w) => `${w}px`).join(' ')
    : `${ROW_NUM_WIDTH}px ${colWidths.slice(0, localCols).map((w) => `${w}px`).join(' ')}`;
  const gridTemplateRows = locked
    ? rowHeights.slice(0, localRows).map((h) => `${h}px`).join(' ')
    : `${ROW_HEIGHT}px ${rowHeights.slice(0, localRows).map((h) => `${h}px`).join(' ')}`;

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
        <Button iconOnly leadingIcon={<Bold size={14} />}      variant={isAllBold      ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ bold:      !isAllBold      })} />
        <Button iconOnly leadingIcon={<Italic size={14} />}    variant={isAllItalic    ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ italic:    !isAllItalic    })} />
        <Button iconOnly leadingIcon={<Underline size={14} />} variant={isAllUnderline ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ underline: !isAllUnderline })} />

        <span className="vg-divider" />

        <input
          className="vg-font-size-input"
          type="number"
          min={8}
          max={72}
          value={currentFontSize}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const size = parseInt(e.target.value, 10);
            if (!isNaN(size) && size >= 8 && size <= 72) applyFmt({ fontSize: size });
          }}
        />

        <span className="vg-divider" />

        <Button iconOnly leadingIcon={<AlignLeft   size={14} />} variant={currentAlign === 'left'   ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ textAlign: 'left'   })} />
        <Button iconOnly leadingIcon={<AlignCenter size={14} />} variant={currentAlign === 'center' ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ textAlign: 'center' })} />
        <Button iconOnly leadingIcon={<AlignRight  size={14} />} variant={currentAlign === 'right'  ? 'Primary' : 'Gray'} size="XSmall" onClick={() => applyFmt({ textAlign: 'right'  })} />

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

        <span className="vg-divider" />

        {/* Text color */}
        <Popover
          trigger={
            <div className="vg-color-trigger" role="button" tabIndex={0} title="Text color">
              <Type size={13} />
              <span className="vg-color-trigger__bar" style={{ backgroundColor: currentTextColor || '#1a1a1a' }} />
            </div>
          }
          placement="Bottom Start"
        >
          <PopoverHeader title="Text Color" showClose />
          <PopoverBody>
            <ColorPicker
              selectedColor={currentTextColor || '#1a1a1a'}
              onColorSelect={(color) => applyFmt({ textColor: color })}
            />
          </PopoverBody>
        </Popover>

        {/* Fill color */}
        <Popover
          trigger={
            <div className="vg-color-trigger" role="button" tabIndex={0} title="Fill color">
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
            <ColorPicker
              selectedColor={currentCellColor || '#ffffff'}
              onColorSelect={(color) => applyFmt({ cellColor: color })}
            />
          </PopoverBody>
        </Popover>

        <span className="vg-divider" />

        {/* Cell borders */}
        <Popover
          trigger={
            <Button iconOnly leadingIcon={<Grid size={14} />} variant="Gray" size="XSmall" />
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
              <Popover
                trigger={
                  <div className="vg-color-trigger vg-color-trigger--wide" role="button" tabIndex={0} title="Border color">
                    <span className="vg-color-trigger__swatch-wide" style={{ backgroundColor: borderConfig.color }} />
                    <span className="vg-color-trigger__hex">{borderConfig.color}</span>
                  </div>
                }
                placement="Right Start"
              >
                <PopoverHeader title="Border Color" showClose />
                <PopoverBody>
                  <ColorPicker
                    selectedColor={borderConfig.color}
                    onColorSelect={(color) => setBorderConfig((c) => ({ ...c, color }))}
                  />
                </PopoverBody>
              </Popover>

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
        className="vg-grid-wrap"
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
            [...selectedCells].forEach((sid) => store.setValue(sid, ''));
          } else if (!locked && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
            // Printable char: enter edit mode with that character (overwrites)
            if (id) {
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
          {contextMenu.type === 'col' ? (
            <>
              <button className="vg-context-menu__item" onClick={() => insertColAt(contextMenu.index)}>Insert column left</button>
              <button className="vg-context-menu__item" onClick={() => insertColAt(contextMenu.index + 1)}>Insert column right</button>
              <div className="vg-context-menu__sep" />
              <button className="vg-context-menu__item vg-context-menu__item--danger" onClick={() => deleteColAt(contextMenu.index)}>Delete column</button>
              <div className="vg-context-menu__sep" />
              <button className="vg-context-menu__item" onClick={() => { setLocalFC(contextMenu.index + 1); setContextMenu(null); }}>Freeze up to here</button>
              {localFC > 0 && (
                <button className="vg-context-menu__item" onClick={() => { setLocalFC(0); setContextMenu(null); }}>Unfreeze columns</button>
              )}
            </>
          ) : (
            <>
              <button className="vg-context-menu__item" onClick={() => insertRowAt(contextMenu.index)}>Insert row above</button>
              <button className="vg-context-menu__item" onClick={() => insertRowAt(contextMenu.index + 1)}>Insert row below</button>
              <div className="vg-context-menu__sep" />
              <button className="vg-context-menu__item vg-context-menu__item--danger" onClick={() => deleteRowAt(contextMenu.index)}>Delete row</button>
              <div className="vg-context-menu__sep" />
              <button className="vg-context-menu__item" onClick={() => { setLocalFR(contextMenu.index + 1); setContextMenu(null); }}>Freeze up to here</button>
              {localFR > 0 && (
                <button className="vg-context-menu__item" onClick={() => { setLocalFR(0); setContextMenu(null); }}>Unfreeze rows</button>
              )}
            </>
          )}
        </div>
      )}

    </div>
  );
}
