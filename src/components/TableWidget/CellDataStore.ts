import { CellData, CellFormat, CellBorderSide, PersistedCell } from '../../iosense-sdk/types';

export type CellId = string; // "R{row}C{col}"
type Listener = (cellId: CellId, data: CellData) => void;

const DEFAULT_BORDER_SIDE: CellBorderSide = {
  enabled: false,
  color: '#cccccc',
  style: 'solid',
  width: 1,
};

export const DEFAULT_CELL_FORMAT: CellFormat = {
  bold: false,
  italic: false,
  underline: false,
  fontSize: 13,
  textAlign: 'left',
  numberFormat: 'general',
  textColor: '',
  cellColor: '',
  borders: {
    top:    { ...DEFAULT_BORDER_SIDE },
    right:  { ...DEFAULT_BORDER_SIDE },
    bottom: { ...DEFAULT_BORDER_SIDE },
    left:   { ...DEFAULT_BORDER_SIDE },
  },
  link: '',
  decimals: null,
};

// Structural default-format check for the persistence layer. Field-wise (never
// JSON.stringify) so key order — which differs between formats built here and
// formats round-tripped through a host's serializer — can't produce false
// "customized" verdicts that bloat uiConfig.cells.
export function isDefaultFormat(fmt: CellFormat): boolean {
  const d = DEFAULT_CELL_FORMAT;
  const sameSide = (a: CellBorderSide, b: CellBorderSide) =>
    a.enabled === b.enabled && a.color === b.color && a.style === b.style && a.width === b.width;
  return (
    fmt.bold === d.bold &&
    fmt.italic === d.italic &&
    fmt.underline === d.underline &&
    fmt.fontSize === d.fontSize &&
    fmt.textAlign === d.textAlign &&
    fmt.numberFormat === d.numberFormat &&
    fmt.textColor === d.textColor &&
    fmt.cellColor === d.cellColor &&
    (fmt.link ?? '') === d.link &&
    (fmt.decimals ?? null) === d.decimals &&
    sameSide(fmt.borders.top, d.borders.top) &&
    sameSide(fmt.borders.right, d.borders.right) &&
    sameSide(fmt.borders.bottom, d.borders.bottom) &&
    sameSide(fmt.borders.left, d.borders.left)
  );
}

export function makeDefaultFormat(): CellFormat {
  return {
    ...DEFAULT_CELL_FORMAT,
    borders: {
      top:    { ...DEFAULT_BORDER_SIDE },
      right:  { ...DEFAULT_BORDER_SIDE },
      bottom: { ...DEFAULT_BORDER_SIDE },
      left:   { ...DEFAULT_BORDER_SIDE },
    },
  };
}

// Deep-merge a persisted format (possibly from an older envelope missing newer
// keys such as `link`) over the defaults so every key the renderer reads exists.
function withFormatDefaults(format: CellFormat): CellFormat {
  const base = makeDefaultFormat();
  return {
    ...base,
    ...format,
    borders: {
      top:    { ...base.borders.top,    ...(format.borders?.top    ?? {}) },
      right:  { ...base.borders.right,  ...(format.borders?.right  ?? {}) },
      bottom: { ...base.borders.bottom, ...(format.borders?.bottom ?? {}) },
      left:   { ...base.borders.left,   ...(format.borders?.left   ?? {}) },
    },
  };
}

export class CellDataStore {
  private cells = new Map<CellId, CellData>();
  private listeners = new Set<Listener>();
  // Bumped on every mutation — lets the formula engine's computed-value memo
  // know when its cache is stale without subscribing.
  private version = 0;

  getVersion(): number { return this.version; }

  getCell(cellId: CellId): CellData {
    return this.cells.get(cellId) ?? { value: '', format: makeDefaultFormat() };
  }

  /** Snapshot of every cell currently holding data — used to serialize the
   *  store back into uiConfig.cells for persistence. */
  entries(): Array<[CellId, CellData]> {
    return [...this.cells];
  }

  /** Replace the store's contents with persisted uiConfig.cells (mount /
   *  external config change). A full replace — not a merge — so cells cleared
   *  or removed in an external edit actually disappear; the widget re-injects
   *  live data-prop values afterwards (its data effect re-runs on hydration).
   *  One notifyAll at the end. */
  hydrate(cells: Record<string, PersistedCell>): void {
    this.version++;
    this.cells.clear();
    for (const [id, persisted] of Object.entries(cells)) {
      this.cells.set(id, {
        value: persisted.value ?? '',
        format: persisted.format ? withFormatDefaults(persisted.format) : makeDefaultFormat(),
      });
    }
    this.notifyAll();
  }

