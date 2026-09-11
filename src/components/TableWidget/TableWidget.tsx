import { useRef, useEffect, useMemo, useState } from 'react';
import { Button, TextInput, Chip, Checkbox, Popover, PopoverHeader, PopoverBody, UNSTreePicker, SearchInput, Tooltip } from '@faclon-labs/design-sdk';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@faclon-labs/design-sdk/Modal';
import { ChartActions } from '@faclon-labs/design-sdk/Chart';
import type { UNSNode, UNSWorkspace } from '@faclon-labs/design-sdk/UNSTreePicker';
import { Download, ArrowDown, ArrowRight, Trash2, Filter, ChevronUp, ChevronDown } from 'react-feather';
import { DataEntry, WidgetEvent, SeriesDirection, PersistedCell, TableWidgetUIConfig, DataFormat } from '../../iosense-sdk/types';
import { PartialTableWidgetUIConfig, withTableWidgetDefaults } from '../../iosense-sdk/defaults';
import { useUNSTreePicker } from '../../iosense-sdk/useUNSTreePicker';
import { useZoneIgnorePortals } from '../../iosense-sdk/zoneIgnorePortals';
import { buildDynamicBindingPathList } from '../../iosense-sdk/bindings';
import { CellDataStore, CellId, isDefaultFormat } from './CellDataStore';
import { buildXlsx, XlsxValue } from './xlsx';
import { NumberField } from './NumberField';
import { VirtualGrid, GridGeometry } from './VirtualGrid';
import { computeBoundCells, seriesPreviewCells, remapForGridMutation, GridMutation, RemappableConfig } from './bindingMap';
import { getDisplayValue, cellIdToRef } from './formulaEngine';
import { ROW_FILTER_ICONS, computeFilterInstances, computeRowFilterVisibility, hexToRgba } from './rowFilter';
import './TableWidget.css';

// A cell holds one binding kind at a time in the Cell Config popover.
type CellConfigKind = 'single' | 'series';
type DownloadFormat = 'csv' | 'xlsx';

// Chrome the user operates rather than looks at. Two quick clicks on a toolbar
// button, or a double-click to select a word in the search box, are ordinary
// use of the control — not a request to open the configuration panel.
const CONTROL_SELECTOR =
  'button, input, select, textarea, a, [role="button"], .vg-toolbar, .vg-formula-bar, .tw-search, .tw-actions, .tw-filter-bar';

function isControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CONTROL_SELECTOR) !== null;
}

// A cell that reads as a plain number goes into the sheet as one; anything else
// (text, or a number carrying a unit) stays a string.
function toXlsxValue(text: string): XlsxValue {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) && /^[-+]?[\d,]*\.?\d+$/.test(trimmed) ? n : text;
}

// A cell no binding fills: no rounding, no suffix.
const NO_DATA_FORMAT: DataFormat = { precision: null, unit: '' };

const SERIES_PREVIEW_FALLBACK = 5; // cells previewed when limit is 0 (fill-all)

// Render a resolved scalar to the cell's string value.
function scalarToString(value: unknown): string {
  return value != null ? String(value) : '';
}

// The `data` prop as an array, whatever shape the host handed over. The dev
// mini-engine always passes DataEntry[], but a host engine may pass the
// resolve result keyed by binding key ({ "series:R1C0": { … } }) — iterating
// that with for..of throws, which would take the whole widget down rather than
// just leaving the cells empty.
function toEntries(data: unknown): DataEntry[] {
  if (Array.isArray(data)) return data as DataEntry[];
  if (data && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>).map(([key, value]) => {
      const v = value as { key?: string; value?: unknown; slots?: unknown };
      return (v && typeof v === 'object' && ('value' in v || 'slots' in v)
        ? { ...(v as object), key }
        : { key, value }) as DataEntry;
    });
  }
  return [];
}

type SeriesPoint = string | number | boolean | null;

// The ordered data points a series binding lays out across cells.
//
// `slots` on the DataEntry is the authoritative source when present — that's the
// bucketed series row (`{ from, to, label, value, quality }` per bucket) the
// mini-engine carries through. A `quality: 'no_data'` bucket has `value: null`
// and stays in the list so the points keep their position on the time axis; it
// just lands as an empty cell.
function toSeriesPoints(entry: DataEntry): SeriesPoint[] {
  if (entry.slots) return entry.slots.map((slot) => slot.value);
  return toPoints(entry.value);
}

// Coerce whatever a series binding resolved to into a flat point list. The
// mini-engine already flattens a slots row to an array of slot values, but a
// host engine may hand the raw resolve row straight through — the whole
// `{ key, path, meta, range, slots: [...] }` object, or a bare array of slot
// objects — and a topic may still resolve to a JSON-encoded array or a
// comma-separated string. Every one of those has to reduce to the same list.
function toPoints(value: unknown): SeriesPoint[] {
  if (Array.isArray(value)) return value.map(unwrapPoint);

  if (typeof value === 'string') {
    const t = value.trim();
    if (t === '') return [];
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        return toPoints(JSON.parse(t));
      } catch { /* not JSON — fall through to CSV split */ }
    }
    return t.split(',').map((s) => s.trim());
  }

  if (value == null) return [];

  // A resolve row (or any wrapper) handed through unflattened: dig out the
  // bucket array and unwrap each bucket to its value.
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['slots', 'values', 'points', 'data']) {
      if (Array.isArray(obj[key])) return (obj[key] as unknown[]).map(unwrapPoint);
    }
    return 'value' in obj ? [unwrapPoint(obj)] : [];
  }

  return [value as SeriesPoint];
}

// One point, from either a scalar or a `{ ..., value }` bucket object.
function unwrapPoint(v: unknown): SeriesPoint {
  if (v !== null && typeof v === 'object' && 'value' in (v as object)) {
    return (v as { value: SeriesPoint }).value;
  }
  return v as SeriesPoint;
}

interface TableWidgetProps {
  // The host may mount a freshly-added instance with a partial/absent uiConfig,
  // so accept any subset of keys and fill the rest from defaults below.
  config?: PartialTableWidgetUIConfig;
  data?: DataEntry[];
  onEvent: (event: WidgetEvent) => void;
  /** Enables on-canvas configuration: double-click a cell to bind it to a UNS
   *  topic. Binding edits are emitted as an onEvent CONFIG_CHANGE — the widget
   *  never writes the envelope itself; the host persists it. */
  editable?: boolean;
  /** Host is showing this widget in edit mode (true) or view mode (false). */
  editMode?: boolean;
  /** Host persists canvas CONFIG_CHANGE. Only the new IOSense host sends it. */
  canvasConfig?: boolean;
  /** UNS topic-browser injection for the Cell Config popover. When absent the
   *  popover falls back to a plain text field (paste a topic). Same contract the
   *  configurator uses; the host provides these. */
  unsWorkspaces?: UNSWorkspace[];
  isLoadingWorkspaces?: boolean;
  loadUnsChildren?: (wsId: string, parentId?: string) => Promise<UNSNode[]>;
  searchUnsNodes?: (wsId: string, query: string, limit?: number) => Promise<UNSNode[]>;
  /** Bearer token used only when the host injects no UNS source (dev harness). */
  authentication?: string;
}

