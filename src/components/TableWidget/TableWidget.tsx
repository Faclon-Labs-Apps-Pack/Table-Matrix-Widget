import { useRef, useEffect } from 'react';
import { Button } from '@faclon-labs/design-sdk';
import { Download } from 'react-feather';
import { DataEntry, WidgetEvent, TableWidgetUIConfig } from '../../iosense-sdk/types';
import { CellDataStore, CellId } from './CellDataStore';
import { VirtualGrid } from './VirtualGrid';
import './TableWidget.css';

interface TableWidgetProps {
  config: TableWidgetUIConfig;
  data: DataEntry[];
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

  // Inject UNS-resolved values into the store in one batch → single notifyAll → single render.
  useEffect(() => {
    console.log('[TableWidget] data received', data);
    if (!storeRef.current || data.length === 0) return;
    const entries = data
      .filter(({ key }) => /^R\d+C\d+$/.test(key))
      .map(({ key, value }) => ({ cellId: key as CellId, value: value != null ? String(value) : '' }));
    if (entries.length > 0) storeRef.current.setValues(entries);
  }, [data]);

  function handleExport() {
    onEvent({ type: 'FILTER_CHANGE', payload: { action: 'export' } });
  }

  const card = config.style?.card;
  const titleCfg = config.style?.title;
  const showExportButton = config.style?.showExportButton ?? true;
  const showHeader = config.title.trim() !== '';

  const cardInlineStyle: React.CSSProperties = {
    backgroundColor: card?.bg || undefined,
    ...(card?.wrapInCard ? {
      border: `${card.borderWidth ?? 1}px solid ${card.borderColor || '#e0e0e0'}`,
      borderRadius: card.borderRadius ?? 8,
      padding: card.padding ?? 16,
      boxSizing: 'border-box',
    } : {}),
  };

  const titleInlineStyle: React.CSSProperties = {
    color:      titleCfg?.color     || undefined,
    fontSize:   titleCfg?.fontSize  ? `${titleCfg.fontSize}px` : undefined,
    fontWeight: titleCfg?.fontWeight === 'bold'    ? 700
              : titleCfg?.fontWeight === 'medium'  ? 500
              : titleCfg?.fontWeight === 'regular' ? 400
              : undefined,
  };

  return (
    <div className="tw-widget" style={cardInlineStyle}>
      <div className="tw-topbar">
        {showHeader && (
          <h3 className="tw-title" style={titleInlineStyle}>{config.title}</h3>
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
          rows={config.rows}
          columns={config.columns}
          freezeRows={config.freezeRows}
          freezeColumns={config.freezeColumns}
          store={storeRef.current}
          conditionalRules={config.conditionalRules ?? []}
          locked={config.locked ?? false}
          tableBorderStyle={config.style?.tableBorderStyle ?? 'all'}
        />
      </div>
    </div>
  );
}
