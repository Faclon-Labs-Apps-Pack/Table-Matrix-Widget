import { TableWidgetEnvelope, TableWidgetUIConfig, DataEntry, Duration } from './types';
import { resolveAndCompute, ResolveRow, ResolveTimeFrame } from './api';

interface MiniEngineCtx {
  authentication: string;
  override?: { startTime: number; endTime: number };
}

// Bucket size used for series bindings when the envelope carries no timeConfig
// (the dev harness never sets one). Series rows come back one slot per bucket,
// so this is what decides how many cells a series fills over the window.
const DEFAULT_TIME_FRAME: ResolveTimeFrame = 'hour';

const PERIODICITY_TO_TIME_FRAME: Record<string, ResolveTimeFrame> = {
  minute:  'minute',
  hourly:  'hour',
  daily:   'day',
  weekly:  'week',
  monthly: 'month',
};

export async function resolve(
  envelope: TableWidgetEnvelope,
  ctx: MiniEngineCtx,
): Promise<{ config: TableWidgetUIConfig; data: DataEntry[] }> {
  const { startTime, endTime } = computeWindow(envelope, ctx.override);
  const bindings = envelope.dynamicBindingPathList ?? [];

  if (bindings.length === 0) return { config: envelope.uiConfig, data: [] };

  try {
    const rows = await resolveAndCompute(
      ctx.authentication,
      // `type` matters: series entries must be sent as `type: 'series'` or the
      // endpoint returns a single value instead of the bucketed `slots`.
      bindings.map(({ key, topic, type }) => (type ? { key, topic, type } : { key, topic })),
      startTime,
      endTime,
      {
        timeFrame: computeTimeFrame(envelope),
        timezone: computeTimezone(envelope),
      },
    );
    const data = rows.map(toDataEntry).filter((entry): entry is DataEntry => entry !== null);
    return { config: envelope.uiConfig, data };
  } catch (err) {
    console.error('[MiniEngine] resolveAndCompute failed', err);
    return { config: envelope.uiConfig, data: [] };
  }
}

// Map one response row to a DataEntry. Series rows arrive as `slots` — one
// bucket per time step — which flatten to the value array the widget spreads
// across cells; `slots` rides along so the labels/timestamps stay available.
// Failed and skipped rows are dropped (with a log) rather than written to the
// widget as an undefined value that would blank the cell.
function toDataEntry(row: ResolveRow): DataEntry | null {
  if (row.error) {
    console.error(`[MiniEngine] "${row.key}" failed to resolve: ${row.error}`);
    return null;
  }
  if (row.skipped) {
    console.warn(`[MiniEngine] "${row.key}" skipped: ${row.reason ?? 'leaf is not computable'}`);
    return null;
  }
  if (row.slots) {
    return { key: row.key, value: row.slots.map((slot) => slot.value), slots: row.slots };
  }
  if (row.value === undefined) {
    console.warn(`[MiniEngine] "${row.key}" resolved with neither value nor slots`, row);
    return null;
  }
  return { key: row.key, value: row.value };
}

// Bucket size for series rows, from the envelope's periodicity.
function computeTimeFrame(envelope: TableWidgetEnvelope): ResolveTimeFrame {
  const periodicity = envelope.timeConfig?.defaultPeriodicity;
  return (periodicity && PERIODICITY_TO_TIME_FRAME[periodicity]) || DEFAULT_TIME_FRAME;
}

// Which clock the buckets are cut and labelled against.
//
// `uiConfig.timeDisplay` is the operator-facing switch and wins over the
// envelope's timeConfig: a table set to "Global (UTC)" must read the same for
// every viewer, whatever browser it is opened in, while "Local" follows the
// viewer. Only when the widget has no opinion does the envelope's own timezone
// apply.
function computeTimezone(envelope: TableWidgetEnvelope): string | undefined {
  const mode = envelope.uiConfig?.timeDisplay;
  if (mode === 'utc') return 'UTC';
  if (mode === 'local') return localTimezone();
  return envelope.timeConfig?.timezone || localTimezone();
}

function localTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function computeWindow(
  envelope: TableWidgetEnvelope,
  override?: { startTime: number; endTime: number },
): { startTime: number; endTime: number } {
  if (override) return override;
  const { timeConfig } = envelope;
  if (!timeConfig) return { startTime: Date.now() - 86_400_000, endTime: Date.now() };
  if (timeConfig.type === 'fixed' && timeConfig.startTime && timeConfig.endTime) {
    return { startTime: timeConfig.startTime, endTime: timeConfig.endTime };
  }
  const now = Date.now();
  const dur = timeConfig.allDurations?.find((d) => d.id === timeConfig.defaultDuration);
  if (dur) return { startTime: computePresetStart(dur, now), endTime: now };
  return { startTime: now - 86_400_000, endTime: now };
}

function computePresetStart(dur: Duration, now: number): number {
  const x = dur.x ?? 1;
  const periodMs: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
    year: 365 * 86_400_000,
  };
  return now - x * (periodMs[dur.xPeriod] ?? 86_400_000);
}
