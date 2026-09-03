import { NumberFormat, ConditionalRule, ConditionalRuleFormat, ConditionalRuleRange } from '../../iosense-sdk/types';
import { CellDataStore, CellId } from './CellDataStore';

// ── Number formatting ──────────────────────────────────────────────────────

// Whole-string numeric test. parseFloat alone is too permissive for display
// formatting: it turns "12 kWh" into 12 and "3 of 5" into 3, so rounding on a
// parseFloat result would silently rewrite text cells. Grouping commas are
// allowed because a previously-formatted value can be re-read here.
const NUMERIC_RE = /^-?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?([eE][+-]?\d+)?$/;

function toNumber(value: string): number | null {
  const t = value.trim();
  if (t === '' || !NUMERIC_RE.test(t)) return null;
  const n = parseFloat(t.replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

/** Render a raw cell value for display.
 *
 *  `decimals` is the effective precision — the cell's own `format.decimals`
 *  when set, otherwise the widget-level `dataPrecision`. `null` means "leave
 *  the number exactly as it resolved", which is what a topic returning
 *  37619474.13795926 needs when the operator wants every digit. */
export function applyNumberFormat(
  value: string,
  format: NumberFormat,
  decimals: number | null = null,
): string {
  const num = toNumber(value);
  // Non-numeric text (and formulas that produced an error string) is never
  // reformatted, whatever the column's number format says.
  if (num === null) return value;
  const d = decimals === null ? null : Math.max(0, Math.min(10, Math.round(decimals)));
  switch (format) {
    case 'general':
      return d === null ? value : num.toFixed(d);
    case 'number':
      return num.toLocaleString('en-US', {
        minimumFractionDigits: d ?? 2,
        maximumFractionDigits: d ?? 2,
      });
    case 'percent':
      return (num * 100).toFixed(d ?? 2) + '%';
    case 'currency':
      return num.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: d ?? 2,
        maximumFractionDigits: d ?? 2,
      });
    case 'integer':
      return Math.round(num).toLocaleString('en-US');
  }
}

// ── Conditional formatting ─────────────────────────────────────────────────

function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: parseInt(m[2], 10) - 1, col: col - 1 };
}

export function parseRangeString(rangeStr: string): ConditionalRuleRange | null {
  const s = rangeStr.trim();
  if (!s) return null;
  const parts = s.split(':');
  const start = parseRef(parts[0]);
  if (!start) return null;
  const end = parts[1] ? parseRef(parts[1]) : start;
  if (!end) return null;
  return {
    startRow: Math.min(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endRow:   Math.max(start.row, end.row),
    endCol:   Math.max(start.col, end.col),
  };
}

// Inverse of parseRangeString — renders a stored range back to A1 notation so
// configurator inputs can round-trip a persisted rule.
export function rangeToString(range: ConditionalRuleRange | null): string {
  if (!range) return '';
  const ref = (row: number, col: number) => {
    let letters = '';
    let n = col;
    while (n >= 0) {
      letters = String.fromCharCode(65 + (n % 26)) + letters;
      n = Math.floor(n / 26) - 1;
    }
    return `${letters}${row + 1}`;
  };
  const start = ref(range.startRow, range.startCol);
  const end = ref(range.endRow, range.endCol);
  return start === end ? start : `${start}:${end}`;
}

function matchesCondition(displayValue: string, rule: ConditionalRule): boolean {
  const { condition, value1, value2 } = rule;
  if (condition === 'isEmpty')    return displayValue.trim() === '';
  if (condition === 'isNotEmpty') return displayValue.trim() !== '';
  if (condition === 'contains')   return displayValue.includes(value1);
  const num  = parseFloat(displayValue);
  const thr1 = parseFloat(value1);
  if (isNaN(num) || isNaN(thr1)) {
    if (condition === 'equalTo')    return displayValue === value1;
    if (condition === 'notEqualTo') return displayValue !== value1;
    return false;
  }
  switch (condition) {
    case 'greaterThan':         return num > thr1;
    case 'lessThan':            return num < thr1;
    case 'greaterThanOrEqual':  return num >= thr1;
    case 'lessThanOrEqual':     return num <= thr1;
    case 'equalTo':             return num === thr1;
    case 'notEqualTo':          return num !== thr1;
    case 'between':             return num >= thr1 && num <= parseFloat(value2);
  }
}

export function evaluateConditionalRules(
  displayValue: string,
  rules: ConditionalRule[],
  row: number,
  col: number,
): ConditionalRuleFormat {
  let patch: ConditionalRuleFormat = {};
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.range !== null) {
      const { startRow, startCol, endRow, endCol } = rule.range;
      if (row < startRow || row > endRow || col < startCol || col > endCol) continue;
    }
    if (matchesCondition(displayValue, rule)) {
      patch = Object.assign({}, patch, rule.format);
    }
  }
  return patch;
}

