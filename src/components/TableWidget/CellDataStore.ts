import { CellData, CellFormat, CellBorderSide } from '../../iosense-sdk/types';

export type CellId = string; // "R{row}C{col}"
type Listener = (cellId: CellId, data: CellData) => void;

const DEFAULT_BORDER_SIDE: CellBorderSide = {
  enabled: false,
  color: '#cccccc',
  style: 'solid',
  width: 1,
};

const DEFAULT_FORMAT: CellFormat = {
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
};

export class CellDataStore {
  private cells = new Map<CellId, CellData>();
  private listeners = new Set<Listener>();

  getCell(cellId: CellId): CellData {
    return this.cells.get(cellId) ?? {
      value: '',
      format: {
        ...DEFAULT_FORMAT,
        borders: {
          top:    { ...DEFAULT_BORDER_SIDE },
          right:  { ...DEFAULT_BORDER_SIDE },
          bottom: { ...DEFAULT_BORDER_SIDE },
          left:   { ...DEFAULT_BORDER_SIDE },
        },
      },
    };
  }

  getValue(cellId: CellId): string { return this.getCell(cellId).value; }
  getFormat(cellId: CellId): CellFormat { return this.getCell(cellId).format; }

  setValue(cellId: CellId, value: string): void {
    const next: CellData = { ...this.getCell(cellId), value };
    this.cells.set(cellId, next);
    this.listeners.forEach((fn) => fn(cellId, next));
  }

  setValues(entries: Array<{ cellId: CellId; value: string }>): void {
    for (const { cellId, value } of entries) {
      this.cells.set(cellId, { ...this.getCell(cellId), value });
    }
    this.notifyAll();
  }

  setFormat(cellId: CellId, format: CellFormat): void {
    const next: CellData = { ...this.getCell(cellId), format };
    this.cells.set(cellId, next);
    this.listeners.forEach((fn) => fn(cellId, next));
  }

  private notifyAll(): void {
    this.listeners.forEach((fn) => fn('' as CellId, this.getCell('' as CellId)));
  }

  insertRow(atRow: number): void {
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
