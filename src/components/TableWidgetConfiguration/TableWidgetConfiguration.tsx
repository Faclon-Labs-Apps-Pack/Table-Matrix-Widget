import { useState, useEffect, useRef } from 'react';
import {
  TextInput, Button, IconButton, Switch, Checkbox,
  SelectInput, DropdownMenu, ActionListItem, ColorInput, UNSTreePicker,
  Tabs, TabItem, SwitchButtonGroup, SwitchButtonBase,
  TopNav, TopNavLeading, TopNavContent,
  ProductAccordionItem, ListCard, ListCardLeadingItem, ListCardTrailingItem,
} from '@faclon-labs/design-sdk';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@faclon-labs/design-sdk/Modal';
import { Tooltip } from '@faclon-labs/design-sdk/Tooltip';
import type { UNSNode, UNSWorkspace } from '@faclon-labs/design-sdk/UNSTreePicker';
import { Bold, Italic, ChevronUp, ChevronDown, Plus, Trash2, ArrowRight, ArrowDown, ArrowLeft, AlignLeft, AlignCenter, AlignRight, Grid, Columns, Menu, Square, Database } from 'react-feather';
import {
  TableWidgetEnvelope, TableWidgetUIConfig,
  ConditionalRule, ConditionalRuleCondition,
  TableWidgetCardStyle, TableWidgetTitleStyle, TableBorderStyle, TitleAlign, TitleFontWeight, TimeDisplayMode,
  CellBinding, SeriesBinding, SeriesDirection,
  RowFilterConfig, RowFilterType,
} from '../../iosense-sdk/types';
import { withTableWidgetDefaults } from '../../iosense-sdk/defaults';
import { NumberField } from '../TableWidget/NumberField';
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

// The panel's own name, shown in the header. Static — the *widget's* title is a
// separate, editable uiConfig field on the Data tab.
const PANEL_TITLE = 'Table';

// Label-and-switch row. The installed design-sdk Switch is a bare toggle (its
// only naming prop is accessibilityLabel), so the visible label lives here
// while the control itself stays a design-sdk component.
function ToggleRow({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="wt-toggle">
      <span className="wt-toggle__label">{label}</span>
      <Switch
        accessibilityLabel={label}
        size="Small"
        isChecked={checked}
        onChange={({ isChecked }: { isChecked: boolean }) => onChange(isChecked)}
      />
    </div>
  );
}

// A labelled non-input control (segmented groups, mostly). TextInput and
// friends carry their own label; these don't.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="wt-field">
      <span className="wt-field__label BodySmallMedium">{label}</span>
      {children}
    </div>
  );
}

// Every icon-only control in this panel goes through here, so all of them are
// chrome-less and all of them carry hover text — at 280px the icon is all the
// user sees. Labels are Title Case; a delete label must start with the word
// "Delete", which is what the red hover tint keys off (see the CSS).
function IconAction({ icon, label, onClick, isDisabled, size = 'Small' }: {
  icon: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  isDisabled?: boolean;
  size?: 'Small' | 'Medium' | 'Large' | '12' | '16' | '20';
}) {
  return (
    <Tooltip bodyText={label} placement="Bottom">
      <IconButton
        icon={icon}
        size={size}
        emphasis="Subtle"
        accessibilityLabel={label}
        isDisabled={isDisabled}
        onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClick(e); }}
      />
    </Tooltip>
  );
}

// Italic one-liner naming the action that fills an empty section.
function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="wt-config__empty-hint BodySmallRegular">{children}</p>;
}

// Trailing segment of a topic path, which is the only part that fits.
function topicLeaf(topic: string): string {
  const inner = topic.replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
  if (!inner) return 'No topic';
  const path = inner.split('://').pop() ?? inner;
  return path.split('/').filter(Boolean).pop() ?? inner;
}