// ── Formula display ────────────────────────────────────────────────────────

// Per-store memo of computed (formula-evaluated, UNformatted) values, keyed to
// the store's mutation version. Without it a chain like C2=C1+C1 copied down a
// column re-evaluates every upstream cell twice per reference — exponential in
// column length. Values cached under a cycle are path-independent because a
// cycle already degenerates to '0' everywhere.
const computedCache = new WeakMap<CellDataStore, { version: number; values: Map<CellId, string> }>();

/** Formula-evaluated raw value, before number formatting. This — not the
 *  formatted display string — is what numeric consumers (conditional rules)
 *  must compare against: "1,234.50" parses as 1 and "$…" as NaN. */
export function getComputedValue(cellId: CellId, store: CellDataStore): string {
  let cache = computedCache.get(store);
  if (!cache || cache.version !== store.getVersion()) {
    cache = { version: store.getVersion(), values: new Map() };
    computedCache.set(store, cache);
  }
  const hit = cache.values.get(cellId);
  if (hit !== undefined) return hit;
  const raw = store.getValue(cellId);
  const result = raw.startsWith('=')
    ? evalExpr(raw.slice(1), store, new Set([cellId]), cache.values)
    : raw;
  cache.values.set(cellId, result);
  return result;
}

/** Display string for a cell: formula evaluated, then number-formatted.
 *  `defaultDecimals` is the widget's `dataPrecision`; a cell's own
 *  `format.decimals` overrides it. */
export function getDisplayValue(
  cellId: CellId,
  store: CellDataStore,
  defaultDecimals: number | null = null,
): string {
  const fmt = store.getFormat(cellId);
  const decimals = fmt.decimals ?? defaultDecimals;
  return applyNumberFormat(getComputedValue(cellId, store), fmt.numberFormat, decimals);
}

// ── Internal: cell-ref resolution ─────────────────────────────────────────