  getValue(cellId: CellId): string { return this.getCell(cellId).value; }
  getFormat(cellId: CellId): CellFormat { return this.getCell(cellId).format; }

  setValue(cellId: CellId, value: string): void {
    this.version++;
    const next: CellData = { ...this.getCell(cellId), value };
    this.cells.set(cellId, next);
    this.listeners.forEach((fn) => fn(cellId, next));
  }

  setValues(entries: Array<{ cellId: CellId; value: string }>): void {
    this.version++;
    for (const { cellId, value } of entries) {
      this.cells.set(cellId, { ...this.getCell(cellId), value });
    }
    this.notifyAll();
  }

  setFormat(cellId: CellId, format: CellFormat): void {
    this.version++;
    const next: CellData = { ...this.getCell(cellId), format };
    this.cells.set(cellId, next);
    this.listeners.forEach((fn) => fn(cellId, next));
  }

  private notifyAll(): void {
    this.listeners.forEach((fn) => fn('' as CellId, this.getCell('' as CellId)));
  }

  insertRow(atRow: number): void {
    this.version++;
    const toMove: Array<[CellId, CellData]> = [];
    for (const [id, data] of this.cells) {
      const m = /^R(\d+)C(\d+)$/.exec(id);
      if (m && parseInt(m[1], 10) >= atRow) toMove.push([id, data]);
    }
    toMove.sort((a, b) =>
      parseInt(/^R(\d+)/.exec(b[0])![1], 10) - parseInt(/^R(\d+)/.exec(a[0])![1], 10),
    );
    for (const [id, data] of toMove) {
      const m = /^R(\d+)C(\d+)$/.exec(id)!;
      this.cells.delete(id as CellId);
      this.cells.set(`R${parseInt(m[1], 10) + 1}C${m[2]}` as CellId, data);
    }
    this.notifyAll();
  }

  deleteRow(atRow: number): void {
    this.version++;
    const toDelete: CellId[] = [];
    const toMove: Array<[CellId, CellData]> = [];
    for (const [id, data] of this.cells) {
      const m = /^R(\d+)C(\d+)$/.exec(id);
      if (!m) continue;
      const r = parseInt(m[1], 10);
      if (r === atRow) toDelete.push(id);
      else if (r > atRow) toMove.push([id, data]);
    }
    toDelete.forEach((id) => this.cells.delete(id));
    toMove.sort((a, b) =>
      parseInt(/^R(\d+)/.exec(a[0])![1], 10) - parseInt(/^R(\d+)/.exec(b[0])![1], 10),
    );
    for (const [id, data] of toMove) {
      const m = /^R(\d+)C(\d+)$/.exec(id)!;
      this.cells.delete(id as CellId);
      this.cells.set(`R${parseInt(m[1], 10) - 1}C${m[2]}` as CellId, data);
    }
    this.notifyAll();
  }

  insertCol(atCol: number): void {
    this.version++;
    const toMove: Array<[CellId, CellData]> = [];
    for (const [id, data] of this.cells) {
      const m = /^R(\d+)C(\d+)$/.exec(id);
      if (m && parseInt(m[2], 10) >= atCol) toMove.push([id, data]);
    }
    toMove.sort((a, b) =>
      parseInt(/C(\d+)$/.exec(b[0])![1], 10) - parseInt(/C(\d+)$/.exec(a[0])![1], 10),
    );
    for (const [id, data] of toMove) {
      const m = /^R(\d+)C(\d+)$/.exec(id)!;
      this.cells.delete(id as CellId);
      this.cells.set(`R${m[1]}C${parseInt(m[2], 10) + 1}` as CellId, data);
    }
    this.notifyAll();
  }

  deleteCol(atCol: number): void {
    this.version++;
    const toDelete: CellId[] = [];
    const toMove: Array<[CellId, CellData]> = [];
    for (const [id, data] of this.cells) {
      const m = /^R(\d+)C(\d+)$/.exec(id);
      if (!m) continue;
      const c = parseInt(m[2], 10);
      if (c === atCol) toDelete.push(id);
      else if (c > atCol) toMove.push([id, data]);
    }
    toDelete.forEach((id) => this.cells.delete(id));
    toMove.sort((a, b) =>
      parseInt(/C(\d+)$/.exec(a[0])![1], 10) - parseInt(/C(\d+)$/.exec(b[0])![1], 10),
    );
    for (const [id, data] of toMove) {
      const m = /^R(\d+)C(\d+)$/.exec(id)!;
      this.cells.delete(id as CellId);
      this.cells.set(`R${m[1]}C${parseInt(m[2], 10) - 1}` as CellId, data);
    }
    this.notifyAll();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
