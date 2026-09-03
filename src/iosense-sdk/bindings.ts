// Shared binding-index builder. The configurator keeps its own copy for the
// panel flow; the dev harness uses this when the widget emits CONFIG_CHANGE so
// it can rebuild dynamicBindingPathList before re-resolving. Cell bindings key
// by the target cellId; series bindings key by "series:<baseCellId>".
import { BindingPath, TableWidgetUIConfig } from './types';

// Bare UNS topic from a stored binding value. Mapped values are wrapped as
// "{{uns:wsId://path}}"; a raw pasted "uns:wsId://path" is accepted as-is.
export function extractTopic(raw: string | undefined): string {
  const t = (raw ?? '').trim();
  const m = /^\{\{(.+)\}\}$/.exec(t);
  return (m ? m[1] : t).trim();
}

export function buildDynamicBindingPathList(
  uiConfig: TableWidgetUIConfig,
): BindingPath[] {
  const paths: BindingPath[] = [];

  for (const b of uiConfig.cellBindings) {
    const topic = extractTopic(b.topic);
    if (b.cellId && topic) paths.push({ key: b.cellId, topic });
  }

  // Series bindings carry `type: 'series'` so the resolve call asks for the
  // bucketed (slots) result instead of the single value the topic's
  // aggregation postfix would otherwise collapse the window to. Without it the
  // engine gets one number back and the series fills exactly one cell.
  for (const s of uiConfig.seriesBindings) {
    const topic = extractTopic(s.topic);
    if (s.baseCellId && topic) paths.push({ key: `series:${s.baseCellId}`, topic, type: 'series' });
  }

  return paths;
}
