import { useRef, useEffect, useMemo, useState } from 'react';
import { Button, TextInput, CounterInput, Chip, Checkbox, Popover, PopoverBody, UNSTreePicker, SearchInput } from '@faclon-labs/design-sdk';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@faclon-labs/design-sdk/Modal';
import { ChartActions } from '@faclon-labs/design-sdk/Chart';
import type { UNSNode, UNSWorkspace } from '@faclon-labs/design-sdk/UNSTreePicker';
import { Download, ArrowDown, ArrowRight, Trash2, Filter, ChevronUp, ChevronDown } from 'react-feather';
import { DataEntry, WidgetEvent, SeriesDirection, PersistedCell, TableWidgetUIConfig } from '../../iosense-sdk/types';
import { PartialTableWidgetUIConfig, withTableWidgetDefaults } from '../../iosense-sdk/defaults';
import { useUNSTreePicker } from '../../iosense-sdk/useUNSTreePicker';
import { useZoneIgnorePortals } from '../../iosense-sdk/zoneIgnorePortals';
import { buildDynamicBindingPathList } from '../../iosense-sdk/bindings';
import { CellDataStore, CellId, isDefaultFormat } from './CellDataStore';
import { VirtualGrid, GridGeometry } from './VirtualGrid';
import { computeBoundCells, seriesPreviewCells, remapForGridMutation, GridMutation, RemappableConfig } from './bindingMap';
import { getDisplayValue, cellIdToRef } from './formulaEngine';
import { ROW_FILTER_ICONS, computeFilterInstances, computeRowFilterVisibility, hexToRgba } from './rowFilter';
import './TableWidget.css';

// A cell holds one binding kind at a time in the Cell Config popover.
type CellConfigKind = 'single' | 'series';
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

