import { useState, useEffect, useRef } from 'react';
import { TextInput, CounterInput, Button, Switch, SelectInput, DropdownMenu, ActionListItem, ColorInput, UNSTreePicker } from '@faclon-labs/design-sdk';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@faclon-labs/design-sdk/Modal';
import type { UNSNode, UNSWorkspace } from '@faclon-labs/design-sdk/UNSTreePicker';
import { Bold, Italic, ChevronUp, ChevronDown, X, Plus, Grid, Type, ArrowRight, ArrowDown, ArrowLeft, AlignLeft, AlignCenter, AlignRight, Filter, Edit2 } from 'react-feather';
import {
  TableWidgetEnvelope, TableWidgetUIConfig,
  ConditionalRule, ConditionalRuleCondition,
  TableWidgetCardStyle, TableWidgetTitleStyle, TableBorderStyle, TitleAlign, TimeDisplayMode,
  CellBinding, SeriesBinding, SeriesDirection,
  RowFilterConfig, RowFilterItem, RowFilterType,
} from '../../iosense-sdk/types';
import { withTableWidgetDefaults } from '../../iosense-sdk/defaults';
// Single source of truth for the binding index — shared with the dev harness so
// the configurator path and the on-canvas CONFIG_CHANGE path can never drift
// (they must both tag series bindings with `type: 'series'`).
import { buildDynamicBindingPathList } from '../../iosense-sdk/bindings';
import { useUNSTreePicker } from '../../iosense-sdk/useUNSTreePicker';
import { useZoneIgnorePortals } from '../../iosense-sdk/zoneIgnorePortals';
import { parseRangeString, rangeToString, refToCellId, cellIdToRef } from '../TableWidget/formulaEngine';
import { ROW_FILTER_ICONS, ROW_FILTER_ICON_NAMES, DEFAULT_ROW_FILTER_ICON, parseRowFilterRange } from '../TableWidget/rowFilter';
import './TableWidgetConfiguration.css';

interface TableWidgetConfigurationProps {
  config: TableWidgetEnvelope | undefined;
  authentication?: string;
  /** Host signals an existing widget is being edited (vs. adding a new one).
   *  Wired through and logged for now — no field behaviour depends on it yet. */
  editMode?: boolean;
  /** Host-provided back navigation. When present a back button renders in the
   *  config header and clicking it calls this. Absent → no button rendered. */
  onBack?: () => void;
  /** Host-injected UNS source. Gated on the PAIR `unsWorkspaces` + `loadUnsChildren`;
   *  when either is missing the useUNSTreePicker hook stands in (dev harness). */
  unsWorkspaces?: UNSWorkspace[];
  isLoadingWorkspaces?: boolean;
  loadUnsChildren?: (wsId: string, parentId?: string) => Promise<UNSNode[]>;
  searchUnsNodes?: (wsId: string, query: string, limit?: number) => Promise<UNSNode[]>;
  onChange: (config: TableWidgetEnvelope) => void;
}

function buildEnvelope(
  existing: TableWidgetEnvelope | undefined,
  uiConfig: TableWidgetUIConfig,
  title: string,
): TableWidgetEnvelope {
  return {
    _id: existing?._id ?? `widget_${Date.now()}`,
    type: 'TableWidget',
    general: { title },
    uiConfig,
    dynamicBindingPathList: buildDynamicBindingPathList(uiConfig),
  };
}

// cellIdToRef is imported from formulaEngine — one A1 grammar for the whole widget.

// Row layout around the design-sdk Switch. The SDK Switch is a bare toggle
// (it takes only an accessibilityLabel), so the title/help-text row lives here
// while the control itself stays a design-sdk component rather than the
// hand-rolled div switch this replaced.
function ToggleRow({ label, hint, checked, onChange }: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="wt-style-toggle">
      <div className="wt-style-toggle__info">
        <span className="wt-style-toggle__label">{label}</span>
        {hint && <span className="wt-style-toggle__hint">{hint}</span>}
      </div>
      <Switch
        accessibilityLabel={label}
        size="Small"
        isChecked={checked}
        onChange={({ isChecked }: { isChecked: boolean }) => onChange(isChecked)}
      />
    </div>
  );
}

// Plain-language readout of the cells a series will populate. Without this the
// only way to discover that a 24-bucket series lands in 9 cells of a 10-row
// grid is to bind it and count — the exact confusion behind "the response is
// there but the cells are empty".
function describeSeriesSpan(series: SeriesBinding, rows: number, columns: number): string {
  const m = /^R(\d+)C(\d+)$/.exec(series.baseCellId);
  if (!m) return 'Enter a base cell (e.g. A2) to place this series.';
  const r0 = parseInt(m[1], 10);
  const c0 = parseInt(m[2], 10);
  if (r0 >= rows || c0 >= columns) {
    return `${cellIdToRef(series.baseCellId)} is outside the ${rows}×${columns} grid — nothing will be filled.`;
  }
  const room = series.direction === 'vertical' ? rows - r0 : columns - c0;
  const capped = series.limit > 0 ? Math.min(series.limit, room) : room;
  const lastRow = series.direction === 'vertical' ? r0 + capped - 1 : r0;
  const lastCol = series.direction === 'horizontal' ? c0 + capped - 1 : c0;
  const span = capped <= 1
    ? cellIdToRef(series.baseCellId)
    : `${cellIdToRef(series.baseCellId)}:${cellIdToRef(`R${lastRow}C${lastCol}`)}`;
  const cappedBy = series.limit > 0 && series.limit <= room ? 'max cells' : 'grid size';
  return `Fills ${span} — up to ${capped} bucket${capped === 1 ? '' : 's'} (capped by ${cappedBy}). Extra buckets are dropped.`;
}

const CONDITION_LABELS: Record<ConditionalRuleCondition, string> = {
  greaterThan:         '> Greater than',
  lessThan:            '< Less than',
  greaterThanOrEqual:  '≥ Greater or equal',
  lessThanOrEqual:     '≤ Less or equal',
  equalTo:             '= Equal to',
  notEqualTo:          '≠ Not equal to',
  between:             '↔ Between',
  contains:            '⊃ Contains',
  isEmpty:             '∅ Is empty',
  isNotEmpty:          '◉ Is not empty',
};

const NEEDS_VALUE1: ConditionalRuleCondition[] = [
  'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual',
  'equalTo', 'notEqualTo', 'between', 'contains',
];

