import { useId, useState } from 'react';
import { Popover, PopoverBody, Tooltip, ColorPicker, hexToRgb, rgbToHsb, hsbToRgb, rgbToHex } from '@faclon-labs/design-sdk';

// Excel-style colour tool: an icon with a bar of the current colour under it,
// and ONE click to the picker itself.
//
// The obvious composition — a Popover holding design-sdk's ColorInput — costs
// two clicks and two layers, because ColorInput is a *field* that opens its own
// picker popover: the toolbar button opened a panel that only held another
// trigger. ColorPicker is that popover's content on its own, so mounting it
// directly as the Popover body puts the gradient, the hue/opacity sliders and
// the swatches under the pointer the moment the icon is clicked.
//
// ColorPicker is fully controlled (it holds no colour state of its own), so the
// conversions the field used to do live here: hex in, HSB/RGB out to the panel,
// hex back out on every edit.

interface ColorToolProps {
  /** Hover label and accessible name — "Text color", "Fill color". */
  label: string;
  /** The tool's glyph; the colour bar is drawn under it. */
  icon: React.ReactNode;
  /** Current colour as hex, or '' when the cells carry no colour of their own. */
  value: string;
  /** Bar colour (and picker starting point) while `value` is ''. */
  fallback: string;
  /** '' renders the bar as an empty outline instead of a fill — used by Fill,
   *  where "no colour" is a real state rather than a shade of white. */
  emptyBar?: boolean;
  onChange: (hex: string) => void;
}

type ConfigMode = 'Hex' | 'RGB';

const OPAQUE = 100;

// #RRGGBB / #RRGGBBAA → the alpha percentage the panel's opacity slider shows.
function alphaOf(hex: string): number {
  return hex.length === 9 ? Math.round((parseInt(hex.slice(7, 9), 16) / 255) * 100) : OPAQUE;
}

// Re-attach alpha as CSS's 8-digit hex, dropping it when the colour is opaque
// so ordinary colours stay the plain 6-digit hex the rest of the widget uses.
function withAlpha(hex: string, alpha: number): string {
  const base = hex.slice(0, 7).toUpperCase();
  if (alpha >= OPAQUE) return base;
  const a = Math.round((Math.max(0, Math.min(OPAQUE, alpha)) / OPAQUE) * 255);
  return `${base}${a.toString(16).padStart(2, '0').toUpperCase()}`;
}

export function ColorTool({ label, icon, value, fallback, emptyBar, onChange }: ColorToolProps) {
  // Which of Hex / RGB the picker's config row is showing — display state the
  // panel doesn't keep for itself.
  const [configMode, setConfigMode] = useState<ConfigMode>('Hex');
  // Popover puts this on its portaled panel, which is otherwise unreachable
  // from CSS — the panel is a fixed 328px, ~56px wider than the picker, which
  // stretches the config row until the opacity field clips its own "100".
  // The id prefix lets one rule size the panel to the picker (see the CSS).
  const panelId = `vg-color-picker-${useId()}`;

  const current = value || fallback;
  const opacity = alphaOf(current);
  const [r, g, b] = hexToRgb(current) ?? [0, 0, 0];
  const [hue, saturation, brightness] = rgbToHsb(r, g, b);

  const emitRgb = (nr: number, ng: number, nb: number, alpha = opacity) =>
    onChange(withAlpha(rgbToHex(nr, ng, nb), alpha));

  const emitHsb = (h: number, s: number, v: number) => {
    const [nr, ng, nb] = hsbToRgb(h, s, v);
    emitRgb(nr, ng, nb);
  };

  return (
    <Popover
      id={panelId}
      placement="Bottom Start"
      trigger={
        <Tooltip bodyText={label} placement="Bottom">
          <div
            className="vg-color-trigger"
            role="button"
            tabIndex={0}
            aria-label={label}
            // Popover owns the click on its own wrapper, so Enter/Space have to
            // be turned into one here for the trigger to be keyboard-operable.
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              (e.currentTarget as HTMLElement).click();
            }}
          >
            {icon}
            <span
              className="vg-color-trigger__bar"
              style={
                emptyBar && !value
                  ? { backgroundColor: 'transparent', border: '1px solid var(--border-gray-subtle, #ddd)' }
                  : { backgroundColor: current }
              }
            />
          </div>
        </Tooltip>
      }
    >
      <PopoverBody>
        {/* The picker paints its own surface; stop clicks inside it from
            reaching the grid's clear-selection handler. */}
        <div className="vg-color-panel" onClick={(e) => e.stopPropagation()}>
          <ColorPicker
            hue={hue}
            saturation={saturation}
            brightness={brightness}
            opacity={opacity}
            r={r}
            g={g}
            b={b}
            hex={current.slice(0, 7).toUpperCase()}
            selectedColor={value}
            configMode={configMode}
            onConfigModeChange={(mode: ConfigMode) => setConfigMode(mode)}
            onHueChange={(h: number) => emitHsb(h, saturation, brightness)}
            onSaturationBrightnessChange={(s: number, v: number) => emitHsb(hue, s, v)}
            onOpacityChange={(alpha: number) => emitRgb(r, g, b, alpha)}
            onRgbChange={(nr: number, ng: number, nb: number) => emitRgb(nr, ng, nb)}
            onHexChange={(hex: string) => {
              const rgb = hexToRgb(hex);
              if (rgb) emitRgb(rgb[0], rgb[1], rgb[2]);
            }}
            onColorSelect={(hex: string) => onChange(hex.toUpperCase())}
          />
        </div>
      </PopoverBody>
    </Popover>
  );
}