export function TableWidget(props: TableWidgetProps) {
  const { config, data, onEvent, editable = false, unsWorkspaces, isLoadingWorkspaces, loadUnsChildren, searchUnsNodes, authentication } = props;
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
  // and series alike): serializeCells uses it to keep live readings out of the
  // persisted uiConfig.cells, and the stale-blank loop below uses it to clear
  // cells a removed/re-laid-out binding no longer covers.
  const dataFilledRef = useRef<Set<CellId>>(new Set());

  // Read at render time (not captured), so it reflects the latest resolve even
  // when only the grid re-rendered. boundCells covers a binding whose value has
  // not landed yet; dataFilledRef covers every cell a series actually filled.
  const isDataCell = (cellId: CellId) =>
    dataFilledRef.current.has(cellId) || boundCellsRef.current.has(cellId);

  useEffect(() => {
    console.log('[TableWidget] data received', data);
    const store = storeRef.current;
    if (!store) return;

    const batch: Array<{ cellId: CellId; value: string }> = [];
    const filled = new Set<CellId>();

    for (const entry of toEntries(data)) {
      const key = String(entry?.key ?? '');
      if (/^R\d+C\d+$/.test(key)) {
        // Single-cell binding — DataEntry.key is already the target cellId.
        filled.add(key as CellId);
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
        filled.add(cellId);
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
    for (const cellId of dataFilledRef.current) {
      if (!filled.has(cellId)) batch.push({ cellId, value: '' });
    }
    dataFilledRef.current = filled;

    if (batch.length > 0) store.setValues(batch);
    // hydrateTick: re-inject after an external cells hydration cleared the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, cfg.seriesBindings, cfg.rows, cfg.columns, hydrateTick]);

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

  // Same precision rule the grid renders with, so search and CSV export show
  // exactly what is on screen.
  const precisionFor = (cellId: CellId): number | null =>
    isDataCell(cellId) ? cfg.dataPrecision : null;

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
        if (getDisplayValue(id, store, precisionFor(id)).toLowerCase().includes(q)) hits.push(id);
      }
    }
    return hits;
    // searchTick is an intentional recompute trigger, not a value dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, cfg.style.showSearch, cfg.rows, cfg.columns, cfg.dataPrecision, filterVisibility.hiddenRows, searchTick]);

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
  function buildCsv(): string {
    const rows = geoRef.current?.rows ?? cfg.rows;
    const columns = geoRef.current?.columns ?? cfg.columns;
    const store = storeRef.current!;
    const escapeCsv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines: string[] = [];
    for (let r = 0; r < rows; r++) {
      if (filterVisibility.hiddenRows.has(r)) continue;
      const cols: string[] = [];
      for (let c = 0; c < columns; c++) {
        cols.push(escapeCsv(getDisplayValue(`R${r}C${c}`, store, precisionFor(`R${r}C${c}`))));
      }
      lines.push(cols.join(','));
    }
    return lines.join('\r\n');
  }

  function handleExport() {
    const csv = buildCsv();
    const fileName = `${(cfg.title.trim() || 'table').replace(/[\\/:*?"<>|]/g, '_')}.csv`;
    let downloaded = false;
    try {
      // BOM so Excel opens UTF-8 content correctly.
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
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
      console.error('[TableWidget] CSV download failed', err);
    }
    // The payload carries the file so a host that blocks anchor downloads (a
    // sandboxed iframe without allow-downloads, which is what makes the export
    // icon look dead) can save it through its own channel.
    onEvent({ type: 'FILTER_CHANGE', payload: { action: 'export', fileName, csv, downloaded } });
  }

  // Cells carrying a binding — drives the corner indicator + topic tooltip so
  // operators can tell live-bound cells apart from static ones at runtime, and
  // locks them from manual typing (service-populated).
  const boundCells = useMemo(
    () => computeBoundCells(cfg.cellBindings, cfg.seriesBindings),
    [cfg.cellBindings, cfg.seriesBindings],
  );
  const boundCellsRef = useRef(boundCells);
  boundCellsRef.current = boundCells;

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
  // silently lost. A pending key is cleared the moment the round-trip catches
  // up with it (effect below), after which cfg is the single truth again.
  const pendingUiRef = useRef<Partial<TableWidgetUIConfig>>({});

  useEffect(() => {
    const p = pendingUiRef.current;
    (Object.keys(p) as (keyof TableWidgetUIConfig)[]).forEach((key) => {
      if (JSON.stringify(p[key]) === JSON.stringify(cfg[key])) delete p[key];
    });
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

  // Grid edits arrive in bursts (typing, drag-resize, multi-cell formatting) —
  // coalesce them into one CONFIG_CHANGE ~400 ms after the last mutation.
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
      Object.assign(pendingUiRef.current, remapped);
    }
    if (emitTimerRef.current) clearTimeout(emitTimerRef.current);
    emitTimerRef.current = setTimeout(() => emitUiConfigRef.current(), 400);
  }

  // Flush a pending debounced emit on unmount so the last edit isn't lost.
  useEffect(() => () => {
    if (emitTimerRef.current) {
      clearTimeout(emitTimerRef.current);
      emitUiConfigRef.current();
    }
  }, []);

  // All binding edits build on latest() — the pending layer, not the cfg prop —
  // so two quick popover edits can't lose the first one while the host is
  // still round-tripping (the classic slow-host race).
  function emitConfig(cellBindings: typeof cfg.cellBindings, seriesBindings: typeof cfg.seriesBindings) {
    pendingUiRef.current.cellBindings = cellBindings;
    pendingUiRef.current.seriesBindings = seriesBindings;
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

  // ── Header actions: Table Settings (gear) + More (⋯) ───────────────────────
  // Both panels are anchored off the actions group, so they open under the icon
  // that was clicked instead of in the middle of the dashboard.
  const actionsRef = useRef<HTMLDivElement>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsX, setSettingsX] = useState(0);
  const [settingsY, setSettingsY] = useState(0);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);

  const SETTINGS_W = 300;
  const MORE_W = 190;

  function anchorRect(): DOMRect | null {
    return actionsRef.current?.getBoundingClientRect() ?? null;
  }

  function openSettings() {
    const rect = anchorRect();
    setMoreMenu(null);
    if (rect) {
      // Right-aligned under the icon group, clamped into the viewport so the
      // panel stays reachable when the widget sits at the edge of a dashboard.
      setSettingsX(Math.max(8, Math.min(rect.right - SETTINGS_W, window.innerWidth - SETTINGS_W - 8)));
      setSettingsY(Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 240)));
    }
    setIsSettingsOpen(true);
  }

  function toggleMoreMenu() {
    setIsSettingsOpen(false);
    setMoreMenu((prev) => {
      if (prev) return null;
      const rect = anchorRect();
      if (!rect) return null;
      return {
        x: Math.max(8, Math.min(rect.right - MORE_W, window.innerWidth - MORE_W - 8)),
        y: rect.bottom + 4,
      };
    });
  }

  // Dismiss the More menu the way every other menu on the page behaves. Clicks
  // on the action group itself are left alone — closing there would fight the
  // toggle, so a second click on ⋯ would close and immediately reopen.
  useEffect(() => {
    if (!moreMenu) return;
    function onDown(e: MouseEvent) {
      if (actionsRef.current?.contains(e.target as Node)) return;
      setMoreMenu(null);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setMoreMenu(null); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreMenu]);

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
    pendingUiRef.current.lockedHorizontalScroll = next;
    emitUiConfig({ lockedHorizontalScroll: next });
  }

  const card = cfg.style.card;
  const titleCfg = cfg.style.title;
  const showExportButton = cfg.style.showExportButton;
  const showSearch = cfg.style.showSearch;
  const showHeader = cfg.title.trim() !== '';

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
    <div className="tw-widget" style={cardInlineStyle}>
      {/* The action group is always present, so the topbar always renders. */}
      <div className="tw-topbar">
          {showHeader && (
            <h3 className="tw-title" style={titleInlineStyle}>{cfg.title}</h3>
          )}
          <div className="tw-topbar__actions">
            {showSearch && (
              <div className="tw-search">
                <SearchInput
                  placeholder="Search table…"
                  inputValue={searchQuery}
                  showSearchIcon
                  showClearButton
                  onInputChange={(value: string) => setSearchQuery(value)}
                  onClearButtonClicked={() => setSearchQuery('')}
                  onSubmit={() => stepHit(1)}
                />
                {searchQuery.trim() !== '' && (
                  <div className="tw-search__nav">
                    <span className="tw-search__count">
                      {searchHits.length === 0 ? '0/0' : `${(hitCursor % searchHits.length) + 1}/${searchHits.length}`}
                    </span>
                    <Button
                      iconOnly
                      aria-label="Previous match"
                      leadingIcon={<ChevronUp size={13} />}
                      variant="Gray"
                      size="XSmall"
                      isDisabled={searchHits.length === 0}
                      onClick={() => stepHit(-1)}
                    />
                    <Button
                      iconOnly
                      aria-label="Next match"
                      leadingIcon={<ChevronDown size={13} />}
                      variant="Gray"
                      size="XSmall"
                      isDisabled={searchHits.length === 0}
                      onClick={() => stepHit(1)}
                    />
                  </div>
                )}
              </div>
            )}
            <div className="tw-actions" ref={actionsRef}>
              <ChartActions
                settingsLabel="Table settings"
                moreLabel="More actions"
                onSettingsClick={openSettings}
                onMoreClick={toggleMoreMenu}
              />
            </div>
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
          dataPrecision={cfg.dataPrecision}
          isDataCell={isDataCell}
          searchMatches={searchMatchSet}
          activeMatch={activeHit}
          onCellConfigure={editable && !cfg.locked ? openCellConfig : undefined}
          hiddenRows={filterVisibility.hiddenRows}
          rowColors={filterVisibility.rowColors}
          onUserChange={editable && !cfg.locked ? handleGridChange : undefined}
        />
      </div>

      {/* ── More (⋯) menu ── */}
      {moreMenu && (
        <div
          className="tw-menu"
          style={{ top: moreMenu.y, left: moreMenu.x, width: MORE_W }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {showExportButton ? (
            <button
              className="tw-menu__item"
              onClick={() => { setMoreMenu(null); handleExport(); }}
            >
              <Download size={13} /> Download CSV
            </button>
          ) : (
            <p className="tw-menu__empty">No actions available</p>
          )}
        </div>
      )}

      {/* ── Table Settings (gear) ── */}
      {isSettingsOpen && (
        <Modal
          isOpen={isSettingsOpen}
          positionX={settingsX}
          positionY={settingsY}
          className="tw-settings-modal"
          onClose={() => setIsSettingsOpen(false)}
          header={<ModalHeader title="Table settings" onClose={() => setIsSettingsOpen(false)} />}
        >
          <ModalBody>
            <div className="tw-settings__body">
              <Checkbox
                label="Scroll bar"
                helpText="Available in lock mode. Columns keep their own width and scroll horizontally, instead of every column being compacted to fit the widget."
                checked={hScroll}
                isDisabled={!cfg.locked}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleScrollToggle(e.target.checked)}
              />
              {!cfg.locked && (
                <p className="tw-settings__note">
                  Lock the table layout to use this — an unlocked table already scrolls in both
                  directions.
                </p>
              )}
            </div>
          </ModalBody>
        </Modal>
      )}

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

                  <CounterInput
                    label="Max cells (0 = all)"
                    value={activeSeries?.limit ?? 0}
                    min={0}
                    max={1000}
                    step={1}
                    onChange={({ value }: { name: string; value: number | null }) =>
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