// One-line summary of a rule's test, for the collapsed list row.
function describeRule(rule: ConditionalRule): string {
  const symbols: Partial<Record<ConditionalRuleCondition, string>> = {
    greaterThan: '>', lessThan: '<', greaterThanOrEqual: '\u2265', lessThanOrEqual: '\u2264',
    equalTo: '=', notEqualTo: '\u2260', contains: 'contains',
  };
  const scope = rule.range ? rangeToString(rule.range) : 'All cells';
  if (rule.condition === 'isEmpty')    return `${scope} \u00b7 is empty`;
  if (rule.condition === 'isNotEmpty') return `${scope} \u00b7 is not empty`;
  if (rule.condition === 'between')    return `${scope} \u00b7 ${rule.value1 || '?'}\u2013${rule.value2 || '?'}`;
  return `${scope} \u00b7 ${symbols[rule.condition] ?? ''} ${rule.value1 || '?'}`.replace(/\s+/g, ' ');
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

// Which nested editor the second panel is showing.
type DetailPane =
  | { kind: 'binding'; index: number }
  | { kind: 'series';  index: number }
  | { kind: 'rule';    id: string }
  | { kind: 'filter';  id: string | null };

const TITLE_WEIGHT_LABELS: Record<TitleFontWeight, string> = {
  regular: 'Regular',
  medium:  'Medium',
  bold:    'Bold',
};

// Second-panel placement. It opens from the top of the viewport, always —
// aligning it with the clicked row made it read as a floating popover, moved it
// whenever the list scrolled, and capped how much of a long form could fit.
const PANEL_TOP = 16;     // px from the top of the viewport
const PANEL_GUTTER = 20;  // px between the config panel's right edge and the panel

const NEEDS_VALUE1: ConditionalRuleCondition[] = [
  'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual',
  'equalTo', 'notEqualTo', 'between', 'contains',
];

export function TableWidgetConfiguration(props: TableWidgetConfigurationProps) {
  const { config, authentication, onChange, onBack, editMode } = props;
  const [activeTab, setActiveTab] = useState<'data' | 'style' | 'filter'>('data');
  // One section open at a time, by construction rather than by convention.
  // Keys are tab-qualified because 'table' exists in two tabs.
  const [openSection, setOpenSection] = useState<string | null>('data.table');
  const toggleSection = (key: string) =>
    setOpenSection((current) => (current === key ? null : key));
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
  const [isWeightOpen, setIsWeightOpen] = useState(false);
  const [ruleRangeErrors, setRuleRangeErrors] = useState<Record<string, string>>({});
  const [rowFilterRangeInput, setRowFilterRangeInput] = useState<string>(ui.rowFilter.range);
  const [rowFilterRangeError, setRowFilterRangeError] = useState<string>('');

  // ── Second panel (Configurator Overlay Pattern — see CLAUDE.md) ───────────
  // The config panel is ~280px wide, which is nowhere near enough for a topic
  // picker, a condition builder or a format strip. Every nested editor
  // therefore opens in a second panel to the right; the narrow panel keeps
  // only one compact summary row per entry.
  const [detail, setDetail] = useState<DetailPane | null>(null);
  const [detailX, setDetailX] = useState(0);
  const [detailY, setDetailY] = useState(0);

  // Filter entries are the one draft-then-commit editor (name is validated for
  // emptiness and duplicates), so their fields are staged here.
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
      // Owned by the widget's own Table Settings menu — pass it through, never
      // rebuild it here, or every configurator edit would reset the operator's
      // scroll choice.
      lockedHorizontalScroll: passthrough.lockedHorizontalScroll,
      // The widget fills whatever container the host gives it, so there is no
      // size form any more; the keys stay in the envelope (the dev harness
      // sizes its preview box from them) and ride through untouched.
      widgetWidth:      passthrough.widgetWidth,
      widgetHeight:     passthrough.widgetHeight,
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

  function addRule(): string {
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
    return rule.id;
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

  // Both panels stay interactive (the overlay backdrop is transparent), so the
  // entry being edited can be deleted from the list behind the editor. Close
  // the second panel when its subject disappears rather than leaving an empty
  // form pointing at nothing.
  useEffect(() => {
    if (!detail) return;
    const gone =
      (detail.kind === 'binding' && !cellBindings[detail.index]) ||
      (detail.kind === 'series'  && !seriesBindings[detail.index]) ||
      (detail.kind === 'rule'    && !conditionalRules.some((r) => r.id === detail.id)) ||
      (detail.kind === 'filter'  && detail.id !== null && !rowFilter.filters.some((f) => f.id === detail.id));
    if (gone) closeDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, cellBindings, seriesBindings, conditionalRules, rowFilter.filters]);

  // Anchor the second panel to the right edge of this one, top-aligned.
  function openDetail(pane: DetailPane, e?: React.MouseEvent) {
    e?.stopPropagation();
    if (configRef.current) {
      const rect = configRef.current.getBoundingClientRect();
      setDetailX(rect.right + PANEL_GUTTER);
      setDetailY(PANEL_TOP);
    }
    if (pane.kind === 'filter') {
      const filter = pane.id ? rowFilter.filters.find((f) => f.id === pane.id) : undefined;
      setFilterNameInput(filter?.name ?? '');
      setFilterColorInput(filter?.color ?? '#0073ea');
      setFilterIconInput(filter?.icon ?? DEFAULT_ROW_FILTER_ICON);
      setFilterNameError('');
    }
    setDetail(pane);
  }

  function closeDetail() {
    setDetail(null);
    setFilterNameInput('');
    setFilterColorInput('#0073ea');
    setFilterIconInput(DEFAULT_ROW_FILTER_ICON);
    setFilterNameError('');
  }

  // Add a binding / series / rule and open its editor in one step, so a new
  // entry is never left as a blank row the user has to find and click.
  function addBindingAndEdit() {
    addBinding();
    openDetail({ kind: 'binding', index: cellBindings.length });
  }

  function addSeriesAndEdit() {
    addSeries();
    openDetail({ kind: 'series', index: seriesBindings.length });
  }

  function addRuleAndEdit() {
    const id = addRule();
    openDetail({ kind: 'rule', id });
  }

  function submitFilterDetail() {
    if (detail?.kind !== 'filter') return;
    const editingFilterId = detail.id;
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
    closeDetail();
  }


  const editingBinding = detail?.kind === 'binding' ? cellBindings[detail.index] : undefined;
  const editingSeries  = detail?.kind === 'series'  ? seriesBindings[detail.index] : undefined;
  const editingRule    = detail?.kind === 'rule'    ? conditionalRules.find((r) => r.id === detail.id) : undefined;

  const detailTitle =
    detail?.kind === 'binding' ? 'Cell Binding'
    : detail?.kind === 'series' ? 'Series Population'
    : detail?.kind === 'rule'   ? 'Formatting Rule'
    : detail?.kind === 'filter' ? (detail.id ? 'Edit Filter' : 'Add Filter')
    : '';

  return (
    <div className="wt-config" ref={configRef}>
      <div className="wt-config__header">
        <TopNav isSticky={false}>
          {onBack && (
            <TopNavLeading>
              <IconAction
                icon={<ArrowLeft size={20} />}
                label="Back"
                size="Medium"
                onClick={() => onBack()}
              />
            </TopNavLeading>
          )}
          <TopNavContent>
            <span className="wt-config__header-title HeadingSmallSemibold">{PANEL_TITLE}</span>
          </TopNavContent>
        </TopNav>
      </div>

      <Tabs
        value={activeTab}
        onChange={(value: string) => setActiveTab(value as typeof activeTab)}
        variant="Bordered"
        size="Medium"
        isFullWidthTabItem
      >
        <TabItem value="data"   label="Data"   />
        <TabItem value="style"  label="Style"  />
        <TabItem value="filter" label="Filter" />
      </Tabs>

      {activeTab === 'data' ? (

        <div className="wt-config__body">
          <div className="wt-config__sections">

            <ProductAccordionItem
              title="Table"
              isActive
              isExpanded={openSection === 'data.table'}
              onToggle={() => toggleSection('data.table')}
            >
              <div className="wt-section">

                <TextInput
                  label="Title"
                  placeholder="Leave empty to hide"
                  value={title}
                  onChange={({ value }: { name: string; value: string }) => {
                    setTitle(value);
                    emitTitleDebounced();
                  }}
                />

                <div className={`wt-config__row${locked ? ' wt-config__row--disabled' : ''}`}>
                  <NumberField
                    className="wt-counter--plain"
                    label="Rows"
                    value={rows}
                    min={1}
                    max={100}
                    step={1}
                    isDisabled={locked}
                    onChange={(value) => {
                      if (locked) return;
                      const next = value ?? 1;
                      setRows(next);
                      emit({ rows: next });
                    }}
                  />
                  <NumberField
                    className="wt-counter--plain"
                    label="Columns"
                    value={columns}
                    min={1}
                    max={50}
                    step={1}
                    isDisabled={locked}
                    onChange={(value) => {
                      if (locked) return;
                      const next = value ?? 1;
                      setColumns(next);
                      emit({ columns: next });
                    }}
                  />
                </div>

                <ToggleRow
                  label="Lock table layout"
                  checked={locked}
                  onChange={(next) => { setLocked(next); emit({ locked: next }); }}
                />

              </div>
            </ProductAccordionItem>

            <ProductAccordionItem
              title="Value Format"
              isActive
              isExpanded={openSection === 'data.values'}
              onToggle={() => toggleSection('data.values')}
            >
              <div className="wt-section">

                <NumberField
                  label="Decimal places"
                  value={dataPrecision ?? 0}
                  min={0}
                  max={10}
                  step={1}
                  isDisabled={dataPrecision === null}
                  onChange={(value) => {
                    const next = value ?? 0;
                    setDataPrecision(next);
                    emit({ dataPrecision: next });
                  }}
                />

                <Field label="Rounding">
                  <SwitchButtonGroup
                    value={dataPrecision === null ? 'full' : 'fixed'}
                    onChange={({ value }: { value: string | null }) => {
                      const next = value === 'full' ? null : 2;
                      setDataPrecision(next);
                      emit({ dataPrecision: next });
                    }}
                  >
                    <SwitchButtonBase type="Text" value="fixed" label="Fixed" />
                    <SwitchButtonBase type="Text" value="full"  label="Full" />
                  </SwitchButtonGroup>
                </Field>

                <Field label="Timestamps">
                  <SwitchButtonGroup
                    value={timeDisplay}
                    onChange={({ value }: { value: string | null }) => {
                      const next = (value ?? 'local') as TimeDisplayMode;
                      setTimeDisplay(next);
                      emit({ timeDisplay: next });
                    }}
                  >
                    <SwitchButtonBase type="Text" value="local" label="Local" />
                    <SwitchButtonBase type="Text" value="utc"   label="UTC" />
                  </SwitchButtonGroup>
                </Field>

              </div>
            </ProductAccordionItem>

            <ProductAccordionItem
              title="Cell Bindings"
              isActive
              isExpanded={openSection === 'data.bindings'}
              onToggle={() => toggleSection('data.bindings')}
              headerAction={
                <IconAction
                  icon={<Plus size={16} />}
                  label="Add Cell Binding"
                  size="16"
                  onClick={() => addBindingAndEdit()}
                />
              }
            >
              <div className="wt-section">

                {cellBindings.map((binding, idx) => (
                  <ListCard
                    key={idx}
                    className="wt-tile"
                    title={binding.cellId ? cellIdToRef(binding.cellId) : `Binding ${idx + 1}`}
                    subtitle={topicLeaf(binding.topic)}
                    onClick={() => openDetail({ kind: 'binding', index: idx })}
                    trailingItems={
                      <ListCardTrailingItem
                        trailing="Icon"
                        icon={
                          <IconAction
                            icon={<Trash2 size={13} />}
                            label="Delete Binding"
                            onClick={() => removeBinding(idx)}
                          />
                        }
                      />
                    }
                  />
                ))}

                {cellBindings.length === 0 && (
                  <EmptyHint>No cell bindings. Click + to add one.</EmptyHint>
                )}

              </div>
            </ProductAccordionItem>

            <ProductAccordionItem
              title="Series Population"
              isActive
              isExpanded={openSection === 'data.series'}
              onToggle={() => toggleSection('data.series')}
              headerAction={
                <IconAction
                  icon={<Plus size={16} />}
                  label="Add Series Binding"
                  size="16"
                  onClick={() => addSeriesAndEdit()}
                />
              }
            >
              <div className="wt-section">

                {seriesBindings.map((series, idx) => (
                  <ListCard
                    key={series.id}
                    className="wt-tile"
                    title={series.baseCellId ? cellIdToRef(series.baseCellId) : `Series ${idx + 1}`}
                    subtitle={`${series.direction === 'vertical' ? 'Vertical' : 'Horizontal'} \u2022 ${topicLeaf(series.topic)}`}
                    leadingItem={
                      <ListCardLeadingItem
                        leading="Icon"
                        icon={series.direction === 'vertical' ? <ArrowDown size={16} /> : <ArrowRight size={16} />}
                      />
                    }
                    onClick={() => openDetail({ kind: 'series', index: idx })}
                    trailingItems={
                      <ListCardTrailingItem
                        trailing="Icon"
                        icon={
                          <IconAction
                            icon={<Trash2 size={13} />}
                            label="Delete Series"
                            onClick={() => removeSeries(idx)}
                          />
                        }
                      />
                    }
                  />
                ))}

                {seriesBindings.length === 0 && (
                  <EmptyHint>No series. Click + to fill a run of cells from one topic.</EmptyHint>
                )}

              </div>
            </ProductAccordionItem>

          </div>
        </div>

      ) : activeTab === 'style' ? (

        <div className="wt-config__body">
          <div className="wt-config__sections">

            <ProductAccordionItem
              title="Table"
              isActive
              isExpanded={openSection === 'style.table'}
              onToggle={() => toggleSection('style.table')}
            >
              <div className="wt-section">

                <Field label="Grid lines">
                  <SwitchButtonGroup
                    value={tableBorderStyle}
                    onChange={({ value }: { value: string | null }) => {
                      const next = (value ?? 'all') as TableBorderStyle;
                      setTableBorderStyle(next);
                      emit({ tableBorderStyle: next });
                    }}
                  >
                    <SwitchButtonBase type="Icon" value="none"    icon={<Square size={16} />}  accessibilityLabel="No grid lines"   title="No grid lines" />
                    <SwitchButtonBase type="Icon" value="rows"    icon={<Menu size={16} />}    accessibilityLabel="Row lines only"  title="Row lines only" />
                    <SwitchButtonBase type="Icon" value="columns" icon={<Columns size={16} />} accessibilityLabel="Column lines only" title="Column lines only" />
                    <SwitchButtonBase type="Icon" value="all"     icon={<Grid size={16} />}    accessibilityLabel="All grid lines"  title="All grid lines" />
                  </SwitchButtonGroup>
                </Field>

                <ColorInput
                  label="Background"
                  value={cardStyle.bg || '#ffffff'}
                  onChange={(c: string) => updateCardStyle({ bg: c })}
                />

                <ToggleRow
                  label="Show search"
                  checked={showSearch}
                  onChange={(next) => { setShowSearch(next); emit({ showSearch: next }); }}
                />

                <ToggleRow
                  label="Allow CSV download"
                  checked={showExportButton}
                  onChange={(next) => { setShowExportButton(next); emit({ showExportButton: next }); }}
                />

                <ToggleRow
                  label="Wrap in card"
                  checked={cardStyle.wrapInCard}
                  onChange={(next) => updateCardStyle({ wrapInCard: next })}
                />

                {cardStyle.wrapInCard && (
                  <>
                    <ColorInput
                      label="Border color"
                      value={cardStyle.borderColor || '#e0e0e0'}
                      onChange={(c: string) => updateCardStyle({ borderColor: c })}
                    />

                    <Field label="Border width">
                      <SwitchButtonGroup
                        value={String(cardStyle.borderWidth)}
                        onChange={({ value }: { value: string | null }) =>
                          updateCardStyle({ borderWidth: Number(value ?? 1) })
                        }
                      >
                        <SwitchButtonBase type="Text" value="1" label="1px" />
                        <SwitchButtonBase type="Text" value="2" label="2px" />
                        <SwitchButtonBase type="Text" value="3" label="3px" />
                      </SwitchButtonGroup>
                    </Field>

                    <div className="wt-config__row">
                      <NumberField
                        label="Radius"
                        value={cardStyle.borderRadius}
                        min={0}
                        max={32}
                        step={1}
                        onChange={(value) =>
                          updateCardStyle({ borderRadius: value ?? 0 })
                        }
                      />
                      <NumberField
                        label="Padding"
                        value={cardStyle.padding}
                        min={0}
                        max={64}
                        step={4}
                        onChange={(value) =>
                          updateCardStyle({ padding: value ?? 0 })
                        }
                      />
                    </div>
                  </>
                )}

              </div>
            </ProductAccordionItem>

            <ProductAccordionItem
              title="Title"
              isActive
              isExpanded={openSection === 'style.title'}
              onToggle={() => toggleSection('style.title')}
            >
              <div className="wt-section">

                <ColorInput
                  label="Color"
                  value={titleStyle.color || '#1a1a1a'}
                  onChange={(c: string) => updateTitleStyle({ color: c })}
                />

                <NumberField
                  label="Font size"
                  value={titleStyle.fontSize}
                  min={10}
                  max={48}
                  step={1}
                  onChange={(value) =>
                    updateTitleStyle({ fontSize: value ?? 16 })
                  }
                />

                <Field label="Alignment">
                  <SwitchButtonGroup
                    value={titleStyle.align}
                    onChange={({ value }: { value: string | null }) =>
                      updateTitleStyle({ align: (value ?? 'left') as TitleAlign })
                    }
                  >
                    <SwitchButtonBase type="Icon" value="left"   icon={<AlignLeft size={16} />}   accessibilityLabel="Align left"   title="Align left" />
                    <SwitchButtonBase type="Icon" value="center" icon={<AlignCenter size={16} />} accessibilityLabel="Align center" title="Align center" />
                    <SwitchButtonBase type="Icon" value="right"  icon={<AlignRight size={16} />}  accessibilityLabel="Align right"  title="Align right" />
                  </SwitchButtonGroup>
                </Field>

                <SelectInput
                  label="Weight"
                  value={TITLE_WEIGHT_LABELS[titleStyle.fontWeight]}
                  isOpen={isWeightOpen}
                  onClick={() => setIsWeightOpen((v) => !v)}
                >
                  {isWeightOpen && (
                    <DropdownMenu>
                      {(Object.keys(TITLE_WEIGHT_LABELS) as TitleFontWeight[]).map((w) => (
                        <ActionListItem
                          key={w}
                          title={TITLE_WEIGHT_LABELS[w]}
                          isSelected={titleStyle.fontWeight === w}
                          onClick={() => { updateTitleStyle({ fontWeight: w }); setIsWeightOpen(false); }}
                        />
                      ))}
                    </DropdownMenu>
                  )}
                </SelectInput>

              </div>
            </ProductAccordionItem>

            <ProductAccordionItem
              title="Conditional Formatting"
              isActive
              isExpanded={openSection === 'style.conditional'}
              onToggle={() => toggleSection('style.conditional')}
              headerAction={
                <IconAction
                  icon={<Plus size={16} />}
                  label="Add Formatting Rule"
                  size="16"
                  onClick={() => addRuleAndEdit()}
                />
              }
            >
              <div className="wt-section">

                {conditionalRules.map((rule, idx) => (
                  <ListCard
                    key={rule.id}
                    className={`wt-tile${rule.enabled ? '' : ' wt-tile--muted'}`}
                    title={describeRule(rule)}
                    leadingItem={
                      <ListCardLeadingItem
                        leading="Color"
                        color={rule.format.cellColor || 'transparent'}
                      />
                    }
                    onClick={() => openDetail({ kind: 'rule', id: rule.id })}
                    trailingItems={
                      <>
                        <ListCardTrailingItem
                          trailing="Icon"
                          icon={
                            <IconAction
                              icon={<ChevronUp size={12} />}
                              label="Move Rule Up"
                              isDisabled={idx === 0}
                              onClick={() => moveRule(rule.id, 'up')}
                            />
                          }
                        />
                        <ListCardTrailingItem
                          trailing="Icon"
                          icon={
                            <IconAction
                              icon={<ChevronDown size={12} />}
                              label="Move Rule Down"
                              isDisabled={idx === conditionalRules.length - 1}
                              onClick={() => moveRule(rule.id, 'down')}
                            />
                          }
                        />
                        <ListCardTrailingItem
                          trailing="Icon"
                          icon={
                            <IconAction
                              icon={<Trash2 size={13} />}
                              label="Delete Rule"
                              onClick={() => removeRule(rule.id)}
                            />
                          }
                        />
                      </>
                    }
                  />
                ))}

                {conditionalRules.length === 0 && (
                  <EmptyHint>No formatting rules. Click + to colour cells by value.</EmptyHint>
                )}

              </div>
            </ProductAccordionItem>

          </div>
        </div>

      ) : (

        <div className="wt-config__body">
          <div className="wt-config__sections">

            <ProductAccordionItem
              title="Row Filter"
              isActive
              isExpanded={openSection === 'filter.rowfilter'}
              onToggle={() => toggleSection('filter.rowfilter')}
            >
              <div className="wt-section">

                <TextInput
                  label="Column range"
                  placeholder="e.g. A2:A10"
                  value={rowFilterRangeInput}
                  errorText={rowFilterRangeError || undefined}
                  validationState={rowFilterRangeError ? 'error' : undefined}
                  onChange={({ value }: { name: string; value: string }) => updateRowFilterRange(value)}
                />

                <Field label="Filter type">
                  <SwitchButtonGroup
                    value={rowFilter.filterType}
                    onChange={({ value }: { value: string | null }) =>
                      updateRowFilter({ filterType: (value ?? 'chips') as RowFilterType })
                    }
                  >
                    <SwitchButtonBase type="Text" value="chips"    label="Chips" />
                    <SwitchButtonBase type="Text" value="dropdown" label="List" />
                  </SwitchButtonGroup>
                </Field>

                <ToggleRow
                  label="Show instance count"
                  checked={rowFilter.enableCount}
                  onChange={(next) => updateRowFilter({ enableCount: next })}
                />

                <ToggleRow
                  label="Hide non-matching rows"
                  checked={rowFilter.hideNonMatching}
                  onChange={(next) => updateRowFilter({ hideNonMatching: next })}
                />

                <ToggleRow
                  label="Highlight matching rows"
                  checked={rowFilter.enableColor}
                  onChange={(next) => updateRowFilter({ enableColor: next })}
                />

              </div>
            </ProductAccordionItem>

            <ProductAccordionItem
              title="Filters"
              isActive
              isExpanded={openSection === 'filter.filters'}
              onToggle={() => toggleSection('filter.filters')}
              headerAction={
                <IconAction
                  icon={<Plus size={16} />}
                  label="Add Filter"
                  size="16"
                  onClick={(e: React.MouseEvent) => openDetail({ kind: 'filter', id: null }, e)}
                />
              }
            >
              <div className="wt-section">

                {rowFilter.filters.map((filter, idx) => {
                  const Icon = ROW_FILTER_ICONS[filter.icon];
                  return (
                    <ListCard
                      key={filter.id}
                      className="wt-tile"
                      title={filter.name || `Filter ${idx + 1}`}
                      leadingItem={
                        <ListCardLeadingItem
                          leading="Icon"
                          icon={Icon ? <Icon size={16} color={filter.color} /> : undefined}
                        />
                      }
                      onClick={() => openDetail({ kind: 'filter', id: filter.id })}
                      trailingItems={
                        <>
                          <ListCardTrailingItem
                            trailing="Icon"
                            icon={
                              <IconAction
                                icon={<ChevronUp size={12} />}
                                label="Move Filter Up"
                                isDisabled={idx === 0}
                                onClick={() => moveFilter(filter.id, 'up')}
                              />
                            }
                          />
                          <ListCardTrailingItem
                            trailing="Icon"
                            icon={
                              <IconAction
                                icon={<ChevronDown size={12} />}
                                label="Move Filter Down"
                                isDisabled={idx === rowFilter.filters.length - 1}
                                onClick={() => moveFilter(filter.id, 'down')}
                              />
                            }
                          />
                          <ListCardTrailingItem
                            trailing="Icon"
                            icon={
                              <IconAction
                                icon={<Trash2 size={13} />}
                                label="Delete Filter"
                                onClick={() => removeFilter(filter.id)}
                              />
                            }
                          />
                        </>
                      }
                    />
                  );
                })}

                {rowFilter.filters.length === 0 && (
                  <EmptyHint>No filters. Click + to add one.</EmptyHint>
                )}

              </div>
            </ProductAccordionItem>

          </div>
        </div>
      )}

      {/* ── Second panel: nested editors (Configurator Overlay Pattern) ── */}
      {detail && (
        <Modal
          isOpen
          positionX={detailX}
          positionY={detailY}
          className="wt-detail-modal"
          onClose={closeDetail}
          header={<ModalHeader title={detailTitle} onClose={closeDetail} />}
          footer={
            detail.kind === 'filter' ? (
              <ModalFooter
                primaryAction={
                  <Button
                    variant="Primary"
                    size="Small"
                    label={detail.id ? 'Save Filter' : 'Add Filter'}
                    onClick={submitFilterDetail}
                  />
                }
              />
            ) : (
              <ModalFooter
                primaryAction={<Button variant="Primary" size="Small" label="Done" onClick={closeDetail} />}
              />
            )
          }
        >
          <ModalBody>
            <div className="wt-detail__body">

              {detail.kind === 'binding' && editingBinding && (
                <>
                  <TextInput
                    label="Cell"
                    placeholder="e.g. A1"
                    value={cellRefInputs[detail.index] ?? (editingBinding.cellId ? cellIdToRef(editingBinding.cellId) : '')}
                    onChange={({ value }: { name: string; value: string }) => {
                      const index = detail.index;
                      setCellRefInputs((prev) => ({ ...prev, [index]: value }));
                      try {
                        updateBinding(index, { cellId: refToCellId(value) });
                      } catch { /* invalid ref — wait for more input */ }
                    }}
                  />
                  <UNSTreePicker
                    label="UNS Topic"
                    placeholder="Select a topic…"
                    value={editingBinding.topic}
                    workspaces={unsWorkspaces}
                    isLoadingWorkspaces={isLoadingWs}
                    loadChildren={loadChildren}
                    searchNodes={searchNodes}
                    onOpen={loadWorkspaces}
                    onChange={(value) => updateBinding(detail.index, { topic: value })}
                  />
                </>
              )}

              {detail.kind === 'series' && editingSeries && (
                <>
                  <TextInput
                    label="Base cell"
                    placeholder="e.g. A1"
                    value={seriesRefInputs[detail.index] ?? (editingSeries.baseCellId ? cellIdToRef(editingSeries.baseCellId) : '')}
                    onChange={({ value }: { name: string; value: string }) => {
                      const index = detail.index;
                      setSeriesRefInputs((prev) => ({ ...prev, [index]: value }));
                      try {
                        updateSeries(index, { baseCellId: refToCellId(value) });
                      } catch { /* invalid ref — wait for more input */ }
                    }}
                  />
                  <UNSTreePicker
                    label="Array topic"
                    placeholder="Select a topic…"
                    value={editingSeries.topic}
                    workspaces={unsWorkspaces}
                    isLoadingWorkspaces={isLoadingWs}
                    loadChildren={loadChildren}
                    searchNodes={searchNodes}
                    onOpen={loadWorkspaces}
                    onChange={(value) => updateSeries(detail.index, { topic: value })}
                  />
                  <Field label="Direction">
                    <SwitchButtonGroup
                      value={editingSeries.direction}
                      onChange={({ value }: { value: string | null }) =>
                        updateSeries(detail.index, { direction: (value ?? 'vertical') as SeriesDirection })
                      }
                    >
                      <SwitchButtonBase type="Text" value="vertical"   label="Down" />
                      <SwitchButtonBase type="Text" value="horizontal" label="Across" />
                    </SwitchButtonGroup>
                  </Field>
                  <NumberField
                    label="Max cells (0 = all)"
                    value={editingSeries.limit}
                    min={0}
                    max={1000}
                    step={1}
                    onChange={(value) =>
                      updateSeries(detail.index, { limit: value ?? 0 })
                    }
                  />
                  <p className="wt-detail__note">{describeSeriesSpan(editingSeries, rows, columns)}</p>
                </>
              )}

              {detail.kind === 'rule' && editingRule && (
                <>
                  <Checkbox
                    label="Rule enabled"
                    checked={editingRule.enabled}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      updateRule(editingRule.id, { enabled: e.target.checked })
                    }
                  />

                  <TextInput
                    label="Range"
                    placeholder="All cells"
                    value={rangeInputs[editingRule.id] ?? rangeToString(editingRule.range)}
                    errorText={ruleRangeErrors[editingRule.id] || undefined}
                    validationState={ruleRangeErrors[editingRule.id] ? 'error' : undefined}
                    onChange={({ value }: { name: string; value: string }) => {
                      const id = editingRule.id;
                      setRangeInputs((prev) => ({ ...prev, [id]: value }));
                      // Commit only empty (= all cells) or a valid range — an
                      // in-progress string must never silently become
                      // range:null and apply the rule everywhere.
                      if (value.trim() === '') {
                        setRuleRangeErrors((prev) => ({ ...prev, [id]: '' }));
                        updateRuleDebounced(id, { range: null });
                        return;
                      }
                      const parsed = parseRangeString(value);
                      if (!parsed) {
                        setRuleRangeErrors((prev) => ({ ...prev, [id]: 'Invalid range — e.g. A1 or B2:D5' }));
                        return;
                      }
                      setRuleRangeErrors((prev) => ({ ...prev, [id]: '' }));
                      updateRuleDebounced(id, { range: parsed });
                    }}
                  />

                  <SelectInput
                    label="Condition"
                    value={CONDITION_LABELS[editingRule.condition]}
                    isOpen={openConditionRuleId === editingRule.id}
                    onClick={() => setOpenConditionRuleId((id) => (id === editingRule.id ? null : editingRule.id))}
                  >
                    {openConditionRuleId === editingRule.id && (
                      <DropdownMenu>
                        {(Object.keys(CONDITION_LABELS) as ConditionalRuleCondition[]).map((c) => (
                          <ActionListItem
                            key={c}
                            title={CONDITION_LABELS[c]}
                            isSelected={editingRule.condition === c}
                            onClick={() => {
                              updateRule(editingRule.id, { condition: c });
                              setOpenConditionRuleId(null);
                            }}
                          />
                        ))}
                      </DropdownMenu>
                    )}
                  </SelectInput>

                  {NEEDS_VALUE1.includes(editingRule.condition) && (
                    <div className="wt-config__row">
                      <TextInput
                        label={editingRule.condition === 'between' ? 'Min' : 'Value'}
                        placeholder="0"
                        value={editingRule.value1}
                        onChange={({ value }: { name: string; value: string }) =>
                          updateRuleDebounced(editingRule.id, { value1: value })
                        }
                      />
                      {editingRule.condition === 'between' && (
                        <TextInput
                          label="Max"
                          placeholder="100"
                          value={editingRule.value2}
                          onChange={({ value }: { name: string; value: string }) =>
                            updateRuleDebounced(editingRule.id, { value2: value })
                          }
                        />
                      )}
                    </div>
                  )}

                  <Field label="Format">
                    <div className="wt-detail__format">
                      <Tooltip bodyText="Bold matching cells" placement="Top">
                        <Button
                          iconOnly
                          aria-label="Bold matching cells"
                          leadingIcon={<Bold size={13} />}
                          variant={editingRule.format.bold ? 'Primary' : 'Gray'}
                          size="Small"
                          onClick={() => updateRule(editingRule.id, { format: { ...editingRule.format, bold: !editingRule.format.bold } })}
                        />
                      </Tooltip>
                      <Tooltip bodyText="Italicise matching cells" placement="Top">
                        <Button
                          iconOnly
                          aria-label="Italicise matching cells"
                          leadingIcon={<Italic size={13} />}
                          variant={editingRule.format.italic ? 'Primary' : 'Gray'}
                          size="Small"
                          onClick={() => updateRule(editingRule.id, { format: { ...editingRule.format, italic: !editingRule.format.italic } })}
                        />
                      </Tooltip>
                    </div>
                  </Field>

                  <ColorInput
                    label="Fill"
                    value={editingRule.format.cellColor || '#ffffff'}
                    onChange={(color: string) =>
                      updateRule(editingRule.id, { format: { ...editingRule.format, cellColor: color } })
                    }
                  />

                  <ColorInput
                    label="Text"
                    value={editingRule.format.textColor || '#1a1a1a'}
                    onChange={(color: string) =>
                      updateRule(editingRule.id, { format: { ...editingRule.format, textColor: color } })
                    }
                  />
                </>
              )}

              {detail.kind === 'filter' && (
                <>
                  <TextInput
                    label="Name"
                    placeholder="e.g. Fail"
                    value={filterNameInput}
                    errorText={filterNameError || undefined}
                    validationState={filterNameError ? 'error' : undefined}
                    onChange={({ value }: { name: string; value: string }) => {
                      setFilterNameInput(value);
                      setFilterNameError('');
                    }}
                  />

                  <ColorInput
                    label="Color"
                    value={filterColorInput}
                    onChange={(color: string) => setFilterColorInput(color)}
                  />

                  <Field label="Icon">
                    <div className="wt-icon-grid">
                      {ROW_FILTER_ICON_NAMES.map((name) => {
                        const Icon = ROW_FILTER_ICONS[name];
                        return (
                          <Tooltip key={name} bodyText={name} placement="Top">
                            <button
                              type="button"
                              className={`wt-icon-grid__btn${filterIconInput === name ? ' wt-icon-grid__btn--active' : ''}`}
                              aria-label={name}
                              onClick={() => setFilterIconInput(name)}
                            >
                              <Icon size={14} />
                            </button>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </Field>
                </>
              )}

            </div>
          </ModalBody>
        </Modal>
      )}
    </div>
  );
}
