import { useCallback, useEffect, useRef, useState } from 'react';
import { CounterInput } from '@faclon-labs/design-sdk';

interface NumberFieldProps {
  label: string;
  value: number | null;
  min?: number;
  max?: number;
  step?: number;
  isDisabled?: boolean;
  className?: string;
  onChange: (value: number | null) => void;
}

/**
 * Every numeric field in this widget. A thin wrapper over design-sdk's
 * CounterInput that adds two behaviours the SDK component has no props for.
 *
 * ── 1. A negative value can never be committed ──────────────────────────────
 *
 * Two layers, because one is not enough:
 *
 *  a. `beforeinput`, capture phase, on the input itself — rejects any insertion
 *     containing "-", whether typed or pasted. This is the layer that matters:
 *     CounterInput clamps to `min` on blur against its own raw string, so a
 *     field with `min={1}` would commit a typed "-5" as **1**. Correcting the
 *     value in `onChange` cannot beat that — while the user is typing,
 *     CounterInput stops syncing its display from the `value` prop, so the "-5"
 *     survives in the DOM until blur, and blur clamps it.
 *
 *  b. `Math.abs` on the way out — the safety net for anything that reaches the
 *     parse step anyway (a programmatic set, or a browser where the
 *     `beforeinput` default is not cancelable).
 *
 * A plain `onKeyDown` prop is NOT usable for (a): CounterInput spreads its rest
 * props after its own handlers, so passing one would silently replace the
 * ArrowUp/ArrowDown increment.
 *
 * ── 2. The wheel changes the value on hover ─────────────────────────────────
 *
 * No click or focus required — hovering is enough. The listener sits on the
 * component root rather than the <input> so the whole field is a target, and it
 * calls `preventDefault`, so a field under the pointer never scrolls the config
 * panel and changes its value at the same time.
 *
 * The cost of hover-without-focus is real and deliberate: a wheel gesture meant
 * to scroll the panel past a numeric field will change that field instead. That
 * is the accepted trade for not having to click in first.
 *
 * `passive: false` is required — a passive listener cannot preventDefault, and
 * browsers default wheel listeners to passive.
 *
 * ── 3. The field can be emptied ─────────────────────────────────────────────
 *
 * Select-all + Backspace has to leave an empty box the user can type into, and
 * a half-typed number must not be pushed to the widget: in a field with
 * `min={8}`, typing the "1" of "12" would otherwise commit 8 (or 1) and repaint
 * the table mid-keystroke.
 *
 * So the component holds a DRAFT while the user is mid-edit. Only a value
 * inside [min, max] is passed up; an empty or out-of-range draft stays local
 * until blur, where it is clamped (or, if empty, abandoned in favour of the
 * value the parent already has). The parent therefore never sees null and its
 * callers stay as they are.
 */
export function NumberField({ onChange, ...rest }: NumberFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // undefined = show the committed value; anything else is the in-progress
  // edit, including null for "the box is empty".
  const [draft, setDraft] = useState<number | null | undefined>(undefined);

  // The wheel listener is attached once, so it reads the current props through
  // a ref rather than closing over the values from its own render.
  const latest = useRef({ onChange, ...rest });
  latest.current = { onChange, ...rest };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    const rejectMinus = (event: Event) => {
      const { data } = event as InputEvent;
      if (typeof data === 'string' && data.includes('-')) event.preventDefault();
    };

    const root = input.closest('.fds-counter-input');

    const adjustOnWheel = (event: Event) => {
      const { deltaY } = event as WheelEvent;
      const { value, min, max, step, isDisabled, onChange: emit } = latest.current;
      if (isDisabled || deltaY === 0) return;

      event.preventDefault();

      const base = value ?? min ?? 0;
      // Scrolling up raises the value, matching the arrow keys.
      let next = base + (deltaY < 0 ? 1 : -1) * (step ?? 1);
      if (typeof min === 'number' && next < min) next = min;
      if (typeof max === 'number' && next > max) next = max;

      emit(Math.abs(next));
    };

    input.addEventListener('beforeinput', rejectMinus, true);
    root?.addEventListener('wheel', adjustOnWheel, { passive: false });

    return () => {
      input.removeEventListener('beforeinput', rejectMinus, true);
      root?.removeEventListener('wheel', adjustOnWheel);
    };
  }, []);

  const { min, max, value } = rest;

  const handleChange = useCallback(
    ({ value: next }: { name: string; value: number | null }) => {
      if (next === null) { setDraft(null); return; }   // emptied — hold it
      const positive = Math.abs(next);
      const inRange =
        (typeof min !== 'number' || positive >= min) && (typeof max !== 'number' || positive <= max);
      setDraft(inRange ? undefined : positive);
      if (inRange) onChange(positive);
    },
    [onChange, min, max],
  );

  // Leaving the field settles it: an empty box falls back to what the parent
  // holds, an out-of-range number is clamped into it.
  const handleBlur = useCallback(() => {
    setDraft((current) => {
      if (current === undefined) return undefined;
      if (current !== null) {
        let settled = current;
        if (typeof min === 'number' && settled < min) settled = min;
        if (typeof max === 'number' && settled > max) settled = max;
        onChange(settled);
      }
      return undefined;
    });
  }, [onChange, min, max]);

  return (
    <CounterInput
      ref={inputRef}
      {...rest}
      value={draft !== undefined ? draft : value}
      onChange={handleChange}
      onBlur={handleBlur}
    />
  );
}
