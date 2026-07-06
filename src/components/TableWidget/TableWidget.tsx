import { useRef, useEffect, useMemo } from 'react';
import { Button } from '@faclon-labs/design-sdk';
import { Download } from 'react-feather';
import { DataEntry, DataValue, WidgetEvent } from '../../iosense-sdk/types';
import { PartialTableWidgetUIConfig, withTableWidgetDefaults } from '../../iosense-sdk/defaults';
import { CellDataStore, CellId } from './CellDataStore';
import { VirtualGrid } from './VirtualGrid';
import './TableWidget.css';

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
}

export function TableWidget({ config, data, onEvent }: TableWidgetProps) {
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

  function handleExport() {
    onEvent({ type: 'FILTER_CHANGE', payload: { action: 'export' } });
  }

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
        />
      </div>
    </div>
  );
}
