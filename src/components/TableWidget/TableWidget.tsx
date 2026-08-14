import { useRef, useEffect, useMemo, useState } from 'react';
import { Button, TextInput, CounterInput, Chip, Checkbox, Popover, PopoverBody } from '@faclon-labs/design-sdk';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@faclon-labs/design-sdk/Modal';
import { UNSPathInput } from '@faclon-labs/design-sdk/UNSPathInput';
import { Download, ArrowDown, ArrowRight, Trash2, Filter } from 'react-feather';
import { DataEntry, DataValue, WidgetEvent, SeriesDirection } from '../../iosense-sdk/types';
import { PartialTableWidgetUIConfig, withTableWidgetDefaults } from '../../iosense-sdk/defaults';
import type { UNSTree } from '../../iosense-sdk/useUNSTree';
import { CellDataStore, CellId } from './CellDataStore';
import { VirtualGrid } from './VirtualGrid';
import { computeBoundCells, seriesPreviewCells } from './bindingMap';
import { ROW_FILTER_ICONS, computeFilterInstances, computeRowFilterVisibility, hexToRgba } from './rowFilter';
import './TableWidget.css';

// A cell holds one binding kind at a time in the Cell Config popover.
type CellConfigKind = 'single' | 'series';
const SERIES_PREVIEW_FALLBACK = 5; // cells previewed when limit is 0 (fill-all)

// Render a resolved scalar to the cell's string value.
function scalarToString(value: unknown): string {
  return value != null ? String(value) : '';
}

// Coerce a resolved series value into an array. The resolveAndCompute API may
// return a real array, a JSON-encoded array string, or a comma-separated string.
function toArray(value: DataValue): Array<string | number | boolean | null> {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === '') return [];
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* fall through to CSV split */ }
    }
    return t.split(',').map((s) => s.trim());
  }
  if (value == null) return [];
  return [value];
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
  unsTree?: UNSTree;
  isLoadingTree?: boolean;
  onLoadWorkspaces?: () => void | Promise<void>;
  resolveUNSValue?: (raw: string) => string;
}

