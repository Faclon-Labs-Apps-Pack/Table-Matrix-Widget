import { useState, useEffect } from 'react';
import { TextInput, CounterInput, Button, Popover, PopoverBody } from '@faclon-labs/design-sdk';
import { UNSPathInput } from '@faclon-labs/design-sdk/UNSPathInput';
import { ColorPicker } from '@faclon-labs/design-sdk';
import { Bold, Italic, ChevronUp, ChevronDown, X, Plus, Grid, Type } from 'react-feather';
import {
  TableWidgetEnvelope, TableWidgetUIConfig,
  ConditionalRule, ConditionalRuleCondition,
  TableWidgetCardStyle, TableWidgetTitleStyle, TableBorderStyle,
  CellBinding,
} from '../../iosense-sdk/types';
import { parseRangeString, refToCellId } from '../TableWidget/formulaEngine';
import './TableWidgetConfiguration.css';

interface TableWidgetConfigurationProps {
  config: TableWidgetEnvelope | undefined;
  authentication?: string;
  onChange: (config: TableWidgetEnvelope) => void;
}

const VARIABLE_REGEX = /^\{\{(.+)\}\}$/;

function buildDynamicBindingPathList(uiConfig: unknown): Array<{ key: string; topic: string }> {
  const paths: Array<{ key: string; topic: string }> = [];

  function walk(obj: unknown, currentPath: string): void {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'string') {
      const match = VARIABLE_REGEX.exec(obj.trim());
      if (match) paths.push({ key: currentPath, topic: match[1] });
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }
    if (typeof obj === 'object') {
      Object.entries(obj as Record<string, unknown>).forEach(([key, val]) => {
        walk(val, currentPath ? `${currentPath}.${key}` : key);
      });
    }
  }

  walk(uiConfig, '');
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

const DEFAULT_CARD: TableWidgetCardStyle = {
  wrapInCard: false,
  bg: '',
  borderColor: '#e0e0e0',
  borderWidth: 1,
  borderRadius: 8,
  padding: 16,
};

const DEFAULT_TITLE_STYLE: TableWidgetTitleStyle = {
  color: '',
  fontSize: 16,
  fontWeight: 'regular',
};

export function TableWidgetConfiguration({
  config,
  onChange,
}: TableWidgetConfigurationProps) {
  const [activeTab, setActiveTab] = useState<'general' | 'style'>('general');

  const [title, setTitle] = useState<string>(config?.uiConfig.title ?? '');
  const [rows, setRows] = useState<number>(config?.uiConfig.rows ?? 10);
  const [columns, setColumns] = useState<number>(config?.uiConfig.columns ?? 10);
  const [widgetWidth, setWidgetWidth] = useState<number>(config?.uiConfig.widgetWidth ?? 700);
  const [widgetHeight, setWidgetHeight] = useState<number>(config?.uiConfig.widgetHeight ?? 500);
  const [locked, setLocked] = useState<boolean>(config?.uiConfig.locked ?? false);
  const [conditionalRules, setConditionalRules] = useState<ConditionalRule[]>(
    config?.uiConfig.conditionalRules ?? []
  );
  const [cardStyle, setCardStyle] = useState<TableWidgetCardStyle>(
    config?.uiConfig.style?.card ?? DEFAULT_CARD
  );
  const [titleStyle, setTitleStyle] = useState<TableWidgetTitleStyle>(
    config?.uiConfig.style?.title ?? DEFAULT_TITLE_STYLE
  );
  const [tableBorderStyle, setTableBorderStyle] = useState<TableBorderStyle>(
    config?.uiConfig.style?.tableBorderStyle ?? 'all'
  );
  const [showExportButton, setShowExportButton] = useState<boolean>(
    config?.uiConfig.style?.showExportButton ?? true
  );
  const [cellBindings, setCellBindings] = useState<CellBinding[]>(
    config?.uiConfig.cellBindings ?? []
  );
  // Tracks the raw A1-style address the user is typing per binding row (display only)
  const [cellRefInputs, setCellRefInputs] = useState<Record<number, string>>({});

  // Range input strings (display only — not in envelope directly)
  const [rangeInputs, setRangeInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (config) {
      setTitle(config.uiConfig.title);
      setRows(config.uiConfig.rows);
      setColumns(config.uiConfig.columns);
      setWidgetWidth(config.uiConfig.widgetWidth ?? 700);
      setWidgetHeight(config.uiConfig.widgetHeight ?? 700);
      setLocked(config.uiConfig.locked ?? false);
      setConditionalRules(config.uiConfig.conditionalRules ?? []);
      setCardStyle(config.uiConfig.style?.card ?? DEFAULT_CARD);
      setTitleStyle(config.uiConfig.style?.title ?? DEFAULT_TITLE_STYLE);
      setTableBorderStyle(config.uiConfig.style?.tableBorderStyle ?? 'all');
      setShowExportButton(config.uiConfig.style?.showExportButton ?? true);
      setCellBindings(config.uiConfig.cellBindings ?? []);
      setCellRefInputs({});
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
      style: {
        card:             resolved.cardStyle,
        title:            resolved.titleStyle,
        tableBorderStyle: resolved.tableBorderStyle,
        showExportButton: resolved.showExportButton,
      },
    };

    const envelope = buildEnvelope(config, uiConfig, resolved.title);
    console.log('[TableWidgetConfiguration] envelope', envelope);
    onChange(envelope);
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

  return (
    <div className="wt-config">
      <div className="wt-config__header">
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
      </div>

      {activeTab === 'general' ? (

        <div className="wt-config__body">
          <TextInput
            label="Widget Title"
            placeholder="Enter title (leave empty to hide)"
            value={title}
            onChange={({ value }: { name: string; value: string }) => {
              setTitle(value);
              emit({ title: value });
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
                        updateRule(rule.id, { range: parseRangeString(value) });
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
                          updateRule(rule.id, { value1: value })
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
                            updateRule(rule.id, { value2: value })
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
                  placeholder="Select topic…"
                  value={binding.topic}
                  tree={{}}
                  onChange={(topic) => updateBinding(idx, { topic })}
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

        </div>

      ) : (

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
      )}
    </div>
  );
}
