import { useState, useEffect, useRef } from 'react';
import { TextInput, CounterInput, Button, Popover, PopoverBody } from '@faclon-labs/design-sdk';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@faclon-labs/design-sdk/Modal';
import { UNSPathInput } from '@faclon-labs/design-sdk/UNSPathInput';
import { ColorPicker } from '@faclon-labs/design-sdk';
import { Bold, Italic, ChevronUp, ChevronDown, X, Plus, Grid, Type, ArrowRight, ArrowDown, ArrowLeft, Filter, Edit2 } from 'react-feather';
import {
  TableWidgetEnvelope, TableWidgetUIConfig,
  ConditionalRule, ConditionalRuleCondition,
  TableWidgetCardStyle, TableWidgetTitleStyle, TableBorderStyle,
  CellBinding, SeriesBinding, SeriesDirection,
  RowFilterConfig, RowFilterItem, RowFilterType,
} from '../../iosense-sdk/types';
import { withTableWidgetDefaults } from '../../iosense-sdk/defaults';
import { useUNSTree, UNSTree } from '../../iosense-sdk/useUNSTree';
import { parseRangeString, refToCellId } from '../TableWidget/formulaEngine';
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
  /** Angular-injected UNS tree. When all three injection props are present the
   *  configurator uses them; otherwise it falls back to the useUNSTree hook. */
  unsTree?: UNSTree;
  isLoadingTree?: boolean;
  onLoadWorkspaces?: () => void | Promise<void>;
  resolveUNSValue?: (raw: string) => string;
  onChange: (config: TableWidgetEnvelope) => void;
}

// Extract the bare UNS topic from a stored binding value. Mapped values are
// wrapped as "{{uns:wsId://path}}"; a raw pasted "uns:wsId://path" is accepted
// as-is. Returns '' for empty / unmapped input so it is skipped.
function extractTopic(raw: string | undefined): string {
  const t = (raw ?? '').trim();
  const m = /^\{\{(.+)\}\}$/.exec(t);
  return (m ? m[1] : t).trim();
}