export function TableWidget({ config, data, onEvent, editable = false, unsTree, isLoadingTree, onLoadWorkspaces, resolveUNSValue }: TableWidgetProps) {
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

  // Inject every UNS-resolved binding into the store in ONE batch → a single
  // notifyAll → a single grid re-render, regardless of how many cells the data
  // touches. Single-cell bindings (key = "R{r}C{c}") write straight through;
  // series bindings (key = "series:R{r}C{c}") expand an array across cells from
  // the base cell in the configured direction. Keeping all writes in one
  // setValues call is what keeps INP well under 50 ms even for large series.
  useEffect(() => {
    console.log('[TableWidget] data received', data);
    const store = storeRef.current;
    if (!store || !data || data.length === 0) return;

    const batch: Array<{ cellId: CellId; value: string }> = [];

    for (const { key, value } of data) {
      if (/^R\d+C\d+$/.test(key)) {
        // Single-cell binding — DataEntry.key is already the target cellId.
        batch.push({ cellId: key as CellId, value: scalarToString(value) });
        continue;
      }
      if (key.startsWith('series:')) {
        const baseCellId = key.slice('series:'.length);
        const series = cfg.seriesBindings.find((s) => s.baseCellId === baseCellId);
        const m = /^R(\d+)C(\d+)$/.exec(baseCellId);
        if (!series || !m) continue;
        const r0 = parseInt(m[1], 10);
        const c0 = parseInt(m[2], 10);
        const arr = toArray(value);
        const count = series.limit > 0 ? Math.min(series.limit, arr.length) : arr.length;
        for (let i = 0; i < count; i++) {
          const cellId = (series.direction === 'horizontal'
            ? `R${r0}C${c0 + i}`
            : `R${r0 + i}C${c0}`) as CellId;
          batch.push({ cellId, value: scalarToString(arr[i]) });
        }
      }
    }

    if (batch.length > 0) store.setValues(batch);
  }, [data, cfg.seriesBindings]);

  // ── Row Filter ──────────────────────────────────────────────────────────────
  // Filter instances read already-resolved cell text straight out of the store,
  // so they must recompute on ANY cell change — live UNS pushes (above) and
  // manual edits alike — not just when the `data` prop changes.
  const [filterTick, setFilterTick] = useState(0);
  useEffect(() => storeRef.current!.subscribe(() => setFilterTick((t) => t + 1)), []);

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

  function handleExport() {
    onEvent({ type: 'FILTER_CHANGE', payload: { action: 'export' } });
  }

  // Cells carrying a binding — drives the corner indicator + topic tooltip so
  // operators can tell live-bound cells apart from static ones at runtime, and
  // locks them from manual typing (service-populated).
  const boundCells = useMemo(
    () => computeBoundCells(cfg.cellBindings, cfg.seriesBindings),
    [cfg.cellBindings, cfg.seriesBindings],
  );

  // ── On-canvas Cell Config popover ──────────────────────────────────────────
  const [configCellId, setConfigCellId] = useState<string | null>(null);
  const [configKind, setConfigKind] = useState<CellConfigKind>('single');
  const [modalX, setModalX] = useState(0);
  const [modalY, setModalY] = useState(0);

  const hasUNSBrowser = unsTree !== undefined && resolveUNSValue !== undefined;

  // The widget never mutates the envelope — it hands the updated uiConfig to the
  // host via onEvent, which rebuilds dynamicBindingPathList and persists.
  function emitConfig(cellBindings: typeof cfg.cellBindings, seriesBindings: typeof cfg.seriesBindings) {
    onEvent({ type: 'CONFIG_CHANGE', payload: { uiConfig: { ...cfg, cellBindings, seriesBindings } } });
  }

  function resolveTopic(raw: string): string {
    return resolveUNSValue ? resolveUNSValue(raw) : raw;
  }

  function upsertCellTopic(cellId: string, rawValue: string) {
    const topic = resolveTopic(rawValue);
    const nextSeries = cfg.seriesBindings.filter((s) => s.baseCellId !== cellId);
    const exists = cfg.cellBindings.some((b) => b.cellId === cellId);
    const nextCells = exists
      ? cfg.cellBindings.map((b) => (b.cellId === cellId ? { ...b, topic } : b))
      : [...cfg.cellBindings, { cellId, topic }];
    emitConfig(nextCells, nextSeries);
  }

  function upsertSeries(cellId: string, patch: Partial<{ topic: string; direction: SeriesDirection; limit: number }>) {
    const nextCells = cfg.cellBindings.filter((b) => b.cellId !== cellId);
    const existing = cfg.seriesBindings.find((s) => s.baseCellId === cellId);
    const cleaned = patch.topic !== undefined ? { ...patch, topic: resolveTopic(patch.topic) } : patch;
    const nextSeries = existing
      ? cfg.seriesBindings.map((s) => (s.baseCellId === cellId ? { ...s, ...cleaned } : s))
      : [
          ...cfg.seriesBindings,
          { id: `series_${Date.now()}`, baseCellId: cellId, topic: '', direction: 'vertical' as SeriesDirection, limit: 0, ...cleaned },
        ];
    emitConfig(nextCells, nextSeries);
  }

  function clearCellBinding(cellId: string) {
    emitConfig(
      cfg.cellBindings.filter((b) => b.cellId !== cellId),
      cfg.seriesBindings.filter((s) => s.baseCellId !== cellId),
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
    // Drop any binding left without a topic so the envelope stays clean.
    const nextCells = cfg.cellBindings.filter((b) => (b.topic ?? '').trim());
    const nextSeries = cfg.seriesBindings.filter((s) => (s.topic ?? '').trim());
    if (nextCells.length !== cfg.cellBindings.length || nextSeries.length !== cfg.seriesBindings.length) {
      emitConfig(nextCells, nextSeries);
    }
    setConfigCellId(null);
  }

  const activeCellTopic = configCellId
    ? cfg.cellBindings.find((b) => b.cellId === configCellId)?.topic ?? ''
    : '';
  const activeSeries = configCellId
    ? cfg.seriesBindings.find((s) => s.baseCellId === configCellId)
    : undefined;

  const previewCells = useMemo(() => {
    if (!configCellId || configKind !== 'series') return undefined;
    const dir = activeSeries?.direction ?? 'vertical';
    const count = activeSeries && activeSeries.limit > 0 ? activeSeries.limit : SERIES_PREVIEW_FALLBACK;
    return seriesPreviewCells(configCellId, dir, count, cfg.rows, cfg.columns);
  }, [configCellId, configKind, activeSeries, cfg.rows, cfg.columns]);

  const card = cfg.style.card;
  const titleCfg = cfg.style.title;
  const showExportButton = cfg.style.showExportButton;
  const showHeader = cfg.title.trim() !== '';

  const cardInlineStyle: React.CSSProperties = {
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
  };

  return (
    <div className="tw-widget" style={cardInlineStyle}>
      <div className="tw-topbar">
        {showHeader && (
          <h3 className="tw-title" style={titleInlineStyle}>{cfg.title}</h3>
        )}
        {showExportButton && (
          <div className="tw-topbar__actions">
            <Button
              iconOnly
              leadingIcon={<Download size={14} />}
              variant="Secondary"
              size="Small"
              onClick={handleExport}
            />
          </div>
        )}
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
                  size="Small"
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
          store={storeRef.current}
          conditionalRules={cfg.conditionalRules}
          locked={cfg.locked}
          tableBorderStyle={cfg.style.tableBorderStyle}
          boundCells={boundCells}
          previewCells={previewCells}
          onCellConfigure={editable && !cfg.locked ? openCellConfig : undefined}
          hiddenRows={filterVisibility.hiddenRows}
          rowColors={filterVisibility.rowColors}
        />
      </div>

      {/* ── Cell Config popover (double-click a cell when editable) ── */}
      {editable && configCellId && (
        <Modal
          {...({ transparent: true } as any)}
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
                  <UNSPathInput
                    label="UNS Topic"
                    placeholder="Type / to browse…"
                    value={activeCellTopic}
                    tree={unsTree}
                    isLoading={isLoadingTree}
                    onOpen={onLoadWorkspaces}
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
                    <UNSPathInput
                      label="Array topic"
                      placeholder="Type / to browse…"
                      value={activeSeries?.topic ?? ''}
                      tree={unsTree}
                      isLoading={isLoadingTree}
                      onOpen={onLoadWorkspaces}
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

// A1-style label for a cell id ("R0C0" → "A1").
function cellIdToRef(cellId: string): string {
  const m = /^R(\d+)C(\d+)$/.exec(cellId);
  if (!m) return '';
  const row = parseInt(m[1], 10);
  let c = parseInt(m[2], 10);
  let col26 = '';
  do {
    col26 = String.fromCharCode(65 + (c % 26)) + col26;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${col26}${row + 1}`;
}
