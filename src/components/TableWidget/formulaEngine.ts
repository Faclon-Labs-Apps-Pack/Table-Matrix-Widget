import { NumberFormat, ConditionalRule, ConditionalRuleFormat, ConditionalRuleRange } from '../../iosense-sdk/types';
import { CellDataStore, CellId } from './CellDataStore';

// ── Number formatting ──────────────────────────────────────────────────────

export function applyNumberFormat(value: string, format: NumberFormat): string {
  if (format === 'general') return value;
  const num = parseFloat(value.replace(/,/g, ''));
  if (isNaN(num)) return value;
  switch (format) {
    case 'number':
      return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'percent':
      return (num * 100).toFixed(2) + '%';
    case 'currency':
      return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
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

export function getDisplayValue(cellId: CellId, store: CellDataStore): string {
  const raw = store.getValue(cellId);
  const fmt = store.getFormat(cellId);
  if (raw.startsWith('=')) {
    const result = evalExpr(raw.slice(1), store, new Set([cellId]));
    return applyNumberFormat(result, fmt.numberFormat);
  }
  return applyNumberFormat(raw, fmt.numberFormat);
}

// ── Internal: cell-ref resolution ─────────────────────────────────────────

export function refToCellId(ref: string): CellId {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) throw new Error(`bad ref: ${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  col -= 1;
  return `R${parseInt(m[2], 10) - 1}C${col}`;
}

function evalExpr(expr: string, store: CellDataStore, visiting: Set<CellId>): string {
  try {
    const withValues = expr.replace(/[A-Z]+\d+/g, (ref) => {
      let id: CellId;
      try { id = refToCellId(ref); } catch { return '0'; }
      if (visiting.has(id)) return '0';
      const v = store.getValue(id);
      const inner = v.startsWith('=')
        ? evalExpr(v.slice(1), store, new Set([...visiting, id]))
        : v;
      const n = parseFloat(inner);
      return isNaN(n) ? '0' : String(n);
    });
    return String(parseArith(withValues));
  } catch {
    return '#INVALID';
  }
}

// ── Arithmetic parser (recursive descent) ─────────────────────────────────
// Supports: numbers, +  -  *  /  **  ^  ( )  unary-minus

function parseArith(input: string): number {
  let pos = 0;
  const src = input.replace(/\s+/g, '');

  function peek(): string { return src[pos] ?? ''; }
  function consume(): string { return src[pos++]; }

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
      const op = consume();
      if (op === '*' && peek() === '*') {
        consume();
        v = Math.pow(v, parsePow());
        continue;
      }
      const rhs = parsePow();
      if (op === '/') {
        if (rhs === 0) throw new Error('div/0');
        v = v / rhs;
      } else {
        v = v * rhs;
      }
    }
    return v;
  }

  function parsePow(): number {
    const base = parseUnary();
    if (peek() === '^') { consume(); return Math.pow(base, parsePow()); }
    return base;
  }

  function parseUnary(): number {
    if (peek() === '-') { consume(); return -parseUnary(); }
    if (peek() === '+') { consume(); return parseUnary(); }
    return parsePrimary();
  }

  function parsePrimary(): number {
    if (peek() === '(') {
      consume();
      const v = parseExpr();
      if (consume() !== ')') throw new Error('missing )');
      return v;
    }
    let s = '';
    while (/[\d.]/.test(peek())) s += consume();
    if (s === '' || s === '.') throw new Error(`unexpected: ${peek() || 'EOF'}`);
    return parseFloat(s);
  }

  const result = parseExpr();
  if (pos < src.length) throw new Error(`trailing: ${src.slice(pos)}`);
  return result;
}