// Build the binding index the mini-engine resolves. Cell bindings use the
// target cellId as the key so the resolved DataEntry lands directly on that
// cell; series bindings use a "series:<baseCellId>" key the widget expands.
function buildDynamicBindingPathList(uiConfig: TableWidgetUIConfig): Array<{ key: string; topic: string }> {
  const paths: Array<{ key: string; topic: string }> = [];

  for (const b of uiConfig.cellBindings) {
    const topic = extractTopic(b.topic);
    if (b.cellId && topic) paths.push({ key: b.cellId, topic });
  }

  for (const s of uiConfig.seriesBindings) {
    const topic = extractTopic(s.topic);
    if (s.baseCellId && topic) paths.push({ key: `series:${s.baseCellId}`, topic });
  }

  return paths;
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

function cellIdToRef(cellId: string): string {
  const m = /^R(\d+)C(\d+)$/.exec(cellId);
  if (!m) return '';
  const row = parseInt(m[1], 10);
  const col = parseInt(m[2], 10);
  let col26 = '';
  let c = col;
  do {
    col26 = String.fromCharCode(65 + (c % 26)) + col26;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${col26}${row + 1}`;
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

  // UNS topic browser source. Prefer Angular-injected props when all three are
  // present; otherwise fall back to the dev-harness hook (fetches workspaces +
  // nodes itself from the bearer token). Without this wiring UNSPathInput has an
  // empty tree and shows no topics — which is the bug this fixes.
  const hook = useUNSTree(authentication);
  const hasInjectedUNS =
    props.unsTree !== undefined &&
    props.onLoadWorkspaces !== undefined &&
    props.resolveUNSValue !== undefined;
  const unsTree        = hasInjectedUNS ? props.unsTree!         : hook.unsTree;
  const isLoadingTree  = hasInjectedUNS ? (props.isLoadingTree ?? false) : hook.isLoadingTree;
  const loadWorkspaces = hasInjectedUNS ? props.onLoadWorkspaces! : hook.loadWorkspaces;
  const resolveUNSValue = hasInjectedUNS ? props.resolveUNSValue! : hook.resolveUNSValue;

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
  const [cellBindings, setCellBindings] = useState<CellBinding[]>(ui.cellBindings);
  const [seriesBindings, setSeriesBindings] = useState<SeriesBinding[]>(ui.seriesBindings);
  const [rowFilter, setRowFilter] = useState<RowFilterConfig>(ui.rowFilter);
  // Tracks the raw A1-style address the user is typing per binding row (display only)
  const [cellRefInputs, setCellRefInputs] = useState<Record<number, string>>({});
  const [seriesRefInputs, setSeriesRefInputs] = useState<Record<number, string>>({});

  // Range input strings (display only — not in envelope directly)
  const [rangeInputs, setRangeInputs] = useState<Record<string, string>>({});
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
      setCellBindings(u.cellBindings);
      setSeriesBindings(u.seriesBindings);
      setRowFilter(u.rowFilter);
      setRowFilterRangeInput(u.rowFilter.range);
      setCellRefInputs({});
      setSeriesRefInputs({});
    }
  }, [config?._id]);

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
    };

    const uiConfig: TableWidgetUIConfig = {
      title:            resolved.title,
      rows:             resolved.rows,
      columns:          resolved.columns,
      freezeRows:       0,
      freezeColumns:    0,
      widgetWidth:      resolved.widgetWidth,
      widgetHeight:     resolved.widgetHeight,
      locked:           resolved.locked,
      conditionalRules: resolved.conditionalRules,
      cellBindings:     resolved.cellBindings,
      seriesBindings:   resolved.seriesBindings,
      rowFilter:        resolved.rowFilter,
      style: {
        card:             resolved.cardStyle,
        title:            resolved.titleStyle,
        tableBorderStyle: resolved.tableBorderStyle,
        showExportButton: resolved.showExportButton,
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

  useEffect(() => {
    return () => {
      if (titleDebounceRef.current) clearTimeout(titleDebounceRef.current);
      if (rowFilterDebounceRef.current) clearTimeout(rowFilterDebounceRef.current);
      Object.values(ruleDebounceRefs.current).forEach(clearTimeout);
    };
  }, []);

  function emitTitleDebounced(value: string) {
    if (titleDebounceRef.current) clearTimeout(titleDebounceRef.current);
    titleDebounceRef.current = setTimeout(() => emitRef.current({ title: value }), 150);
  }

  function updateRuleDebounced(ruleId: string, patch: Partial<ConditionalRule>) {
    const next = conditionalRules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r));
    setConditionalRules(next);
    if (ruleDebounceRefs.current[ruleId]) clearTimeout(ruleDebounceRefs.current[ruleId]);
    ruleDebounceRefs.current[ruleId] = setTimeout(() => emitRef.current({ conditionalRules: next }), 150);
  }

  function updateRowFilterDebounced(patch: Partial<RowFilterConfig>) {
    const next = { ...rowFilter, ...patch };
    setRowFilter(next);
    if (rowFilterDebounceRef.current) clearTimeout(rowFilterDebounceRef.current);
    rowFilterDebounceRef.current = setTimeout(() => emitRef.current({ rowFilter: next }), 150);
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
              emitTitleDebounced(value);
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

          {/* ── Lock table layout ── */}
          <label className="wt-lock-row">
            <input
              type="checkbox"
              className="wt-lock-row__checkbox"
              checked={locked}
              onChange={(e) => {
                setLocked(e.target.checked);
                emit({ locked: e.target.checked });
              }}
            />
            <div className="wt-lock-row__text">
              <span className="wt-lock-row__label">Lock table layout</span>
              <span className="wt-lock-row__hint">Prevents editing cells, resizing, and adding/removing rows or columns</span>
            </div>
            {locked && <span className="wt-lock-row__badge">Locked</span>}
          </label>

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
                      value={rangeInputs[rule.id] ?? ''}
                      onChange={({ value }: { name: string; value: string }) => {
                        setRangeInputs((prev) => ({ ...prev, [rule.id]: value }));
                        updateRuleDebounced(rule.id, { range: parseRangeString(value) });
                      }}
                    />
                  </div>
                  <div className="wt-cf-rule__field">
                    <span className="wt-cf-label">Condition</span>
                    <select
                      className="wt-cf-select"
                      value={rule.condition}
                      onChange={(e) => updateRule(rule.id, { condition: e.target.value as ConditionalRuleCondition })}
                    >
                      {(Object.keys(CONDITION_LABELS) as ConditionalRuleCondition[]).map((c) => (
                        <option key={c} value={c}>{CONDITION_LABELS[c]}</option>
                      ))}
                    </select>
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
                    leadingIcon={<Bold size={12} />}
                    variant={rule.format.bold ? 'Primary' : 'Gray'}
                    size="XSmall"
                    onClick={() => updateRule(rule.id, { format: { ...rule.format, bold: !rule.format.bold } })}
                  />
                  <Button
                    iconOnly
                    leadingIcon={<Italic size={12} />}
                    variant={rule.format.italic ? 'Primary' : 'Gray'}
                    size="XSmall"
                    onClick={() => updateRule(rule.id, { format: { ...rule.format, italic: !rule.format.italic } })}
                  />

                  <div className="wt-cf-color-pair">
                    <span className="wt-cf-color-pair__label">Bg</span>
                    <Popover
                      trigger={
                        <button
                          className="wt-cf-color-btn"
                          title="Background color"
                          style={{ '--swatch-color': rule.format.cellColor || 'transparent' } as React.CSSProperties}
                        >
                          <span
                            className="wt-cf-color-btn__swatch"
                            style={{
                              backgroundColor: rule.format.cellColor || 'transparent',
                              border: rule.format.cellColor ? '1px solid rgba(0,0,0,0.12)' : '1px dashed #ccc',
                            }}
                          />
                        </button>
                      }
                      placement="Bottom Start"
                    >
                      <PopoverBody>
                        <ColorPicker
                          selectedColor={rule.format.cellColor || '#ffffff'}
                          onColorSelect={(color) =>
                            updateRule(rule.id, { format: { ...rule.format, cellColor: color } })
                          }
                        />
                      </PopoverBody>
                    </Popover>
                  </div>

                  <div className="wt-cf-color-pair">
                    <span className="wt-cf-color-pair__label">Text</span>
                    <Popover
                      trigger={
                        <button
                          className="wt-cf-color-btn"
                          title="Text color"
                        >
                          <span
                            className="wt-cf-color-btn__swatch"
                            style={{
                              backgroundColor: rule.format.textColor || 'transparent',
                              border: rule.format.textColor ? '1px solid rgba(0,0,0,0.12)' : '1px dashed #ccc',
                            }}
                          />
                          <span
                            className="wt-cf-color-btn__letter"
                            style={{ color: rule.format.textColor || '#1a1a1a' }}
                          >A</span>
                        </button>
                      }
                      placement="Bottom Start"
                    >
                      <PopoverBody>
                        <ColorPicker
                          selectedColor={rule.format.textColor || '#1a1a1a'}
                          onColorSelect={(color) =>
                            updateRule(rule.id, { format: { ...rule.format, textColor: color } })
                          }
                        />
                      </PopoverBody>
                    </Popover>
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
                <UNSPathInput
                  label="UNS Topic"
                  placeholder="Type / to browse…"
                  value={binding.topic}
                  tree={unsTree}
                  isLoading={isLoadingTree}
                  onOpen={loadWorkspaces}
                  onChange={(value) => updateBinding(idx, { topic: resolveUNSValue(value) })}
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
                  <UNSPathInput
                    label="Array topic"
                    placeholder="Type / to browse…"
                    value={series.topic}
                    tree={unsTree}
                    isLoading={isLoadingTree}
                    onOpen={loadWorkspaces}
                    onChange={(value) => updateSeries(idx, { topic: resolveUNSValue(value) })}
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

              {/* Wrap in card toggle */}
              <div
                className="wt-style-toggle"
                onClick={() => updateCardStyle({ wrapInCard: !cardStyle.wrapInCard })}
                role="switch"
                aria-checked={cardStyle.wrapInCard}
              >
                <div className="wt-style-toggle__info">
                  <span className="wt-style-toggle__label">Wrap in card</span>
                  <span className="wt-style-toggle__hint">Add a visible border around the widget</span>
                </div>
                <div className={`wt-style-switch${cardStyle.wrapInCard ? ' wt-style-switch--on' : ''}`}>
                  <div className="wt-style-switch__thumb" />
                </div>
              </div>

              {/* Download button visibility */}
              <div
                className="wt-style-toggle"
                onClick={() => {
                  const next = !showExportButton;
                  setShowExportButton(next);
                  emit({ showExportButton: next });
                }}
                role="switch"
                aria-checked={showExportButton}
              >
                <div className="wt-style-toggle__info">
                  <span className="wt-style-toggle__label">Show download button</span>
                  <span className="wt-style-toggle__hint">Display the download icon in the header</span>
                </div>
                <div className={`wt-style-switch${showExportButton ? ' wt-style-switch--on' : ''}`}>
                  <div className="wt-style-switch__thumb" />
                </div>
              </div>

              {/* Background — always visible */}
              <div className="wt-config__field">
                <span className="wt-config__label BodySmallDefault">Background</span>
                <Popover
                  trigger={
                    <button className="wt-style-color-btn">
                      <span
                        className="wt-style-color-swatch"
                        style={{
                          backgroundColor: cardStyle.bg || 'transparent',
                          border: cardStyle.bg ? '1px solid rgba(0,0,0,0.12)' : '1px dashed #ccc',
                        }}
                      />
                      <span className="wt-style-color-label">{cardStyle.bg || 'None'}</span>
                    </button>
                  }
                  placement="Bottom Start"
                >
                  <PopoverBody>
                    <ColorPicker
                      selectedColor={cardStyle.bg || '#ffffff'}
                      onColorSelect={(c) => updateCardStyle({ bg: c })}
                    />
                  </PopoverBody>
                </Popover>
              </div>

              {cardStyle.wrapInCard && (
                <>
                  {/* Border color */}
                  <div className="wt-config__field">
                    <span className="wt-config__label BodySmallDefault">Border color</span>
                    <Popover
                      trigger={
                        <button className="wt-style-color-btn">
                          <span
                            className="wt-style-color-swatch"
                            style={{
                              backgroundColor: cardStyle.borderColor || '#e0e0e0',
                              border: '1px solid rgba(0,0,0,0.12)',
                            }}
                          />
                          <span className="wt-style-color-label">{cardStyle.borderColor || '#e0e0e0'}</span>
                        </button>
                      }
                      placement="Bottom Start"
                    >
                      <PopoverBody>
                        <ColorPicker
                          selectedColor={cardStyle.borderColor || '#e0e0e0'}
                          onColorSelect={(c) => updateCardStyle({ borderColor: c })}
                        />
                      </PopoverBody>
                    </Popover>
                  </div>

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
              <div className="wt-config__field">
                <span className="wt-config__label BodySmallDefault">Color</span>
                <Popover
                  trigger={
                    <button className="wt-style-color-btn">
                      <span
                        className="wt-style-color-swatch"
                        style={{
                          backgroundColor: titleStyle.color || '#1a1a1a',
                          border: '1px solid rgba(0,0,0,0.12)',
                        }}
                      />
                      <span className="wt-style-color-label">{titleStyle.color || 'Default'}</span>
                    </button>
                  }
                  placement="Bottom Start"
                >
                  <PopoverBody>
                    <ColorPicker
                      selectedColor={titleStyle.color || '#1a1a1a'}
                      onColorSelect={(c) => updateTitleStyle({ color: c })}
                    />
                  </PopoverBody>
                </Popover>
              </div>

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

          <div
            className="wt-style-toggle"
            onClick={() => updateRowFilter({ enableCount: !rowFilter.enableCount })}
            role="switch"
            aria-checked={rowFilter.enableCount}
          >
            <div className="wt-style-toggle__info">
              <span className="wt-style-toggle__label">Show instance count</span>
              <span className="wt-style-toggle__hint">Display the number of matching rows next to each filter</span>
            </div>
            <div className={`wt-style-switch${rowFilter.enableCount ? ' wt-style-switch--on' : ''}`}>
              <div className="wt-style-switch__thumb" />
            </div>
          </div>

          <div
            className="wt-style-toggle"
            onClick={() => updateRowFilter({ hideNonMatching: !rowFilter.hideNonMatching })}
            role="switch"
            aria-checked={rowFilter.hideNonMatching}
          >
            <div className="wt-style-toggle__info">
              <span className="wt-style-toggle__label">Hide non-matching rows</span>
              <span className="wt-style-toggle__hint">Rows that don't match any filter are hidden. All filters are shown by default — deselect a chip to hide that category too</span>
            </div>
            <div className={`wt-style-switch${rowFilter.hideNonMatching ? ' wt-style-switch--on' : ''}`}>
              <div className="wt-style-switch__thumb" />
            </div>
          </div>

          <div
            className="wt-style-toggle"
            onClick={() => updateRowFilter({ enableColor: !rowFilter.enableColor })}
            role="switch"
            aria-checked={rowFilter.enableColor}
          >
            <div className="wt-style-toggle__info">
              <span className="wt-style-toggle__label">Highlight matching rows (optional)</span>
              <span className="wt-style-toggle__hint">Tint a row with the active filter's color — can be used with or without hiding</span>
            </div>
            <div className={`wt-style-switch${rowFilter.enableColor ? ' wt-style-switch--on' : ''}`}>
              <div className="wt-style-switch__thumb" />
            </div>
          </div>

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
          {...({ transparent: true } as any)}
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

              <div className="wt-config__field">
                <span className="wt-config__label BodySmallDefault">Color</span>
                <Popover
                  trigger={
                    <button className="wt-style-color-btn">
                      <span
                        className="wt-style-color-swatch"
                        style={{ backgroundColor: filterColorInput, border: '1px solid rgba(0,0,0,0.12)' }}
                      />
                      <span className="wt-style-color-label">{filterColorInput}</span>
                    </button>
                  }
                  placement="Bottom Start"
                >
                  <PopoverBody>
                    <ColorPicker
                      selectedColor={filterColorInput}
                      onColorSelect={(color) => setFilterColorInput(color)}
                    />
                  </PopoverBody>
                </Popover>
              </div>

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