export function TableWidgetConfiguration(props: TableWidgetConfigurationProps) {
  const { config, authentication, onChange, onBack, editMode } = props;
  const [activeTab, setActiveTab] = useState<'general' | 'style' | 'filter'>('general');
  const configRef = useRef<HTMLDivElement>(null);

  // UNS topic browser source. Prefer Angular-injected props when the workspace
  // list and the child loader are both present; otherwise fall back to the
  // dev-harness hook (fetches workspaces + nodes itself from the bearer token).
  // UNSTreePicker builds the {{uns:wsId://path}} topic from each node it hands
  // back, so no resolve step is needed on our side any more.
  // Keep the picker's portaled dropdown exempt from the host panel's
  // outside-click close, which would otherwise fire the moment an option is hit.
  useZoneIgnorePortals();

  // Gate on the PAIR — half an injection is not an injection. Feeding the hook
  // `undefined` when the host injects is what makes it a genuine no-op rather
  // than a redundant round trip behind the host's own data.
  const hasInjectedUNS =
    props.unsWorkspaces !== undefined && props.loadUnsChildren !== undefined;
  const hook = useUNSTreePicker(hasInjectedUNS ? undefined : authentication);

  const unsWorkspaces    = hasInjectedUNS ? props.unsWorkspaces!  : hook.workspaces;
  const isLoadingWs      = hasInjectedUNS ? (props.isLoadingWorkspaces ?? false) : hook.isLoadingWorkspaces;
  const loadWorkspaces   = hook.loadWorkspaces;
  const loadChildren     = hasInjectedUNS ? props.loadUnsChildren! : hook.loadChildren;
  const searchNodes      = hasInjectedUNS ? props.searchUnsNodes   : hook.searchNodes;

  // The host may pass an envelope whose uiConfig is partial or missing keys.
  // Default every key through the shared helper so the form never reads undefined
  // (e.g. `config.uiConfig.style.card`) and always emits a complete envelope.
  const ui = withTableWidgetDefaults(config?.uiConfig);

  const [title, setTitle] = useState<string>(ui.title);
  const [rows, setRows] = useState<number>(ui.rows);
  const [columns, setColumns] = useState<number>(ui.columns);
  const [widgetWidth, setWidgetWidth] = useState<number>(ui.widgetWidth);
  const [widgetHeight, setWidgetHeight] = useState<number>(ui.widgetHeight);
  const [locked, setLocked] = useState<boolean>(ui.locked);
  const [conditionalRules, setConditionalRules] = useState<ConditionalRule[]>(ui.conditionalRules);
  const [cardStyle, setCardStyle] = useState<TableWidgetCardStyle>(ui.style.card);
  const [titleStyle, setTitleStyle] = useState<TableWidgetTitleStyle>(ui.style.title);
  const [tableBorderStyle, setTableBorderStyle] = useState<TableBorderStyle>(ui.style.tableBorderStyle);
  const [showExportButton, setShowExportButton] = useState<boolean>(ui.style.showExportButton);
  const [showSearch, setShowSearch] = useState<boolean>(ui.style.showSearch);
  const [dataPrecision, setDataPrecision] = useState<number | null>(ui.dataPrecision);
  const [timeDisplay, setTimeDisplay] = useState<TimeDisplayMode>(ui.timeDisplay);
  const [cellBindings, setCellBindings] = useState<CellBinding[]>(ui.cellBindings);
  const [seriesBindings, setSeriesBindings] = useState<SeriesBinding[]>(ui.seriesBindings);
  const [rowFilter, setRowFilter] = useState<RowFilterConfig>(ui.rowFilter);
  // Tracks the raw A1-style address the user is typing per binding row (display only)
  const [cellRefInputs, setCellRefInputs] = useState<Record<number, string>>({});
  const [seriesRefInputs, setSeriesRefInputs] = useState<Record<number, string>>({});

  // Range input strings (display only — not in envelope directly)
  const [rangeInputs, setRangeInputs] = useState<Record<string, string>>({});
  // Which rule's condition dropdown is open (SelectInput is a controlled trigger).
  const [openConditionRuleId, setOpenConditionRuleId] = useState<string | null>(null);
  const [ruleRangeErrors, setRuleRangeErrors] = useState<Record<string, string>>({});
  const [rowFilterRangeInput, setRowFilterRangeInput] = useState<string>(ui.rowFilter.range);
  const [rowFilterRangeError, setRowFilterRangeError] = useState<string>('');

  // Add/Edit Filter modal state (Configurator Overlay Pattern — see CLAUDE.md)
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [filterModalX, setFilterModalX] = useState(0);
  const [filterModalY, setFilterModalY] = useState(0);
  const [editingFilterId, setEditingFilterId] = useState<string | null>(null);
  const [filterNameInput, setFilterNameInput] = useState('');
  const [filterColorInput, setFilterColorInput] = useState('#0073ea');
  const [filterIconInput, setFilterIconInput] = useState(DEFAULT_ROW_FILTER_ICON);
  const [filterNameError, setFilterNameError] = useState('');

  useEffect(() => {
    if (config) {
      const u = withTableWidgetDefaults(config.uiConfig);
      setTitle(u.title);
      setRows(u.rows);
      setColumns(u.columns);
      setWidgetWidth(u.widgetWidth);
      setWidgetHeight(u.widgetHeight);
      setLocked(u.locked);
      setConditionalRules(u.conditionalRules);
      setCardStyle(u.style.card);
      setTitleStyle(u.style.title);
      setTableBorderStyle(u.style.tableBorderStyle);
      setShowExportButton(u.style.showExportButton);
      setShowSearch(u.style.showSearch);
      setDataPrecision(u.dataPrecision);
      setTimeDisplay(u.timeDisplay);
      setCellBindings(u.cellBindings);
      setSeriesBindings(u.seriesBindings);
      setRowFilter(u.rowFilter);
      setRowFilterRangeInput(u.rowFilter.range);
      setCellRefInputs({});
      setSeriesRefInputs({});
    }
  }, [config?._id]);

  // The widget canvas can change the grid size (insert/delete row/column emits
  // CONFIG_CHANGE). Track those external changes so this panel's Rows/Columns
  // inputs — and the next emit() — don't revert them. Watching the scalar
  // values (not the config object) keeps the panel's other in-flight state
  // untouched on ordinary emit round-trips.
  useEffect(() => {
    if (!config) return;
    const u = withTableWidgetDefaults(config.uiConfig);
    setRows(u.rows);
    setColumns(u.columns);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.uiConfig?.rows, config?.uiConfig?.columns]);

  // Bindings are ALSO canvas-editable (the widget's Cell Config popover emits
  // CONFIG_CHANGE with the same _id), so panel state must follow external
  // binding changes or its next emit deletes the on-canvas binding. Keyed on
  // the serialized arrays: the panel's own emit round-trips with identical
  // JSON, so this never clobbers in-progress panel edits.
  const externalBindingsJson = JSON.stringify([
    config?.uiConfig?.cellBindings ?? null,
    config?.uiConfig?.seriesBindings ?? null,
  ]);
  useEffect(() => {
    if (!config) return;
    const u = withTableWidgetDefaults(config.uiConfig);
    setCellBindings(u.cellBindings);
    setSeriesBindings(u.seriesBindings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalBindingsJson]);

  useEffect(() => {
    emit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function emit(overrides?: Partial<{
    title: string; rows: number; columns: number;
    widgetWidth: number; widgetHeight: number;
    locked: boolean;
    conditionalRules: ConditionalRule[];
    cellBindings: CellBinding[];
    seriesBindings: SeriesBinding[];
    rowFilter: RowFilterConfig;
    cardStyle: TableWidgetCardStyle;
    titleStyle: TableWidgetTitleStyle;
    tableBorderStyle: TableBorderStyle;
    showExportButton: boolean;
    showSearch: boolean;
    dataPrecision: number | null;
    timeDisplay: TimeDisplayMode;
  }>) {
    const resolved = {
      title:             overrides?.title             ?? title,
      rows:              overrides?.rows              ?? rows,
      columns:           overrides?.columns           ?? columns,
      widgetWidth:       overrides?.widgetWidth       ?? widgetWidth,
      widgetHeight:      overrides?.widgetHeight      ?? widgetHeight,
      locked:            overrides?.locked            ?? locked,
      conditionalRules:  overrides?.conditionalRules  ?? conditionalRules,
      cellBindings:      overrides?.cellBindings      ?? cellBindings,
      seriesBindings:    overrides?.seriesBindings    ?? seriesBindings,
      rowFilter:         overrides?.rowFilter         ?? rowFilter,
      cardStyle:         overrides?.cardStyle         ?? cardStyle,
      titleStyle:        overrides?.titleStyle        ?? titleStyle,
      tableBorderStyle:  overrides?.tableBorderStyle  ?? tableBorderStyle,
      showExportButton:  overrides?.showExportButton  ?? showExportButton,
      showSearch:        overrides?.showSearch        ?? showSearch,
      // `dataPrecision: null` means "don't round" — a ?? fallback would turn
      // that choice back into the default on the next emit.
      dataPrecision:     overrides && 'dataPrecision' in overrides ? overrides.dataPrecision! : dataPrecision,
      timeDisplay:       overrides?.timeDisplay       ?? timeDisplay,
    };

    // Fields the widget canvas owns (cell content/formats, widths, freeze) are
    // passed through from the incoming envelope untouched — the configurator
    // must never wipe on-canvas edits it has no UI for.
    const passthrough = withTableWidgetDefaults(config?.uiConfig);

    const uiConfig: TableWidgetUIConfig = {
      title:            resolved.title,
      rows:             resolved.rows,
      columns:          resolved.columns,
      freezeRows:       passthrough.freezeRows,
      freezeColumns:    passthrough.freezeColumns,
      cells:            passthrough.cells,
      columnWidths:     passthrough.columnWidths,
      rowHeights:       passthrough.rowHeights,
      widgetWidth:      resolved.widgetWidth,
      widgetHeight:     resolved.widgetHeight,
      locked:           resolved.locked,
      conditionalRules: resolved.conditionalRules,
      cellBindings:     resolved.cellBindings,
      seriesBindings:   resolved.seriesBindings,
      rowFilter:        resolved.rowFilter,
      dataPrecision:    resolved.dataPrecision,
      timeDisplay:      resolved.timeDisplay,
      style: {
        card:             resolved.cardStyle,
        title:            resolved.titleStyle,
        tableBorderStyle: resolved.tableBorderStyle,
        showExportButton: resolved.showExportButton,
        showSearch:       resolved.showSearch,
      },
    };

    const envelope = buildEnvelope(config, uiConfig, resolved.title);
    console.log('[TableWidgetConfiguration] envelope', envelope, '| editMode:', editMode ?? false);
    onChange(envelope);
  }

  // ── Debounced emit for free-text fields ─────────────────────────────────────
  // Typing a title/range/value fires onChange once per keystroke; emitting the
  // full envelope on every keystroke is what makes the host (and, upstream, a
  // resolveAndCompute round-trip) fire far more often than needed. These fields
  // coalesce rapid keystrokes into a single emit ~150ms after the user pauses.
  // Local component state (the text the user sees) still updates instantly —
  // only the outbound onChange() is delayed. Discrete actions (toggles, add/
  // remove/reorder, color/select pickers) stay on the immediate `emit` above,
  // since there's no keystroke burst to coalesce and instant feedback matters.
  //
  // `emitRef` always points at the *latest* `emit` closure (refreshed every
  // render) so a debounced call that fires after other, immediate edits have
  // already landed still reads their current values instead of clobbering
  // them with whatever was in scope when the timer was scheduled.
  const emitRef = useRef(emit);
  emitRef.current = emit;

  const titleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ruleDebounceRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const rowFilterDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced timers fire emitRef.current() with NO overrides: by fire time the
  // state updates have flushed, so the emit reads the freshest values. Passing
  // the list captured at schedule time re-emitted stale state — e.g. a rule
  // deleted inside the 150 ms window came back from the dead.
  useEffect(() => {
    return () => {
      // Flush (not just cancel) anything pending so the panel unmounting
      // within 150 ms of the last keystroke doesn't drop that edit.
      let pending = false;
      if (titleDebounceRef.current) { clearTimeout(titleDebounceRef.current); pending = true; }
      if (rowFilterDebounceRef.current) { clearTimeout(rowFilterDebounceRef.current); pending = true; }
      for (const t of Object.values(ruleDebounceRefs.current)) { clearTimeout(t); pending = true; }
      if (pending) emitRef.current();
    };
  }, []);

  function emitTitleDebounced() {
    if (titleDebounceRef.current) clearTimeout(titleDebounceRef.current);
    titleDebounceRef.current = setTimeout(() => {
      titleDebounceRef.current = null;
      emitRef.current();
    }, 150);
  }

  function updateRuleDebounced(ruleId: string, patch: Partial<ConditionalRule>) {
    setConditionalRules((rules) => rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r)));
    if (ruleDebounceRefs.current[ruleId]) clearTimeout(ruleDebounceRefs.current[ruleId]);
    ruleDebounceRefs.current[ruleId] = setTimeout(() => {
      delete ruleDebounceRefs.current[ruleId];
      emitRef.current();
    }, 150);
  }

  function updateRowFilterDebounced(patch: Partial<RowFilterConfig>) {
    setRowFilter((rf) => ({ ...rf, ...patch }));
    if (rowFilterDebounceRef.current) clearTimeout(rowFilterDebounceRef.current);
    rowFilterDebounceRef.current = setTimeout(() => {
      rowFilterDebounceRef.current = null;
      emitRef.current();
    }, 150);
  }

  function updateCardStyle(patch: Partial<TableWidgetCardStyle>) {
    const next = { ...cardStyle, ...patch };
    setCardStyle(next);
    emit({ cardStyle: next });
  }

  function updateTitleStyle(patch: Partial<TableWidgetTitleStyle>) {
    const next = { ...titleStyle, ...patch };
    setTitleStyle(next);
    emit({ titleStyle: next });
  }

  // ── Conditional rule helpers ───────────────────────────────────────────────

  function addRule() {
    const rule: ConditionalRule = {
      id: `rule_${Date.now()}`,
      enabled: true,
      range: null,
      condition: 'greaterThan',
      value1: '',
      value2: '',
      format: { cellColor: '#fde8e8' },
    };
    const next = [...conditionalRules, rule];
    setConditionalRules(next);
    emit({ conditionalRules: next });
  }

  function updateRule(id: string, patch: Partial<ConditionalRule>) {
    const next = conditionalRules.map((r) => r.id === id ? { ...r, ...patch } : r);
    setConditionalRules(next);
    emit({ conditionalRules: next });
  }

  function removeRule(id: string) {
    const next = conditionalRules.filter((r) => r.id !== id);
    setConditionalRules(next);
    emit({ conditionalRules: next });
  }

  function moveRule(id: string, dir: 'up' | 'down') {
    const idx = conditionalRules.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const next = [...conditionalRules];
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setConditionalRules(next);
    emit({ conditionalRules: next });
  }

  // ── Cell binding helpers ───────────────────────────────────────────────────

  // The A1-text drafts (cellRefInputs/seriesRefInputs) are keyed by row index;
  // deleting a row must shift the keys above it down or the next row inherits
  // the deleted row's typed text.
  function shiftIndexKeys(map: Record<number, string>, removed: number): Record<number, string> {
    const next: Record<number, string> = {};
    for (const [k, v] of Object.entries(map)) {
      const i = Number(k);
      if (i === removed) continue;
      next[i > removed ? i - 1 : i] = v;
    }
    return next;
  }

  function addBinding() {
    const next = [...cellBindings, { cellId: '', topic: '' }];
    setCellBindings(next);
    emit({ cellBindings: next });
  }

  function updateBinding(idx: number, patch: Partial<CellBinding>) {
    const next = cellBindings.map((b, i) => i === idx ? { ...b, ...patch } : b);
    setCellBindings(next);
    emit({ cellBindings: next });
  }

  function removeBinding(idx: number) {
    const next = cellBindings.filter((_, i) => i !== idx);
    setCellBindings(next);
    setCellRefInputs((prev) => shiftIndexKeys(prev, idx));
    emit({ cellBindings: next });
  }

  // ── Series population helpers ──────────────────────────────────────────────

  function addSeries() {
    const next: SeriesBinding[] = [
      ...seriesBindings,
      { id: `series_${Date.now()}`, baseCellId: '', topic: '', direction: 'vertical', limit: 0 },
    ];
    setSeriesBindings(next);
    emit({ seriesBindings: next });
  }

  function updateSeries(idx: number, patch: Partial<SeriesBinding>) {
    const next = seriesBindings.map((s, i) => i === idx ? { ...s, ...patch } : s);
    setSeriesBindings(next);
    emit({ seriesBindings: next });
  }

  function removeSeries(idx: number) {
    const next = seriesBindings.filter((_, i) => i !== idx);
    setSeriesBindings(next);
    setSeriesRefInputs((prev) => shiftIndexKeys(prev, idx));
    emit({ seriesBindings: next });
  }

  // ── Row Filter helpers ──────────────────────────────────────────────────────

  function updateRowFilter(patch: Partial<RowFilterConfig>) {
    const next = { ...rowFilter, ...patch };
    setRowFilter(next);
    emit({ rowFilter: next });
  }

  function updateRowFilterRange(value: string) {
    setRowFilterRangeInput(value);
    if (value.trim() === '') {
      setRowFilterRangeError('');
      updateRowFilterDebounced({ range: '', colIndex: null, startRow: null, endRow: null });
      return;
    }
    const parsed = parseRowFilterRange(value);
    if (!parsed) {
      setRowFilterRangeError('Range must be a single column, e.g. A2:A10');
      return;
    }
    setRowFilterRangeError('');
    updateRowFilterDebounced({ range: value, ...parsed });
  }

  function moveFilter(id: string, dir: 'up' | 'down') {
    const idx = rowFilter.filters.findIndex((f) => f.id === id);
    if (idx < 0) return;
    const next = [...rowFilter.filters];
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    updateRowFilter({ filters: next });
  }

  function removeFilter(id: string) {
    updateRowFilter({ filters: rowFilter.filters.filter((f) => f.id !== id) });
  }

  function openFilterModal(e: React.MouseEvent, filter?: RowFilterItem) {
    e.stopPropagation();
    if (configRef.current) {
      const rect = configRef.current.getBoundingClientRect();
      setFilterModalX(rect.right + 30);
      setFilterModalY(rect.top);
    }
    setEditingFilterId(filter?.id ?? null);
    setFilterNameInput(filter?.name ?? '');
    setFilterColorInput(filter?.color ?? '#0073ea');
    setFilterIconInput(filter?.icon ?? DEFAULT_ROW_FILTER_ICON);
    setFilterNameError('');
    setIsFilterModalOpen(true);
  }

  function closeFilterModal() {
    setIsFilterModalOpen(false);
    setEditingFilterId(null);
    setFilterNameInput('');
    setFilterColorInput('#0073ea');
    setFilterIconInput(DEFAULT_ROW_FILTER_ICON);
    setFilterNameError('');
  }

  function submitFilterModal() {
    const name = filterNameInput.trim();
    if (!name) { setFilterNameError('Name is required'); return; }
    const isDuplicate = rowFilter.filters.some(
      (f) => f.id !== editingFilterId && f.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (isDuplicate) { setFilterNameError('A filter with this name already exists'); return; }

    const next = editingFilterId
      ? rowFilter.filters.map((f) =>
          f.id === editingFilterId ? { ...f, name, color: filterColorInput, icon: filterIconInput } : f,
        )
      : [...rowFilter.filters, { id: `filter_${Date.now()}`, name, color: filterColorInput, icon: filterIconInput }];

    updateRowFilter({ filters: next });
    closeFilterModal();
  }

  return (
    <div className="wt-config" ref={configRef}>
      <div className="wt-config__header">
        {onBack && (
          <Button
            iconOnly
            leadingIcon={<ArrowLeft size={16} />}
            variant="Gray"
            size="Small"
            aria-label="Back"
            onClick={() => onBack()}
          />
        )}
        <span className="wt-config__title LabelMediumDefault">TableWidget</span>
      </div>

      {/* ── Tab bar ── */}
      <div className="wt-config__tabs">
        <button
          className={`wt-config__tab${activeTab === 'general' ? ' wt-config__tab--active' : ''}`}
          onClick={() => setActiveTab('general')}
        >General</button>
        <button
          className={`wt-config__tab${activeTab === 'style' ? ' wt-config__tab--active' : ''}`}
          onClick={() => setActiveTab('style')}
        >Style</button>
        <button
          className={`wt-config__tab${activeTab === 'filter' ? ' wt-config__tab--active' : ''}`}
          onClick={() => setActiveTab('filter')}
        >Filter</button>
      </div>

      {activeTab === 'general' ? (

        <div className="wt-config__body">
          <TextInput
            label="Widget Title"
            placeholder="Enter title (leave empty to hide)"
            value={title}
            onChange={({ value }: { name: string; value: string }) => {
              setTitle(value);
              emitTitleDebounced();
            }}
          />

          <p className="wt-config__section-title">Grid Size</p>

          <div className={`wt-config__row${locked ? ' wt-config__row--disabled' : ''}`}>
            <CounterInput
              label="Rows"
              value={rows}
              min={1}
              max={100}
              step={1}
              isDisabled={locked}
              onChange={({ value }: { name: string; value: number | null }) => {
                if (locked) return;
                const next = value ?? 1;
                setRows(next);
                emit({ rows: next });
              }}
            />

            <CounterInput
              label="Columns"
              value={columns}
              min={1}
              max={50}
              step={1}
              isDisabled={locked}
              onChange={({ value }: { name: string; value: number | null }) => {
                if (locked) return;
                const next = value ?? 1;
                setColumns(next);
                emit({ columns: next });
              }}
            />
          </div>

          <p className="wt-config__section-title">Widget Size</p>

          <div className="wt-config__row">
            <CounterInput
              label="Width (px)"
              value={widgetWidth}
              min={200}
              max={3000}
              step={10}
              onChange={({ value }: { name: string; value: number | null }) => {
                const next = value ?? 700;
                setWidgetWidth(next);
                emit({ widgetWidth: next });
              }}
            />
            <CounterInput
              label="Height (px)"
              value={widgetHeight}
              min={200}
              max={3000}
              step={10}
              onChange={({ value }: { name: string; value: number | null }) => {
                const next = value ?? 500;
                setWidgetHeight(next);
                emit({ widgetHeight: next });
              }}
            />
          </div>

          <p className="wt-config__hint">
            The size the widget asks for. A dashboard tile that gives it less room wins — the table
            scrolls inside whatever space it actually gets.
          </p>

          {/* ── Lock table layout ── */}
          <ToggleRow
            label="Lock table layout"
            hint="Read-only view: no cell editing, resizing or row/column changes. Rows and columns are scaled to fill the widget exactly, leaving no empty background."
            checked={locked}
            onChange={(next) => { setLocked(next); emit({ locked: next }); }}
          />

          {/* ── Data display ── */}
          <p className="wt-config__section-title">Data Display</p>

          <div className="wt-config__row">
            <CounterInput
              label="Decimal places"
              value={dataPrecision ?? 0}
              min={0}
              max={10}
              step={1}
              isDisabled={dataPrecision === null}
              onChange={({ value }: { name: string; value: number | null }) => {
                const next = value ?? 0;
                setDataPrecision(next);
                emit({ dataPrecision: next });
              }}
            />
            <div className="wt-config__field">
              <span className="wt-config__label BodySmallDefault">Rounding</span>
              <div className="wt-seg-group">
                {([
                  { value: false, label: 'Fixed' },
                  { value: true,  label: 'Full' },
                ] as { value: boolean; label: string }[]).map(({ value, label }) => (
                  <button
                    key={label}
                    className={`wt-seg-btn${(dataPrecision === null) === value ? ' wt-seg-btn--active' : ''}`}
                    onClick={() => {
                      const next = value ? null : 2;
                      setDataPrecision(next);
                      emit({ dataPrecision: next });
                    }}
                  >{label}</button>
                ))}
              </div>
            </div>
          </div>
          <p className="wt-config__hint">
            Applies to every numeric cell. “Full” keeps the value exactly as the topic returned it;
            a cell can still override this from the table toolbar.
          </p>

          <div className="wt-config__field">
            <span className="wt-config__label BodySmallDefault">Timestamps</span>
            <div className="wt-seg-group">
              {([
                { value: 'local', label: 'Local time' },
                { value: 'utc',   label: 'Global (UTC)' },
              ] as { value: TimeDisplayMode; label: string }[]).map(({ value, label }) => (
                <button
                  key={value}
                  className={`wt-seg-btn${timeDisplay === value ? ' wt-seg-btn--active' : ''}`}
                  onClick={() => {
                    setTimeDisplay(value);
                    emit({ timeDisplay: value });
                  }}
                >{label}</button>
              ))}
            </div>
          </div>
          <p className="wt-config__hint">
            Which clock series buckets are cut and labelled against. “Global” reads the same for every
            viewer regardless of their browser timezone.
          </p>

          {/* ── Conditional Formatting ── */}
          <div className="wt-cf-section-head">
            <p className="wt-config__section-title" style={{ margin: 0 }}>Conditional Formatting</p>
            <button className="wt-cf-add-icon-btn" title="Add rule" onClick={addRule}>
              <Plus size={14} />
            </button>
          </div>

          {conditionalRules.length === 0 && (
            <p className="wt-config__hint">No rules yet. Click ＋ to add a formatting rule.</p>
          )}

          {conditionalRules.map((rule, idx) => (
            <div key={rule.id} className={`wt-cf-rule${rule.enabled ? '' : ' wt-cf-rule--disabled'}`}>

              {/* ── Header ── */}
              <div className="wt-cf-rule__head">
                <label className="wt-cf-rule__label">
                  <input
                    type="checkbox"
                    className="wt-cf-rule__checkbox"
                    checked={rule.enabled}
                    onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
                  />
                  <span className="wt-cf-rule__title">Rule {idx + 1}</span>
                </label>
                <div className="wt-cf-rule__actions">
                  <button className="wt-cf-icon-btn" title="Move up"   disabled={idx === 0}                          onClick={() => moveRule(rule.id, 'up')}>  <ChevronUp   size={11} /></button>
                  <button className="wt-cf-icon-btn" title="Move down" disabled={idx === conditionalRules.length - 1} onClick={() => moveRule(rule.id, 'down')}><ChevronDown size={11} /></button>
                  <button className="wt-cf-icon-btn wt-cf-icon-btn--danger" title="Delete" onClick={() => removeRule(rule.id)}><X size={11} /></button>
                </div>
              </div>

              {/* ── Body ── */}
              <div className="wt-cf-rule__body">

                {/* Range + Condition on one row */}
                <div className="wt-cf-rule__2col">
                  <div className="wt-cf-rule__field">
                    <TextInput
                      label="Range"
                      placeholder="All cells"
                      value={rangeInputs[rule.id] ?? rangeToString(rule.range)}
                      onChange={({ value }: { name: string; value: string }) => {
                        setRangeInputs((prev) => ({ ...prev, [rule.id]: value }));
                        // Commit only empty (= all cells) or a valid range —
                        // an in-progress/invalid string must never silently
                        // become range:null and apply the rule everywhere.
                        if (value.trim() === '') {
                          setRuleRangeErrors((prev) => ({ ...prev, [rule.id]: '' }));
                          updateRuleDebounced(rule.id, { range: null });
                          return;
                        }
                        const parsed = parseRangeString(value);
                        if (!parsed) {
                          setRuleRangeErrors((prev) => ({ ...prev, [rule.id]: 'Invalid range — e.g. A1 or B2:D5' }));
                          return;
                        }
                        setRuleRangeErrors((prev) => ({ ...prev, [rule.id]: '' }));
                        updateRuleDebounced(rule.id, { range: parsed });
                      }}
                    />
                    {ruleRangeErrors[rule.id] ? (
                      <p className="wt-cf-range-error">{ruleRangeErrors[rule.id]}</p>
                    ) : null}
                  </div>
                  <div className="wt-cf-rule__field">
                    <SelectInput
                      label="Condition"
                      value={CONDITION_LABELS[rule.condition]}
                      isOpen={openConditionRuleId === rule.id}
                      onClick={() => setOpenConditionRuleId((id) => (id === rule.id ? null : rule.id))}
                    >
                      {openConditionRuleId === rule.id && (
                        <DropdownMenu>
                          {(Object.keys(CONDITION_LABELS) as ConditionalRuleCondition[]).map((c) => (
                            <ActionListItem
                              key={c}
                              title={CONDITION_LABELS[c]}
                              isSelected={rule.condition === c}
                              onClick={() => {
                                updateRule(rule.id, { condition: c });
                                setOpenConditionRuleId(null);
                              }}
                            />
                          ))}
                        </DropdownMenu>
                      )}
                    </SelectInput>
                  </div>
                </div>

                {/* Value inputs */}
                {NEEDS_VALUE1.includes(rule.condition) && (
                  <div className="wt-cf-rule__2col">
                    <div className="wt-cf-rule__field">
                      <TextInput
                        label={rule.condition === 'between' ? 'Min' : 'Value'}
                        placeholder="0"
                        value={rule.value1}
                        onChange={({ value }: { name: string; value: string }) =>
                          updateRuleDebounced(rule.id, { value1: value })
                        }
                      />
                    </div>
                    {rule.condition === 'between' ? (
                      <div className="wt-cf-rule__field">
                        <TextInput
                          label="Max"
                          placeholder="100"
                          value={rule.value2}
                          onChange={({ value }: { name: string; value: string }) =>
                            updateRuleDebounced(rule.id, { value2: value })
                          }
                        />
                      </div>
                    ) : <div />}
                  </div>
                )}

                {/* Format strip */}
                <div className="wt-cf-rule__format-strip">
                  <span className="wt-cf-label">Format</span>

                  <Button
                    iconOnly
                    aria-label="Bold matching cells"
                    leadingIcon={<Bold size={12} />}
                    variant={rule.format.bold ? 'Primary' : 'Gray'}
                    size="XSmall"
                    onClick={() => updateRule(rule.id, { format: { ...rule.format, bold: !rule.format.bold } })}
                  />
                  <Button
                    iconOnly
                    aria-label="Italicise matching cells"
                    leadingIcon={<Italic size={12} />}
                    variant={rule.format.italic ? 'Primary' : 'Gray'}
                    size="XSmall"
                    onClick={() => updateRule(rule.id, { format: { ...rule.format, italic: !rule.format.italic } })}
                  />

                  <div className="wt-cf-color-pair">
                    <span className="wt-cf-color-pair__label">Bg</span>
                    <ColorInput
                      value={rule.format.cellColor || '#ffffff'}
                      onChange={(color: string) =>
                        updateRule(rule.id, { format: { ...rule.format, cellColor: color } })
                      }
                    />
                  </div>

                  <div className="wt-cf-color-pair">
                    <span className="wt-cf-color-pair__label">Text</span>
                    <ColorInput
                      value={rule.format.textColor || '#1a1a1a'}
                      onChange={(color: string) =>
                        updateRule(rule.id, { format: { ...rule.format, textColor: color } })
                      }
                    />
                  </div>
                </div>

              </div>
            </div>
          ))}

          {/* ── Data Bindings ── */}
          <div className="wt-cf-section-head">
            <p className="wt-config__section-title" style={{ margin: 0 }}>Data Bindings</p>
            <button className="wt-cf-add-icon-btn" title="Add binding" onClick={addBinding}>
              <Plus size={14} />
            </button>
          </div>

          {cellBindings.length === 0 && (
            <p className="wt-config__hint">No bindings. Click ＋ to bind a cell to a UNS topic.</p>
          )}

          {cellBindings.map((binding, idx) => (
            <div key={idx} className="wt-binding-row">
              <div className="wt-binding-row__cell">
                <TextInput
                  label="Cell"
                  placeholder="e.g. A1"
                  value={cellRefInputs[idx] ?? (binding.cellId ? cellIdToRef(binding.cellId) : '')}
                  onChange={({ value }: { name: string; value: string }) => {
                    setCellRefInputs(prev => ({ ...prev, [idx]: value }));
                    try {
                      const cellId = refToCellId(value);
                      updateBinding(idx, { cellId });
                    } catch { /* invalid ref — wait for more input */ }
                  }}
                />
              </div>
              <div className="wt-binding-row__topic">
                <UNSTreePicker
                  label="UNS Topic"
                  placeholder="Select a topic…"
                  value={binding.topic}
                  workspaces={unsWorkspaces}
                  isLoadingWorkspaces={isLoadingWs}
                  loadChildren={loadChildren}
                  searchNodes={searchNodes}
                  onOpen={loadWorkspaces}
                  onChange={(value) => updateBinding(idx, { topic: value })}
                />
              </div>
              <button
                className="wt-cf-icon-btn wt-cf-icon-btn--danger wt-binding-row__remove"
                title="Remove binding"
                onClick={() => removeBinding(idx)}
              >
                <X size={11} />
              </button>
            </div>
          ))}

          {/* ── Series Population ── */}
          <div className="wt-cf-section-head">
            <p className="wt-config__section-title" style={{ margin: 0 }}>Series Population</p>
            <button className="wt-cf-add-icon-btn" title="Add series" onClick={addSeries}>
              <Plus size={14} />
            </button>
          </div>

          <p className="wt-config__hint">
            A series binds ONE topic that resolves to a list of time buckets and spreads it from a
            base cell — down the rows or across the columns. Bucket size comes from the dashboard
            periodicity; “Max cells” caps how many buckets are written, and the grid itself caps the
            rest.
          </p>

          {seriesBindings.length === 0 && (
            <p className="wt-config__hint">
              No series. Click ＋ to spread an array topic from a base cell across rows or columns.
            </p>
          )}

          {seriesBindings.map((series, idx) => (
            <div key={series.id} className="wt-series-item">
              <div className="wt-binding-row">
                <div className="wt-binding-row__cell">
                  <TextInput
                    label="Base cell"
                    placeholder="e.g. A1"
                    value={seriesRefInputs[idx] ?? (series.baseCellId ? cellIdToRef(series.baseCellId) : '')}
                    onChange={({ value }: { name: string; value: string }) => {
                      setSeriesRefInputs(prev => ({ ...prev, [idx]: value }));
                      try {
                        const baseCellId = refToCellId(value);
                        updateSeries(idx, { baseCellId });
                      } catch { /* invalid ref — wait for more input */ }
                    }}
                  />
                </div>
                <div className="wt-binding-row__topic">
                  <UNSTreePicker
                    label="Array topic"
                    placeholder="Select a topic…"
                    value={series.topic}
                    workspaces={unsWorkspaces}
                    isLoadingWorkspaces={isLoadingWs}
                    loadChildren={loadChildren}
                    searchNodes={searchNodes}
                    onOpen={loadWorkspaces}
                    onChange={(value) => updateSeries(idx, { topic: value })}
                  />
                </div>
                <button
                  className="wt-cf-icon-btn wt-cf-icon-btn--danger wt-binding-row__remove"
                  title="Remove series"
                  onClick={() => removeSeries(idx)}
                >
                  <X size={11} />
                </button>
              </div>

              <div className="wt-series-item__controls">
                <div className="wt-series-item__direction">
                  <span className="wt-config__label BodySmallDefault">Direction</span>
                  <div className="wt-seg-group">
                    {([
                      { value: 'vertical',   label: 'Down',   icon: <ArrowDown size={11} /> },
                      { value: 'horizontal', label: 'Across',  icon: <ArrowRight size={11} /> },
                    ] as { value: SeriesDirection; label: string; icon: React.ReactNode }[]).map(({ value, label, icon }) => (
                      <button
                        key={value}
                        className={`wt-seg-btn${series.direction === value ? ' wt-seg-btn--active' : ''}`}
                        onClick={() => updateSeries(idx, { direction: value })}
                      >
                        <span className="wt-series-item__seg-content">{icon}{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="wt-series-item__limit">
                  <CounterInput
                    label="Max cells (0 = all)"
                    value={series.limit}
                    min={0}
                    max={1000}
                    step={1}
                    onChange={({ value }: { name: string; value: number | null }) =>
                      updateSeries(idx, { limit: value ?? 0 })
                    }
                  />
                </div>
              </div>

              <p className="wt-config__hint wt-series-item__span">{describeSeriesSpan(series, rows, columns)}</p>
            </div>
          ))}

        </div>

      ) : activeTab === 'style' ? (

        <div className="wt-config__body">

          {/* ── Table section ── */}
          <div className="wt-style-section">
            <div className="wt-style-section__head">
              <Grid size={13} />
              <span>Table</span>
            </div>
            <div className="wt-style-section__body">

              {/* Grid borders */}
              <div className="wt-config__field">
                <span className="wt-config__label BodySmallDefault">Grid lines</span>
                <div className="wt-seg-group">
                  {([
                    { value: 'none',    label: 'None' },
                    { value: 'rows',    label: 'Rows' },
                    { value: 'columns', label: 'Cols' },
                    { value: 'all',     label: 'All' },
                  ] as { value: TableBorderStyle; label: string }[]).map(({ value, label }) => (
                    <button
                      key={value}
                      className={`wt-seg-btn${tableBorderStyle === value ? ' wt-seg-btn--active' : ''}`}
                      onClick={() => {
                        setTableBorderStyle(value);
                        emit({ tableBorderStyle: value });
                      }}
                    >{label}</button>
                  ))}
                </div>
              </div>

              <ToggleRow
                label="Wrap in card"
                hint="Add a visible border around the widget"
                checked={cardStyle.wrapInCard}
                onChange={(next) => updateCardStyle({ wrapInCard: next })}
              />

              <ToggleRow
                label="Show download button"
                hint="Display the CSV download icon in the header"
                checked={showExportButton}
                onChange={(next) => { setShowExportButton(next); emit({ showExportButton: next }); }}
              />

              <ToggleRow
                label="Show search"
                hint="Search the table from its header and step through matches"
                checked={showSearch}
                onChange={(next) => { setShowSearch(next); emit({ showSearch: next }); }}
              />

              {/* Background — always visible */}
              <ColorInput
                label="Background"
                value={cardStyle.bg || '#ffffff'}
                onChange={(c: string) => updateCardStyle({ bg: c })}
              />

              {cardStyle.wrapInCard && (
                <>
                  {/* Border color */}
                  <ColorInput
                    label="Border color"
                    value={cardStyle.borderColor || '#e0e0e0'}
                    onChange={(c: string) => updateCardStyle({ borderColor: c })}
                  />

                  {/* Border width */}
                  <div className="wt-config__field">
                    <span className="wt-config__label BodySmallDefault">Border width</span>
                    <div className="wt-seg-group">
                      {([1, 2, 3] as const).map((w) => (
                        <button
                          key={w}
                          className={`wt-seg-btn${cardStyle.borderWidth === w ? ' wt-seg-btn--active' : ''}`}
                          onClick={() => updateCardStyle({ borderWidth: w })}
                        >
                          {w}px
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Corner radius + Padding */}
                  <div className="wt-config__row">
                    <CounterInput
                      label="Corner radius"
                      value={cardStyle.borderRadius}
                      min={0}
                      max={32}
                      step={1}
                      onChange={({ value }: { name: string; value: number | null }) =>
                        updateCardStyle({ borderRadius: value ?? 0 })
                      }
                    />
                    <CounterInput
                      label="Padding"
                      value={cardStyle.padding}
                      min={0}
                      max={64}
                      step={4}
                      onChange={({ value }: { name: string; value: number | null }) =>
                        updateCardStyle({ padding: value ?? 0 })
                      }
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── Title section ── */}
          <div className="wt-style-section">
            <div className="wt-style-section__head">
              <Type size={13} />
              <span>Title</span>
            </div>
            <div className="wt-style-section__body">

              {/* Color */}
              <ColorInput
                label="Color"
                value={titleStyle.color || '#1a1a1a'}
                onChange={(c: string) => updateTitleStyle({ color: c })}
              />

              {/* Font size */}
              <CounterInput
                label="Font size"
                value={titleStyle.fontSize}
                min={10}
                max={48}
                step={1}
                onChange={({ value }: { name: string; value: number | null }) =>
                  updateTitleStyle({ fontSize: value ?? 16 })
                }
              />

              {/* Alignment */}
              <div className="wt-config__field">
                <span className="wt-config__label BodySmallDefault">Alignment</span>
                <div className="wt-seg-group">
                  {([
                    { value: 'left',   label: 'Left',   icon: <AlignLeft   size={12} /> },
                    { value: 'center', label: 'Center', icon: <AlignCenter size={12} /> },
                    { value: 'right',  label: 'Right',  icon: <AlignRight  size={12} /> },
                  ] as { value: TitleAlign; label: string; icon: React.ReactNode }[]).map(({ value, label, icon }) => (
                    <button
                      key={value}
                      className={`wt-seg-btn${titleStyle.align === value ? ' wt-seg-btn--active' : ''}`}
                      title={label}
                      onClick={() => updateTitleStyle({ align: value })}
                    >
                      <span className="wt-series-item__seg-content">{icon}{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Font weight */}
              <div className="wt-config__field">
                <span className="wt-config__label BodySmallDefault">Weight</span>
                <div className="wt-seg-group">
                  {(['regular', 'medium', 'bold'] as const).map((w) => (
                    <button
                      key={w}
                      className={`wt-seg-btn${titleStyle.fontWeight === w ? ' wt-seg-btn--active' : ''}`}
                      onClick={() => updateTitleStyle({ fontWeight: w })}
                      style={{
                        fontWeight: w === 'bold' ? 700 : w === 'medium' ? 500 : 400,
                      }}
                    >
                      {w === 'regular' ? 'Regular' : w === 'medium' ? 'Medium' : 'Bold'}
                    </button>
                  ))}
                </div>
              </div>

            </div>
          </div>

        </div>

      ) : (

        <div className="wt-config__body">

          <p className="wt-config__section-title">Range</p>
          <TextInput
            label="Column range"
            placeholder="e.g. A2:A10"
            value={rowFilterRangeInput}
            onChange={({ value }: { name: string; value: string }) => updateRowFilterRange(value)}
          />
          {rowFilterRangeError && (
            <p className="wt-config__hint wt-rowfilter-error">{rowFilterRangeError}</p>
          )}

          <p className="wt-config__section-title">Filter Type</p>
          <div className="wt-seg-group">
            {([
              { value: 'chips', label: 'Chips' },
              { value: 'dropdown', label: 'Dropdown' },
            ] as { value: RowFilterType; label: string }[]).map(({ value, label }) => (
              <button
                key={value}
                className={`wt-seg-btn${rowFilter.filterType === value ? ' wt-seg-btn--active' : ''}`}
                onClick={() => updateRowFilter({ filterType: value })}
              >{label}</button>
            ))}
          </div>

          <ToggleRow
            label="Show instance count"
            hint="Display the number of matching rows next to each filter"
            checked={rowFilter.enableCount}
            onChange={(next) => updateRowFilter({ enableCount: next })}
          />

          <ToggleRow
            label="Hide non-matching rows"
            hint="Rows that don't match any filter are hidden. All filters are shown by default — deselect a chip to hide that category too"
            checked={rowFilter.hideNonMatching}
            onChange={(next) => updateRowFilter({ hideNonMatching: next })}
          />

          <ToggleRow
            label="Highlight matching rows (optional)"
            hint="Tint a row with the active filter's color — can be used with or without hiding"
            checked={rowFilter.enableColor}
            onChange={(next) => updateRowFilter({ enableColor: next })}
          />

          {/* ── Filters list ── */}
          <div className="wt-cf-section-head">
            <p className="wt-config__section-title" style={{ margin: 0 }}>Filters</p>
            <button className="wt-cf-add-icon-btn" title="Add filter" onClick={(e) => openFilterModal(e)}>
              <Plus size={14} />
            </button>
          </div>

          {rowFilter.filters.length === 0 && (
            <p className="wt-config__hint">No filters yet. Click ＋ to add one.</p>
          )}

          {rowFilter.filters.map((filter, idx) => {
            const Icon = ROW_FILTER_ICONS[filter.icon];
            return (
              <div key={filter.id} className="wt-rowfilter-filter-row">
                {Icon && (
                  <span className="wt-rowfilter-filter-row__icon" style={{ color: filter.color }}>
                    <Icon size={14} />
                  </span>
                )}
                <span className="wt-rowfilter-filter-row__swatch" style={{ backgroundColor: filter.color }} />
                <span className="wt-rowfilter-filter-row__name">{filter.name}</span>
                <div className="wt-cf-rule__actions">
                  <button className="wt-cf-icon-btn" title="Move up"   disabled={idx === 0}                          onClick={() => moveFilter(filter.id, 'up')}>  <ChevronUp   size={11} /></button>
                  <button className="wt-cf-icon-btn" title="Move down" disabled={idx === rowFilter.filters.length - 1} onClick={() => moveFilter(filter.id, 'down')}><ChevronDown size={11} /></button>
                  <button className="wt-cf-icon-btn" title="Edit filter" onClick={(e) => openFilterModal(e, filter)}><Edit2 size={11} /></button>
                  <button className="wt-cf-icon-btn wt-cf-icon-btn--danger" title="Delete filter" onClick={() => removeFilter(filter.id)}><X size={11} /></button>
                </div>
              </div>
            );
          })}

        </div>
      )}

      {/* ── Add/Edit Filter modal (Configurator Overlay Pattern) ── */}
      {isFilterModalOpen && (
        <Modal
          isOpen={isFilterModalOpen}
          positionX={filterModalX}
          positionY={filterModalY}
          className="wt-rowfilter-modal"
          onClose={closeFilterModal}
          header={<ModalHeader title={editingFilterId ? 'Edit Filter' : 'Add Filter'} onClose={closeFilterModal} />}
          footer={
            <ModalFooter
              primaryAction={
                <Button
                  variant="Primary"
                  size="Small"
                  label={editingFilterId ? 'Save Filter' : 'Add Filter'}
                  onClick={submitFilterModal}
                />
              }
            />
          }
        >
          <ModalBody>
            <div className="wt-rowfilter-modal__body">
              <TextInput
                label="Name"
                placeholder="e.g. Fail"
                value={filterNameInput}
                onChange={({ value }: { name: string; value: string }) => {
                  setFilterNameInput(value);
                  setFilterNameError('');
                }}
              />
              {filterNameError && <p className="wt-config__hint wt-rowfilter-error">{filterNameError}</p>}

              <ColorInput
                label="Color"
                value={filterColorInput}
                onChange={(color: string) => setFilterColorInput(color)}
              />

              <div className="wt-rowfilter-icon-field">
                <span className="wt-config__label BodySmallDefault">Icon</span>
                <div className="wt-rowfilter-icon-grid">
                  {ROW_FILTER_ICON_NAMES.map((name) => {
                    const Icon = ROW_FILTER_ICONS[name];
                    return (
                      <button
                        key={name}
                        type="button"
                        className={`wt-rowfilter-icon-btn${filterIconInput === name ? ' wt-rowfilter-icon-btn--active' : ''}`}
                        title={name}
                        onClick={() => setFilterIconInput(name)}
                      >
                        <Icon size={14} />
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </ModalBody>
        </Modal>
      )}
    </div>
  );
}