// A1-style label for a cell id ("R0C0" → "A1") — the exported inverse of
// refToCellId, shared by the widget popover title and the configurator's
// binding rows so the two can never render different labels for one cell.
export function cellIdToRef(cellId: string): string {
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

export function refToCellId(ref: string): CellId {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) throw new Error(`bad ref: ${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  col -= 1;
  return `R${parseInt(m[2], 10) - 1}C${col}`;
}

// ── Formula evaluation ────────────────────────────────────────────────────
// Grammar (whitespace-insensitive, case-insensitive):
//
//   expr    := addsub
//   addsub  := muldiv (('+' | '-') muldiv)*
//   muldiv  := pow (('*' | '/') pow)*
//   pow     := unary (('^' | '**') pow)?          right-associative
//   unary   := ('-' | '+') unary | primary
//   primary := number | '(' expr ')' | call | ref
//   call    := NAME '(' (arg (',' arg)*)? ')'
//   arg     := ref ':' ref                        a range, only inside a call
//            | expr
//
// A range expands to the NUMERIC cells it covers — blanks and text are skipped,
// the way Excel's SUM/AVERAGE treat them — so =AVERAGE(A2:A25) over a series
// whose late buckets came back as no_data averages only the real readings.
// A bare cell reference used in arithmetic contributes 0 when it holds text.

/** Spreadsheet functions the engine understands, for the in-widget hint text. */
export const FORMULA_FUNCTIONS = [
  'SUM', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'AVERAGE',
  'MIN', 'MAX', 'COUNT', 'PRODUCT', 'ROUND', 'ABS', 'SQRT', 'POWER',
] as const;

class FormulaError extends Error {
  constructor(public code: string) { super(code); }
}

const DIV0 = () => { throw new FormulaError('#DIV/0!'); };

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  SUM:      (a) => a.reduce((x, y) => x + y, 0),
  ADD:      (a) => a.reduce((x, y) => x + y, 0),
  // Excel has no SUBTRACT/MULTIPLY/DIVIDE, but operators do — these are the
  // spelled-out forms operators asked for, following the Sheets convention of
  // left-folding the argument list.
  SUBTRACT: (a) => (a.length === 0 ? 0 : a.slice(1).reduce((x, y) => x - y, a[0])),
  MULTIPLY: (a) => a.reduce((x, y) => x * y, 1),
  PRODUCT:  (a) => a.reduce((x, y) => x * y, 1),
  DIVIDE:   (a) => (a.length === 0 ? 0 : a.slice(1).reduce((x, y) => (y === 0 ? DIV0() : x / y), a[0])),
  AVERAGE:  (a) => (a.length === 0 ? DIV0() : a.reduce((x, y) => x + y, 0) / a.length),
  AVG:      (a) => (a.length === 0 ? DIV0() : a.reduce((x, y) => x + y, 0) / a.length),
  MIN:      (a) => (a.length === 0 ? 0 : Math.min(...a)),
  MAX:      (a) => (a.length === 0 ? 0 : Math.max(...a)),
  COUNT:    (a) => a.length,
  ABS:      (a) => Math.abs(a[0] ?? 0),
  SQRT:     (a) => Math.sqrt(a[0] ?? 0),
  POWER:    (a) => Math.pow(a[0] ?? 0, a[1] ?? 0),
  ROUND:    (a) => {
    const d = Math.max(0, Math.min(10, Math.round(a[1] ?? 0)));
    const f = Math.pow(10, d);
    return Math.round((a[0] ?? 0) * f) / f;
  },
};

function evalExpr(
  expr: string,
  store: CellDataStore,
  visiting: Set<CellId>,
  cache?: Map<CellId, string>,
): string {
  // Raw (unevaluated) text of one cell, following formula chains. Cells already
  // on the evaluation path resolve to '' so a cycle degenerates to 0 instead of
  // recursing forever.
  function cellText(id: CellId): string {
    if (visiting.has(id)) return '';
    const hit = cache?.get(id);
    if (hit !== undefined) return hit;
    const raw = store.getValue(id);
    return raw.startsWith('=')
      ? evalExpr(raw.slice(1), store, new Set([...visiting, id]), cache)
      : raw;
  }

  function cellNumber(id: CellId): number {
    return toNumber(cellText(id)) ?? 0;
  }

  const src = expr.replace(/\s+/g, '').toUpperCase();
  let pos = 0;
  const peek = () => src[pos] ?? '';
  const consume = () => src[pos++];

  function parseExpr(): number { return parseAddSub(); }

  function parseAddSub(): number {
    let v = parseMulDiv();
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const rhs = parseMulDiv();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  function parseMulDiv(): number {
    let v = parsePow();
    while (peek() === '*' || peek() === '/') {
      // '**' binds tighter than * and / — it belongs to parsePow, which has
      // already consumed any exponent on its operands. Without this check
      // `2*3**2` grouped as (2*3)**2 = 36 instead of 2*(3**2) = 18.
      if (peek() === '*' && src[pos + 1] === '*') break;
      const op = consume();
      const rhs = parsePow();
      if (op === '/') {
        if (rhs === 0) DIV0();
        v = v / rhs;
      } else {
        v = v * rhs;
      }
    }
    return v;
  }

  // '^' and '**' — same precedence, right-associative (2**3**2 = 2**(3**2)).
  function parsePow(): number {
    const base = parseUnary();
    if (peek() === '^') { consume(); return Math.pow(base, parsePow()); }
    if (peek() === '*' && src[pos + 1] === '*') { consume(); consume(); return Math.pow(base, parsePow()); }
    return base;
  }

  function parseUnary(): number {
    if (peek() === '-') { consume(); return -parseUnary(); }
    if (peek() === '+') { consume(); return parseUnary(); }
    return parsePrimary();
  }

  // A1-style reference at the cursor, or null (cursor unmoved) when the text
  // here is a bare name — a function call, which the caller handles instead.
  function tryParseRef(): CellId | null {
    const start = pos;
    let letters = '';
    while (/[A-Z]/.test(peek())) letters += consume();
    let digits = '';
    while (/\d/.test(peek())) digits += consume();
    if (letters === '' || digits === '') { pos = start; return null; }
    return refToCellId(`${letters}${digits}`);
  }

  // Numeric cells covered by `a:b`, in row-major order. Non-numeric and empty
  // cells are omitted so COUNT/AVERAGE match spreadsheet semantics.
  function rangeValues(a: CellId, b: CellId): number[] {
    const ma = /^R(\d+)C(\d+)$/.exec(a)!;
    const mb = /^R(\d+)C(\d+)$/.exec(b)!;
    const r0 = Math.min(+ma[1], +mb[1]), r1 = Math.max(+ma[1], +mb[1]);
    const c0 = Math.min(+ma[2], +mb[2]), c1 = Math.max(+ma[2], +mb[2]);
    const out: number[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const n = toNumber(cellText(`R${r}C${c}`));
        if (n !== null) out.push(n);
      }
    }
    return out;
  }

  function parseArgs(): number[] {
    const out: number[] = [];
    if (peek() === ')') return out;
    for (;;) {
      const start = pos;
      const ref = tryParseRef();
      if (ref !== null && peek() === ':') {
        consume();
        const end = tryParseRef();
        if (end === null) throw new FormulaError('#INVALID');
        out.push(...rangeValues(ref, end));
      } else {
        pos = start;               // not a range — re-read the argument as an expression
        out.push(parseExpr());
      }
      if (peek() !== ',') break;
      consume();
    }
    return out;
  }

  function parsePrimary(): number {
    if (peek() === '(') {
      consume();
      const v = parseExpr();
      if (consume() !== ')') throw new FormulaError('#INVALID');
      return v;
    }

    if (/[A-Z]/.test(peek())) {
      const ref = tryParseRef();
      if (ref !== null) {
        // A range outside a function call has no scalar meaning.
        if (peek() === ':') throw new FormulaError('#INVALID');
        return cellNumber(ref);
      }
      let name = '';
      while (/[A-Z_]/.test(peek())) name += consume();
      if (consume() !== '(') throw new FormulaError('#NAME?');
      const fn = FUNCTIONS[name];
      const args = parseArgs();
      if (consume() !== ')') throw new FormulaError('#INVALID');
      if (!fn) throw new FormulaError('#NAME?');
      return fn(args);
    }

    let s = '';
    while (/[\d.]/.test(peek())) s += consume();
    if (s === '' || s === '.') throw new FormulaError('#INVALID');
    return parseFloat(s);
  }

  try {
    const result = parseExpr();
    if (pos < src.length) throw new FormulaError('#INVALID');
    if (!isFinite(result)) throw new FormulaError('#INVALID');
    return String(result);
  } catch (err) {
    return err instanceof FormulaError ? err.code : '#INVALID';
  }
}