// Reports whether an element's text is actually being clipped, so the full
// text can be offered on hover *only* when it is — a short title that fits
// should not sprout a redundant tooltip.
//
// Element identity is held in state rather than a ref so the effect re-runs
// when the node mounts or unmounts (the title is conditional on having one).
// ResizeObserver covers the dashboard resizing the tile; `deps` covers the
// changes it cannot see, where the box stays put but the text stops fitting —
// a new title, or a font size/weight change from the configurator.
function useIsTruncated(deps: unknown[]) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useEffect(() => {
    if (!el) {
      setIsTruncated(false);
      return;
    }
    const measure = () => setIsTruncated(el.scrollWidth > el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, ...deps]);

  return { setEl, isTruncated };
}

export function TableWidget(props: TableWidgetProps) {
  const { config, data, onEvent, editable: editableProp, editMode, canvasConfig, unsWorkspaces, isLoadingWorkspaces, loadUnsChildren, searchUnsNodes, authentication } = props;
  // Only a host that persists canvas CONFIG_CHANGE may receive one: anywhere
  // else a cell edit would appear to save and then vanish on the next load.
  const canPersist = canvasConfig === true;
  const editable = editableProp ?? false;                          // binding popover: explicit prop only
  const emitsCellEdits = editableProp ?? (canPersist && editMode === true);
  const storeRef = useRef<CellDataStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new CellDataStore();
  }

  // Dev harness log — config changes
  useEffect(() => {
    console.log('[TableWidget] config received', config);
  }, [config]);

  // The host may mount a freshly-added instance with a partial (or absent) uiConfig
  // before the configurator emits a complete envelope. Merge over defaults so every
  // key read below is guaranteed present — no `config.style` / `config.title` crashes.
  const cfg = useMemo(() => withTableWidgetDefaults(config), [config]);

  // ── Persistence: hydrate the store from uiConfig.cells ─────────────────────
  // Runs before the data-injection effect below (declaration order), so on
  // mount persisted manual values/formats load first and live UNS values then
  // overwrite bound cells. Skips the round-trip of our own CONFIG_CHANGE emit —
  // hydrating there would clobber edits made while the host was persisting.
  const lastEmittedCellsJsonRef = useRef<string | null>(null);
  const [hydrateTick, setHydrateTick] = useState(0);
  const cellsDroppedWarnedRef = useRef(false);
  useEffect(() => {
    const json = JSON.stringify(cfg.cells);
    if (json === lastEmittedCellsJsonRef.current) return;

    // A host that persists the envelope but not `uiConfig.cells` (a schema
    // without the key, a save path that only keeps the fields its own form
    // owns) hands the round-trip back with cells empty. Hydrating that would
    // clear every cell the operator just typed — the edit looks accepted, then
    // vanishes on the next config push. Treat "we emitted content, the host
    // returned none" as a non-persisting host and keep what is on screen.
    const incomingEmpty = Object.keys(cfg.cells).length === 0;
    const weHadContent = (lastEmittedCellsJsonRef.current ?? '{}') !== '{}';
    if (incomingEmpty && weHadContent) {
      if (!cellsDroppedWarnedRef.current) {
        cellsDroppedWarnedRef.current = true;
        console.warn(
          '[TableWidget] the host returned uiConfig.cells empty after this widget emitted cell content — ' +
          'keeping on-screen cells. Manual cell text will not survive a reload until the host persists uiConfig.cells.',
        );
      }
      return;
    }

    lastEmittedCellsJsonRef.current = json;
    // Full replace (hydrate clears first) so externally-removed cells actually
    // disappear; bumping hydrateTick re-runs the data effect below, which
    // re-injects live bound/series values the clear just wiped.
    storeRef.current!.hydrate(cfg.cells);
    setHydrateTick((t) => t + 1);
  }, [cfg.cells]);

  // Inject every UNS-resolved binding into the store in ONE batch → a single
  // notifyAll → a single grid re-render, regardless of how many cells the data
  // touches. Single-cell bindings (key = "R{r}C{c}") write straight through;
  // series bindings (key = "series:R{r}C{c}") expand an array across cells from
  // the base cell in the configured direction. Keeping all writes in one
  // setValues call is what keeps INP well under 50 ms even for large series.
  //
  // dataFilledRef tracks EVERY cell whose value came from the data prop (single
  // and series alike), mapped to the DataEntry key that filled it — "R{r}C{c}"
  // for a single binding, "series:R{r}C{c}" for a series. serializeCells uses
  // it to keep live readings out of the persisted uiConfig.cells, the
  // stale-blank loop below uses it to clear cells a re-laid-out binding no
  // longer covers, and the owning key lets a binding deleted in the
  // configurator clear its cells before the host has re-resolved.
  const dataFilledRef = useRef<Map<CellId, string>>(new Map());

  // Cells carrying a binding — drives the corner indicator + topic tooltip so
  // operators can tell live-bound cells apart from static ones at runtime, and
  // locks them from manual typing (service-populated).
  const boundCells = useMemo(
    () => computeBoundCells(cfg.cellBindings, cfg.seriesBindings),
    [cfg.cellBindings, cfg.seriesBindings],
  );
  const boundCellsRef = useRef(boundCells);
  boundCellsRef.current = boundCells;

  // Read at render time (not captured), so it reflects the latest resolve even
  // when only the grid re-rendered. boundCells covers a binding whose value has
  // not landed yet; dataFilledRef covers every cell a series actually filled.
  //
  // boundCells/boundCellsRef MUST stay above this: isDataCell runs during
  // render (the search memo calls it through precisionFor), and declaring the
  // ref further down left it in the temporal dead zone — the first keystroke in
  // the search box threw "cannot read properties of undefined" and took the
  // whole widget down with it.
  const isDataCell = (cellId: CellId) =>
    dataFilledRef.current.has(cellId) || boundCellsRef.current.has(cellId);

  // Unit and precision come from the binding that fills the cell, and apply
  // only when that binding sets them — an unset field leaves the value exactly
  // as it resolved, with no suffix. Indexed once per config change: this is
  // read for every rendered cell, on every render.
  const bindingFormats = useMemo(() => {
    const byCell = new Map<string, DataFormat>();
    const bySeriesKey = new Map<string, DataFormat>();
    for (const b of cfg.cellBindings) {
      byCell.set(b.cellId, { precision: b.precision ?? null, unit: b.unit ?? '' });
    }
    for (const s of cfg.seriesBindings) {
      const format: DataFormat = { precision: s.precision ?? null, unit: s.unit ?? '' };
      bySeriesKey.set(`series:${s.baseCellId}`, format);
      // The base cell before any data has landed — dataFilledRef is still empty
      // then, so the series would otherwise format nothing.
      byCell.set(s.baseCellId, format);
    }
    return { byCell, bySeriesKey };
  }, [cfg.cellBindings, cfg.seriesBindings]);

  const dataFormatFor = (cellId: CellId): DataFormat => {
    const owner = dataFilledRef.current.get(cellId);
    const format = owner?.startsWith('series:')
      ? bindingFormats.bySeriesKey.get(owner)
      : bindingFormats.byCell.get(cellId);
    return format ?? NO_DATA_FORMAT;
  };

  useEffect(() => {
    console.log('[TableWidget] data received', data);
    const store = storeRef.current;
    if (!store) return;

    const batch: Array<{ cellId: CellId; value: string }> = [];
    const filled = new Map<CellId, string>();

    for (const entry of toEntries(data)) {
      const key = String(entry?.key ?? '');
      if (/^R\d+C\d+$/.test(key)) {
        // Single-cell binding — DataEntry.key is already the target cellId.
        filled.set(key as CellId, key);
        batch.push({ cellId: key as CellId, value: scalarToString(entry.value) });
        continue;
      }
      if (!key.startsWith('series:')) continue;

      const baseCellId = key.slice('series:'.length).trim();
      const series = cfg.seriesBindings.find((s) => s.baseCellId === baseCellId);
      const m = /^R(\d+)C(\d+)$/.exec(baseCellId);
      if (!series || !m) {
        console.warn(
          `[TableWidget] series row "${key}" has no matching series binding`,
          { baseCellId, configured: cfg.seriesBindings.map((s) => s.baseCellId) },
        );
        continue;
      }

      const r0 = parseInt(m[1], 10);
      const c0 = parseInt(m[2], 10);
      const points = toSeriesPoints(entry);
      // Max-cells cap; limit 0 means "fill with every point the topic returned".
      const count = series.limit > 0 ? Math.min(series.limit, points.length) : points.length;

      let written = 0;
      for (let i = 0; i < count; i++) {
        const r = series.direction === 'vertical'   ? r0 + i : r0;
        const c = series.direction === 'horizontal' ? c0 + i : c0;
        // Never write past the configured grid — those cells are never rendered,
        // so the values would sit invisible in the store and reappear as ghosts
        // the moment the user grows the table.
        if (r >= cfg.rows || c >= cfg.columns) break;
        const cellId = `R${r}C${c}` as CellId;
        filled.set(cellId, key);
        batch.push({ cellId, value: scalarToString(points[i]) });
        written++;
      }
      // Silent truncation is the single most confusing thing a series can do:
      // 24 hourly buckets into a 10-row table shows 9 numbers and drops 15 with
      // no clue why. Say so — the configurator shows the same span up front.
      if (written < points.length) {
        console.warn(
          `[TableWidget] series "${cellIdToRef(baseCellId)}" resolved ${points.length} points but only ${written} fit ` +
          `(${series.direction === 'vertical' ? 'rows' : 'columns'} available from ${cellIdToRef(baseCellId)}` +
          `${series.limit > 0 ? `, max cells ${series.limit}` : ''}). Grow the grid or lower the point count.`,
        );
      }
    }

    // Blank the cells the previous resolve filled but this one no longer covers.
    // Without this, flipping Down↔Across leaves an L of stale values, lowering
    // the cap (or a shorter array) leaves a tail behind, and a cleared binding
    // leaves its last live reading on screen — which the persistence pass would
    // then freeze into uiConfig.cells as if it were manual content.
    for (const cellId of dataFilledRef.current.keys()) {
      if (!filled.has(cellId)) batch.push({ cellId, value: '' });
    }
    dataFilledRef.current = filled;

    if (batch.length > 0) store.setValues(batch);
    // hydrateTick: re-inject after an external cells hydration cleared the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, cfg.seriesBindings, cfg.rows, cfg.columns, hydrateTick]);

  // A binding deleted in the configurator (or left with its topic cleared) stops
  // appearing in `data`, but the reading it last wrote is still sitting in the
  // cell. The stale-blank loop above only runs once the host has re-resolved —
  // a round-trip away at best, and never at all for a host that re-resolves on
  // a time change alone — so the cell would keep showing a value with nothing
  // behind it. Clear the cells a binding no longer owns the moment the config
  // says it is gone; a still-live binding re-fills its own cells from `data`.
  useEffect(() => {
    const store = storeRef.current;
    if (!store) return;

    const liveKeys = new Set<string>([
      ...cfg.cellBindings.filter((b) => (b.topic ?? '').trim()).map((b) => b.cellId),
      ...cfg.seriesBindings.filter((s) => (s.topic ?? '').trim()).map((s) => `series:${s.baseCellId}`),
    ]);

    const batch: Array<{ cellId: CellId; value: string }> = [];
    const remaining = new Map<CellId, string>();
    for (const [cellId, owner] of dataFilledRef.current) {
      if (liveKeys.has(owner)) remaining.set(cellId, owner);
      else batch.push({ cellId, value: '' });
    }
    if (batch.length === 0) return;

    dataFilledRef.current = remaining;
    store.setValues(batch);
  }, [cfg.cellBindings, cfg.seriesBindings]);

  // ── Row Filter ──────────────────────────────────────────────────────────────
  // Filter instances read already-resolved cell text straight out of the store,
  // so they must recompute on ANY cell change — live UNS pushes (above) and
  // manual edits alike — not just when the `data` prop changes. The
  // subscription exists ONLY while a filter is actually configured: for the
  // common no-filter table it would otherwise re-render the whole widget on
  // every keystroke and data push for nothing.
  const rowFilterConfigured = cfg.rowFilter.filters.length > 0 && cfg.rowFilter.colIndex !== null;
  const [filterTick, setFilterTick] = useState(0);
  useEffect(() => {
    if (!rowFilterConfigured) return;
    return storeRef.current!.subscribe(() => setFilterTick((t) => t + 1));
  }, [rowFilterConfigured]);

  const filterInstances = useMemo(
    () => computeFilterInstances(cfg.rowFilter, storeRef.current!),
    // filterTick is an intentional recompute trigger, not a value dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg.rowFilter, filterTick],
  );

  // Default to every configured filter being "active" (Excel-style column
  // filter — everything matches until the user deselects a category). This is
  // what makes "Hide non-matching rows" take effect immediately once it's
  // turned on, without first requiring the user to click a chip: with no
  // filters active, computeRowFilterVisibility treats it as "no constraint"
  // and hides nothing, which otherwise made the toggle look like a no-op.
  const [activeFilterIds, setActiveFilterIds] = useState<Set<string>>(
    () => new Set(cfg.rowFilter.filters.map((f) => f.id)),
  );
  // Re-select-all whenever the configured filter list changes — otherwise a
  // stale selection could keep referencing rows for a filter that no longer
  // exists, or a newly-added filter would start invisible until toggled.
  const filterIdsKey = cfg.rowFilter.filters.map((f) => f.id).join(',');
  useEffect(() => {
    setActiveFilterIds(new Set(cfg.rowFilter.filters.map((f) => f.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterIdsKey]);

  const filterVisibility = useMemo(
    () => computeRowFilterVisibility(cfg.rowFilter, filterInstances, activeFilterIds),
    [cfg.rowFilter, filterInstances, activeFilterIds],
  );

  function toggleFilter(id: string) {
    const next = new Set(activeFilterIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setActiveFilterIds(next);
    onEvent({ type: 'FILTER_CHANGE', payload: { action: 'rowFilter', activeFilterIds: [...next] } });
  }

  // Exactly what the grid renders — value at the binding's precision, with its
  // unit — so search matches and CSV rows agree with the screen.
  const displayTextFor = (cellId: CellId): string => {
    const store = storeRef.current!;
    const { precision, unit } = dataFormatFor(cellId);
    const text = getDisplayValue(cellId, store, isDataCell(cellId) ? precision : null);
    return text !== '' && unit ? `${text} ${unit}` : text;
  };

  // ── In-table search ─────────────────────────────────────────────────────────
  // Matches are read from the store (display values, so a formula matches on
  // its result and a formatted number on what the operator actually sees), so
  // the subscription only exists while a query is active — the same
  // pay-for-what-you-use rule the row filter follows.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTick, setSearchTick] = useState(0);
  const searchActive = cfg.style.showSearch && searchQuery.trim() !== '';
  useEffect(() => {
    if (!searchActive) return;
    return storeRef.current!.subscribe(() => setSearchTick((t) => t + 1));
  }, [searchActive]);

  const searchHits = useMemo<CellId[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!cfg.style.showSearch || q === '') return [];
    const store = storeRef.current!;
    const hits: CellId[] = [];
    for (let r = 0; r < cfg.rows; r++) {
      if (filterVisibility.hiddenRows.has(r)) continue;
      for (let c = 0; c < cfg.columns; c++) {
        const id = `R${r}C${c}` as CellId;
        if (displayTextFor(id).toLowerCase().includes(q)) hits.push(id);
      }
    }
    return hits;
    // searchTick is an intentional recompute trigger, not a value dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, cfg.style.showSearch, cfg.rows, cfg.columns, bindingFormats, filterVisibility.hiddenRows, searchTick]);

  const [hitCursor, setHitCursor] = useState(0);
  // A changed query (or changed data) invalidates the old position.
  useEffect(() => { setHitCursor(0); }, [searchQuery]);
  const activeHit = searchHits.length > 0 ? searchHits[hitCursor % searchHits.length] ?? null : null;
  const searchMatchSet = useMemo(() => new Set(searchHits), [searchHits]);

  function stepHit(delta: number) {
    if (searchHits.length === 0) return;
    setHitCursor((i) => (i + delta + searchHits.length) % searchHits.length);
  }

  // Export what the operator sees: display values (formulas evaluated, number
  // formats and precision applied), rows hidden by the active filter skipped.
  // Pure client-side file generation from the store — no fetching.
  // The visible table as a grid of strings — the one source both download
  // formats are built from, so a CSV and an XLSX of the same table always hold
  // the same values.
  function visibleRows(): string[][] {
    const rows = geoRef.current?.rows ?? cfg.rows;
    const columns = geoRef.current?.columns ?? cfg.columns;
    const out: string[][] = [];
    for (let r = 0; r < rows; r++) {
      if (filterVisibility.hiddenRows.has(r)) continue;
      const cols: string[] = [];
      for (let c = 0; c < columns; c++) cols.push(displayTextFor(`R${r}C${c}`));
      out.push(cols);
    }
    return out;
  }

  function buildCsv(): string {
    const escapeCsv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return visibleRows().map((cols) => cols.map(escapeCsv).join(',')).join('\r\n');
  }

  // Download the visible table as CSV or XLSX. Same rows either way; the only
  // difference is the blob handed to the link.
  function handleExport(format: DownloadFormat) {
    const csv = buildCsv();
    const base = (cfg.title.trim() || 'table').replace(/[\\/:*?"<>|]/g, '_');
    const fileName = `${base}.${format}`;
    let downloaded = false;
    try {
      const blob = format === 'xlsx'
        // XLSX keeps numbers as numbers, so the file opens ready to sum.
        ? buildXlsx(visibleRows().map((cols) => cols.map(toXlsxValue)), base)
        // BOM so Excel opens UTF-8 CSV content correctly.
        : new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      // Revoking synchronously after click() aborts the download in Firefox and
      // Safari — the browser has not read the blob out of the object URL yet.
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
      downloaded = true;
    } catch (err) {
      console.error(`[TableWidget] ${format.toUpperCase()} download failed`, err);
    }
    // The payload carries the file so a host that blocks anchor downloads (a
    // sandboxed iframe without allow-downloads, which is what makes the export
    // icon look dead) can save it through its own channel.
    onEvent({ type: 'FILTER_CHANGE', payload: { action: 'export', format, fileName, csv, downloaded } });
  }

  // ── On-canvas Cell Config popover ──────────────────────────────────────────
  const [configCellId, setConfigCellId] = useState<string | null>(null);
  const [configKind, setConfigKind] = useState<CellConfigKind>('single');
  const [modalX, setModalX] = useState(0);
  const [modalY, setModalY] = useState(0);

  useZoneIgnorePortals();

  const hasInjectedUNS = unsWorkspaces !== undefined && loadUnsChildren !== undefined;
  const unsHook = useUNSTreePicker(hasInjectedUNS ? undefined : authentication);
  // The popover is usable whenever a source can actually list workspaces; without
  // one the cell popover falls back to a plain paste-a-topic field.
  const hasUNSBrowser = hasInjectedUNS || authentication !== undefined;

  const unsWs        = hasInjectedUNS ? unsWorkspaces!  : unsHook.workspaces;
  const unsWsLoading = hasInjectedUNS ? isLoadingWorkspaces : unsHook.isLoadingWorkspaces;
  const unsOpen      = unsHook.loadWorkspaces;
  const unsChildren  = hasInjectedUNS ? loadUnsChildren! : unsHook.loadChildren;
  const unsSearch    = hasInjectedUNS ? searchUnsNodes   : unsHook.searchNodes;

  // ── Persistence: serialize the store + grid geometry back into uiConfig ───
  // The widget never mutates the envelope — it hands the updated uiConfig to the
  // host via onEvent, which rebuilds dynamicBindingPathList and persists.
  const geoRef = useRef<GridGeometry | null>(null);
  const emitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Locally-ahead position-addressed config. The cfg prop only updates after
  // the host round-trips a CONFIG_CHANGE, so consecutive edits (two quick
  // popover clicks, an insert-row remap followed by a binding edit) must build
  // on what we last emitted — not on the stale prop — or the first edit is
  // silently lost.
  //
  // Each pending key remembers the cfg value it was derived FROM, which is what
  // separates the two ways a new cfg can disagree with it:
  //
  //   cfg[key] === pending value  → the round-trip caught up. Drop it; cfg is
  //                                 the single truth again.
  //   cfg[key] === base           → the host has not caught up yet. Keep it, or
  //                                 the next emit reverts our own edit.
  //   neither                     → somebody else (the configurator, another
  //                                 session) changed this field after we did.
  //                                 Theirs is newer: drop ours, or every later
  //                                 cell edit would re-apply our stale value on
  //                                 top of their bindings/rules for good.
  const pendingUiRef = useRef<Partial<TableWidgetUIConfig>>({});
  const pendingBaseRef = useRef<Partial<TableWidgetUIConfig>>({});

  function setPending<K extends keyof TableWidgetUIConfig>(key: K, value: TableWidgetUIConfig[K]) {
    if (!(key in pendingBaseRef.current)) pendingBaseRef.current[key] = cfg[key];
    pendingUiRef.current[key] = value;
  }

  function dropPending(key: keyof TableWidgetUIConfig) {
    delete pendingUiRef.current[key];
    delete pendingBaseRef.current[key];
  }

  useEffect(() => {
    const p = pendingUiRef.current;
    (Object.keys(p) as (keyof TableWidgetUIConfig)[]).forEach((key) => {
      const incoming = JSON.stringify(cfg[key]);
      if (incoming === JSON.stringify(p[key])) { dropPending(key); return; }        // caught up
      if (incoming !== JSON.stringify(pendingBaseRef.current[key])) dropPending(key); // superseded
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  function latest<K extends keyof RemappableConfig>(key: K): RemappableConfig[K] {
    return (pendingUiRef.current[key] ?? cfg[key]) as RemappableConfig[K];
  }

  // Drop the captured geometry when the incoming config disagrees with it —
  // that means something other than this widget (the configurator, another
  // session) changed rows/columns/freeze/sizes, and re-spreading the stale
  // snapshot on the next emit would revert that change and, worse, make
  // serializeCells drop content beyond the stale bounds. Our own emit
  // round-trips carry geometry equal to the snapshot, so those keep it.
  useEffect(() => {
    const geo = geoRef.current;
    if (!geo) return;
    const same =
      geo.rows === cfg.rows &&
      geo.columns === cfg.columns &&
      geo.freezeRows === cfg.freezeRows &&
      geo.freezeColumns === cfg.freezeColumns &&
      JSON.stringify(geo.columnWidths) === JSON.stringify(cfg.columnWidths) &&
      JSON.stringify(geo.rowHeights) === JSON.stringify(cfg.rowHeights);
    if (!same) geoRef.current = null;
  }, [cfg]);

  // Sparse uiConfig.cells snapshot. Manual text and non-default formats only:
  // values of bound / series-filled cells are runtime data the service will
  // re-populate — persisting them would freeze a live reading into the envelope.
  function serializeCells(rows: number, columns: number): Record<string, PersistedCell> {
    const cells: Record<string, PersistedCell> = {};
    for (const [cellId, cell] of storeRef.current!.entries()) {
      const m = /^R(\d+)C(\d+)$/.exec(cellId);
      if (!m || parseInt(m[1], 10) >= rows || parseInt(m[2], 10) >= columns) continue;
      const entry: PersistedCell = {};
      const isDataCell = boundCells.has(cellId) || dataFilledRef.current.has(cellId);
      if (cell.value !== '' && !isDataCell) entry.value = cell.value;
      if (!isDefaultFormat(cell.format)) entry.format = cell.format;
      if (entry.value !== undefined || entry.format !== undefined) cells[cellId] = entry;
    }
    return cells;
  }

  function emitUiConfig(overrides?: Partial<TableWidgetUIConfig>) {
    if (emitTimerRef.current) { clearTimeout(emitTimerRef.current); emitTimerRef.current = null; }
    const geo = geoRef.current;
    const rows = geo?.rows ?? cfg.rows;
    const columns = geo?.columns ?? cfg.columns;
    const cells = serializeCells(rows, columns);
    const uiConfig: TableWidgetUIConfig = {
      ...cfg,
      ...(geo
        ? {
            rows: geo.rows,
            columns: geo.columns,
            freezeRows: geo.freezeRows,
            freezeColumns: geo.freezeColumns,
            columnWidths: geo.columnWidths,
            rowHeights: geo.rowHeights,
          }
        : {}),
      ...pendingUiRef.current,
      cells,
      ...overrides,
    };
    lastEmittedCellsJsonRef.current = JSON.stringify(uiConfig.cells);
    // The binding index travels WITH the config so the invariant "list matches
    // uiConfig" is enforced where uiConfig is produced — a host that persists
    // the payload verbatim stays correct without knowing this widget's rules.
    onEvent({
      type: 'CONFIG_CHANGE',
      payload: { uiConfig, dynamicBindingPathList: buildDynamicBindingPathList(uiConfig) },
    });
  }

  // Every grid change is emitted the moment it happens. Each call is already a
  // discrete action (a cell commit, paste, clear, format, insert/delete, freeze,
  // resize end), so there is no burst to coalesce, and a debounce only opened a
  // window where the last edit existed nowhere but this component.
  const emitUiConfigRef = useRef(emitUiConfig);
  emitUiConfigRef.current = emitUiConfig;

  function handleGridChange(geo: GridGeometry, mutation?: GridMutation) {
    geoRef.current = geo;
    if (mutation) {
      // A structural insert/delete shifted cell CONTENTS in the store — shift
      // every position-addressed piece of config with it (bindings, rule
      // ranges, the row-filter range) so they keep pointing at the same data.
      const remapped = remapForGridMutation(
        {
          cellBindings: latest('cellBindings'),
          seriesBindings: latest('seriesBindings'),
          conditionalRules: latest('conditionalRules'),
          rowFilter: latest('rowFilter'),
        },
        mutation,
      );
      (Object.keys(remapped) as (keyof typeof remapped)[]).forEach((key) => setPending(key, remapped[key]));
    }
    if (emitTimerRef.current) clearTimeout(emitTimerRef.current);
    emitTimerRef.current = null;
    emitUiConfigRef.current();
  }

  // Grid edits no longer wait on a timer (see handleGridChange), so nothing is
  // ever pending here and these flushes are no-ops. They stay as a safety net
  // in case a debounced path is reintroduced: every way out of the widget
  // flushes whatever is still in flight.
  function flushPendingEmit() {
    if (!emitTimerRef.current) return;
    clearTimeout(emitTimerRef.current);
    emitTimerRef.current = null;
    emitUiConfigRef.current();
  }

  const flushRef = useRef(flushPendingEmit);
  flushRef.current = flushPendingEmit;

  // Unmount (the host tearing the widget down, a dashboard navigation).
  useEffect(() => () => flushRef.current(), []);

  // The tab being closed or hidden. `unmount` never runs for a closed tab, so
  // without this the last edit before a close is lost with no trace.
  useEffect(() => {
    const flush = () => flushRef.current();
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  // Locking the table is the operator saying "this is finished" — nothing is
  // editable past that point, so anything still in flight goes now rather than
  // riding on a timer nobody is watching.
  useEffect(() => {
    if (cfg.locked) flushRef.current();
  }, [cfg.locked]);

  // All binding edits build on latest() — the pending layer, not the cfg prop —
  // so two quick popover edits can't lose the first one while the host is
  // still round-tripping (the classic slow-host race).
  function emitConfig(cellBindings: typeof cfg.cellBindings, seriesBindings: typeof cfg.seriesBindings) {
    setPending('cellBindings', cellBindings);
    setPending('seriesBindings', seriesBindings);
    emitUiConfig({ cellBindings, seriesBindings });
  }

  function upsertCellTopic(cellId: string, rawValue: string) {
    const topic = rawValue;
    const cellBindings = latest('cellBindings');
    const nextSeries = latest('seriesBindings').filter((s) => s.baseCellId !== cellId);
    const exists = cellBindings.some((b) => b.cellId === cellId);
    const nextCells = exists
      ? cellBindings.map((b) => (b.cellId === cellId ? { ...b, topic } : b))
      : [...cellBindings, { cellId, topic }];
    emitConfig(nextCells, nextSeries);
  }

  function upsertSeries(cellId: string, patch: Partial<{ topic: string; direction: SeriesDirection; limit: number }>) {
    const seriesBindings = latest('seriesBindings');
    const nextCells = latest('cellBindings').filter((b) => b.cellId !== cellId);
    const existing = seriesBindings.find((s) => s.baseCellId === cellId);
    const nextSeries = existing
      ? seriesBindings.map((s) => (s.baseCellId === cellId ? { ...s, ...patch } : s))
      : [
          ...seriesBindings,
          { id: `series_${Date.now()}`, baseCellId: cellId, topic: '', direction: 'vertical' as SeriesDirection, limit: 0, ...patch },
        ];
    emitConfig(nextCells, nextSeries);
  }

  function clearCellBinding(cellId: string) {
    // Blank the last live reading immediately — leaving it visible (and letting
    // the next serialize persist it as manual content) is exactly the "freeze a
    // live value into the envelope" failure the persistence layer must avoid.
    storeRef.current!.setValue(cellId, '');
    dataFilledRef.current.delete(cellId);
    emitConfig(
      latest('cellBindings').filter((b) => b.cellId !== cellId),
      latest('seriesBindings').filter((s) => s.baseCellId !== cellId),
    );
  }

  function openCellConfig(cellId: CellId, rect: DOMRect) {
    const MODAL_W = 300;
    setModalX(Math.max(8, Math.min(rect.right + 8, window.innerWidth - MODAL_W - 8)));
    setModalY(Math.max(8, Math.min(rect.top, window.innerHeight - 360)));
    setConfigKind(cfg.seriesBindings.some((s) => s.baseCellId === cellId) ? 'series' : 'single');
    setConfigCellId(cellId);
  }

  function closeCellConfig() {
    // Drop any binding left without a topic so the envelope stays clean —
    // pruning from latest(), never the possibly-lagging cfg prop, so a
    // just-picked topic still in round-trip flight can't be wiped by Done.
    const cellBindings = latest('cellBindings');
    const seriesBindings = latest('seriesBindings');
    const nextCells = cellBindings.filter((b) => (b.topic ?? '').trim());
    const nextSeries = seriesBindings.filter((s) => (s.topic ?? '').trim());
    if (nextCells.length !== cellBindings.length || nextSeries.length !== seriesBindings.length) {
      emitConfig(nextCells, nextSeries);
    }
    setConfigCellId(null);
  }

  const activeCellTopic = configCellId
    ? latest('cellBindings').find((b) => b.cellId === configCellId)?.topic ?? ''
    : '';
  const activeSeries = configCellId
    ? latest('seriesBindings').find((s) => s.baseCellId === configCellId)
    : undefined;

  const previewCells = useMemo(() => {
    if (!configCellId || configKind !== 'series') return undefined;
    const dir = activeSeries?.direction ?? 'vertical';
    const count = activeSeries && activeSeries.limit > 0 ? activeSeries.limit : SERIES_PREVIEW_FALLBACK;
    return seriesPreviewCells(configCellId, dir, count, cfg.rows, cfg.columns);
  }, [configCellId, configKind, activeSeries, cfg.rows, cfg.columns]);

  // ── Header actions: the Table Control popover ──────────────────────────────
  // design-sdk's Popover owns placement and dismissal: a click inside the panel
  // (ticking the checkbox, hitting a download) leaves it open, while the
  // trigger toggles and an outside click or Escape closes it.
  const actionsRef = useRef<HTMLDivElement>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Horizontal-scroll setting. Held locally as well as in the envelope: the cfg
  // prop only catches up after the host round-trips our CONFIG_CHANGE, and a
  // checkbox that stays unticked for a beat (or forever, on a host that does
  // not persist the key) reads as broken.
  const [hScroll, setHScroll] = useState(cfg.lockedHorizontalScroll);
  useEffect(() => { setHScroll(cfg.lockedHorizontalScroll); }, [cfg.lockedHorizontalScroll]);

  function handleScrollToggle(next: boolean) {
    setHScroll(next);
    // Park it in the pending layer too, so an unrelated emit in flight (a cell
    // edit, a resize) rebuilt from the still-stale cfg can't revert the toggle.
    setPending('lockedHorizontalScroll', next);
    emitUiConfig({ lockedHorizontalScroll: next });
  }

  const card = cfg.style.card;
  const titleCfg = cfg.style.title;
  const showExportButton = cfg.style.showExportButton;
  const showSearch = cfg.style.showSearch;
  const showHeader = cfg.title.trim() !== '';
  // The title truncates to one line; hovering a truncated one reveals it whole.
  const { setEl: setTitleEl, isTruncated: isTitleTruncated } = useIsTruncated([
    cfg.title, titleCfg.fontSize, titleCfg.fontWeight,
  ]);

  const cardInlineStyle: React.CSSProperties = {
    // The host container is the single source of truth for the widget box: the
    // widget always fills it exactly, in both lock modes. Unlocked, the table
    // keeps its natural track sizes and scrolls inside that box; locked, the
    // columns are scaled to the box width (see VirtualGrid) so nothing is cut
    // off sideways. Pinning the configured px size here instead used to leave
    // the widget either overflowing or floating in a partly empty tile.
    width: '100%',
    height: '100%',
    backgroundColor: card.bg || undefined,
    ...(card.wrapInCard ? {
      border: `${card.borderWidth}px solid ${card.borderColor || '#e0e0e0'}`,
      borderRadius: card.borderRadius,
      padding: card.padding,
      boxSizing: 'border-box',
    } : {}),
  };

  const titleInlineStyle: React.CSSProperties = {
    color:      titleCfg.color     || undefined,
    fontSize:   titleCfg.fontSize  ? `${titleCfg.fontSize}px` : undefined,
    fontWeight: titleCfg.fontWeight === 'bold'    ? 700
              : titleCfg.fontWeight === 'medium'  ? 500
              : titleCfg.fontWeight === 'regular' ? 400
              : undefined,
    textAlign:  titleCfg.align,
  };

  return (
    <div
      className="tw-widget"
      style={cardInlineStyle}
      // Double-click asks the host to open this widget's configuration panel in
      // edit mode. The widget cannot open it itself (Lens owns configurator
      // hosting), so it emits the intent and lets the gesture keep bubbling —
      // a host that listens for dblclick on the widget container still sees it.
      //
      // Cells that DO something with a double-click (entering cell edit mode on
      // an unlocked table) stop propagation themselves, so the two never fire
      // for the same gesture.
      //
      // Only hosts that speak the protocol get the event: the new IOSense host
      // (canvasConfig) and anything passing `editable` explicitly (the dev
      // harness). IOSense prod sends neither, and there the event triggered a
      // refetch rather than opening anything.
      onDoubleClick={(e) => {
        if (isControlTarget(e.target)) return;
        if (!canPersist && editableProp === undefined) return;   // IOSense prod sends neither
        onEvent({ type: 'EDIT_WIDGET', payload: { editMode: true } });
      }}
    >
      {/* The action group is always present, so the topbar always renders. */}
      <div className="tw-topbar">
          {showHeader && (
            <h3
              ref={setTitleEl}
              className="tw-title"
              style={titleInlineStyle}
              title={isTitleTruncated ? cfg.title : undefined}
            >
              {cfg.title}
            </h3>
          )}
          <div className="tw-topbar__actions">
            {showSearch && (
              <div
                className="tw-search"
                // The find-box convention, as in VS Code: Enter walks to the
                // next match, Shift+Enter back to the previous one. Handled on
                // the wrapper rather than through SearchInput's own onSubmit,
                // which only knows about Enter and would fire a second step.
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  stepHit(e.shiftKey ? -1 : 1);
                }}
              >
                <SearchInput
                  placeholder="Search table…"
                  inputValue={searchQuery}
                  showSearchIcon
                  showClearButton
                  // Held closed: SearchInput's suggestions popover has no
                  // suggestions to show here (the matches are the cells
                  // themselves), and left uncontrolled it opens on every
                  // keystroke with "No results found" — a panel covering the
                  // very table the query just highlighted.
                  isOpen={false}
                  onOpenChange={() => {}}
                  onInputChange={(value: string) => setSearchQuery(value)}
                  onClearButtonClicked={() => setSearchQuery('')}
                />
                {searchQuery.trim() !== '' && (
                  <div className="tw-search__nav">
                    <span
                      className={`tw-search__count${searchHits.length === 0 ? ' tw-search__count--empty' : ''}`}
                      aria-live="polite"
                    >
                      {searchHits.length === 0
                        ? 'No results'
                        : `${(hitCursor % searchHits.length) + 1} of ${searchHits.length}`}
                    </span>
                    <Tooltip bodyText="Previous match" placement="Bottom">
                      <Button
                        iconOnly
                        aria-label="Previous match"
                        leadingIcon={<ChevronUp size={13} />}
                        variant="Gray"
                        size="XSmall"
                        isDisabled={searchHits.length === 0}
                        onClick={() => stepHit(-1)}
                      />
                    </Tooltip>
                    <Tooltip bodyText="Next match" placement="Bottom">
                      <Button
                        iconOnly
                        aria-label="Next match"
                        leadingIcon={<ChevronDown size={13} />}
                        variant="Gray"
                        size="XSmall"
                        isDisabled={searchHits.length === 0}
                        onClick={() => stepHit(1)}
                      />
                    </Tooltip>
                  </div>
                )}
              </div>
            )}
            {/* Locked mode only: every control in here acts on a finished,
                read-only table (the scroll behaviour, the download of what is
                on screen). While the table is still being edited they would
                either do nothing or fight the editing surface. */}
            {cfg.locked && (
              <div className="tw-actions" ref={actionsRef}>
                <Popover
                  isOpen={isSettingsOpen}
                  onOpenChange={(open: boolean) => setIsSettingsOpen(open)}
                  placement="Bottom End"
                  trigger={
                    <ChartActions settingsLabel="Table settings" onSettingsClick={() => {}} />
                  }
                >
                  {/* showClose defaults to true — the whole point of moving off
                      the Modal was to drop the close button, so it is off. */}
                  <PopoverHeader title="Table Control" showClose={false} />
                  <PopoverBody>
                    <div className="tw-settings__body">
                      <Checkbox
                        label="Horizontal Scrollbar"
                        helpText="Columns keep their own width and scroll horizontally, instead of every column being compacted to fit the widget."
                        checked={hScroll}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleScrollToggle(e.target.checked)}
                      />

                      {showExportButton && (
                        <>
                          {/* Same typography as the popover's own header, so the
                              two sections read as siblings. */}
                          <h3 className="tw-settings__heading BodyLargeSemibold">Download Type</h3>
                          <div className="tw-settings__downloads">
                            <Button
                              variant="Secondary"
                              size="XSmall"
                              leadingIcon={<Download size={13} />}
                              label="CSV"
                              onClick={() => handleExport('csv')}
                            />
                            <Button
                              variant="Secondary"
                              size="XSmall"
                              leadingIcon={<Download size={13} />}
                              label="XLSX"
                              onClick={() => handleExport('xlsx')}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </PopoverBody>
                </Popover>
              </div>
            )}
          </div>
        </div>

      {cfg.rowFilter.filters.length > 0 && (
        <div className="tw-filter-bar">
          {cfg.rowFilter.filterType === 'chips' ? (
            cfg.rowFilter.filters.map((filter) => {
              const Icon = ROW_FILTER_ICONS[filter.icon];
              const isActive = activeFilterIds.has(filter.id);
              const count = filterInstances.get(filter.id)?.length ?? 0;
              return (
                <Chip
                  key={filter.id}
                  label={cfg.rowFilter.enableCount ? `${filter.name} (${count})` : filter.name}
                  icon={Icon ? <Icon size={12} /> : undefined}
                  isSelected={isActive}
                  size="small"
                  style={{
                    borderColor: filter.color,
                    color: filter.color,
                    backgroundColor: isActive ? hexToRgba(filter.color, 0.14) : undefined,
                  }}
                  onClick={() => toggleFilter(filter.id)}
                />
              );
            })
          ) : (
            <Popover
              trigger={
                <Button
                  variant="Secondary"
                  size="Small"
                  label={activeFilterIds.size > 0 ? `${activeFilterIds.size} Filter` : 'Filter'}
                  leadingIcon={<Filter size={13} />}
                />
              }
              placement="Bottom Start"
            >
              <PopoverBody>
                <div className="tw-filter-dropdown__list">
                  {cfg.rowFilter.filters.map((filter) => {
                    const count = filterInstances.get(filter.id)?.length ?? 0;
                    return (
                      <Checkbox
                        key={filter.id}
                        label={cfg.rowFilter.enableCount ? `${filter.name} (${count})` : filter.name}
                        checked={activeFilterIds.has(filter.id)}
                        onChange={() => toggleFilter(filter.id)}
                      />
                    );
                  })}
                </div>
              </PopoverBody>
            </Popover>
          )}
        </div>
      )}

      <div className="tw-table-section">
        <VirtualGrid
          rows={cfg.rows}
          columns={cfg.columns}
          freezeRows={cfg.freezeRows}
          freezeColumns={cfg.freezeColumns}
          configColWidths={cfg.columnWidths}
          configRowHeights={cfg.rowHeights}
          store={storeRef.current}
          conditionalRules={cfg.conditionalRules}
          locked={cfg.locked}
          horizontalScroll={hScroll}
          tableBorderStyle={cfg.style.tableBorderStyle}
          boundCells={boundCells}
          previewCells={previewCells}
          dataFormatFor={dataFormatFor}
          isDataCell={isDataCell}
          searchMatches={searchMatchSet}
          activeMatch={activeHit}
          onCellConfigure={editable && !cfg.locked ? openCellConfig : undefined}
          hiddenRows={filterVisibility.hiddenRows}
          rowColors={filterVisibility.rowColors}
          onUserChange={emitsCellEdits && !cfg.locked ? handleGridChange : undefined}
          // View mode on a host that persists edits: the grid still selects and
          // copies, it just cannot be changed.
          readOnly={canPersist && editMode !== true}
        />
      </div>

      {/* ── Cell Config popover (double-click a cell when editable) ── */}
      {editable && configCellId && (
        <Modal
          isOpen={configCellId !== null}
          positionX={modalX}
          positionY={modalY}
          className="tw-cell-config-modal"
          onClose={closeCellConfig}
          header={<ModalHeader title={`Configure ${cellIdToRef(configCellId)}`} onClose={closeCellConfig} />}
          footer={<ModalFooter primaryAction={<Button variant="Primary" size="Small" label="Done" onClick={closeCellConfig} />} />}
        >
          <ModalBody>
            <div className="tw-cc__body">

              <div className="tw-cc__field">
                <span className="tw-cc__label">Binding type</span>
                <div className="tw-seg-group">
                  {([
                    { value: 'single', label: 'Single value' },
                    { value: 'series', label: 'Series' },
                  ] as { value: CellConfigKind; label: string }[]).map(({ value, label }) => (
                    <button
                      key={value}
                      className={`tw-seg-btn${configKind === value ? ' tw-seg-btn--active' : ''}`}
                      onClick={() => setConfigKind(value)}
                    >{label}</button>
                  ))}
                </div>
              </div>

              {configKind === 'single' ? (
                hasUNSBrowser ? (
                  <UNSTreePicker
                    label="UNS Topic"
                    placeholder="Select a topic…"
                    value={activeCellTopic}
                    workspaces={unsWs}
                    isLoadingWorkspaces={unsWsLoading}
                    loadChildren={unsChildren}
                    searchNodes={unsSearch}
                    onOpen={unsOpen}
                    onChange={(value: string) => upsertCellTopic(configCellId, value)}
                  />
                ) : (
                  <TextInput
                    label="UNS Topic"
                    placeholder="Paste {{uns:wsId://path}}"
                    value={activeCellTopic}
                    onChange={({ value }: { name: string; value: string }) => upsertCellTopic(configCellId, value)}
                  />
                )
              ) : (
                <>
                  {hasUNSBrowser ? (
                    <UNSTreePicker
                      label="Array topic"
                      placeholder="Select a topic…"
                      value={activeSeries?.topic ?? ''}
                      workspaces={unsWs}
                      isLoadingWorkspaces={unsWsLoading}
                      loadChildren={unsChildren}
                      searchNodes={unsSearch}
                      onOpen={unsOpen}
                      onChange={(value: string) => upsertSeries(configCellId, { topic: value })}
                    />
                  ) : (
                    <TextInput
                      label="Array topic"
                      placeholder="Paste {{uns:wsId://path}}"
                      value={activeSeries?.topic ?? ''}
                      onChange={({ value }: { name: string; value: string }) => upsertSeries(configCellId, { topic: value })}
                    />
                  )}

                  <div className="tw-cc__field">
                    <span className="tw-cc__label">Direction</span>
                    <div className="tw-seg-group">
                      {([
                        { value: 'vertical',   label: 'Down',   icon: <ArrowDown size={11} /> },
                        { value: 'horizontal', label: 'Across', icon: <ArrowRight size={11} /> },
                      ] as { value: SeriesDirection; label: string; icon: React.ReactNode }[]).map(({ value, label, icon }) => (
                        <button
                          key={value}
                          className={`tw-seg-btn${(activeSeries?.direction ?? 'vertical') === value ? ' tw-seg-btn--active' : ''}`}
                          onClick={() => upsertSeries(configCellId, { direction: value })}
                        >
                          <span className="tw-cc__seg-content">{icon}{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <NumberField
                    label="Max cells (0 = all)"
                    value={activeSeries?.limit ?? 0}
                    min={0}
                    max={1000}
                    step={1}
                    onChange={(value) =>
                      upsertSeries(configCellId, { limit: value ?? 0 })
                    }
                  />
                </>
              )}

              <button
                className="tw-cc__clear"
                onClick={() => { clearCellBinding(configCellId); closeCellConfig(); }}
              >
                <Trash2 size={12} /> Clear binding
              </button>

            </div>
          </ModalBody>
        </Modal>
      )}
    </div>
  );
}

// cellIdToRef lives in formulaEngine.ts beside its inverse refToCellId.
