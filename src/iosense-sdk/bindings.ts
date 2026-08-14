// Shared binding-index builder. The configurator keeps its own copy for the
// panel flow; the dev harness uses this when the widget emits CONFIG_CHANGE so
// it can rebuild dynamicBindingPathList before re-resolving. Cell bindings key
// by the target cellId; series bindings key by "series:<baseCellId>".
import { TableWidgetUIConfig } from './types';

// Bare UNS topic from a stored binding value. Mapped values are wrapped as
// "{{uns:wsId://path}}"; a raw pasted "uns:wsId://path" is accepted as-is.
export function extractTopic(raw: string | undefined): string {
  const t = (raw ?? '').trim();
  const m = /^\{\{(.+)\}\}$/.exec(t);
  return (m ? m[1] : t).trim();
}

export function buildDynamicBindingPathList(
  uiConfig: TableWidgetUIConfig,
): Array<{ key: string; topic: string }> {
  const paths: Array<{ key: string; topic: string }> = [];

  for (const b of uiConfig.cellBindings) {
    const topic = extractTopic(b.topic);
    if (b.cellId && topic) paths.push({ key: b.cellId, topic });
  }

  for (const s of uiConfig.seriesBindings) {
    const topic = extractTopic(s.topic);
    if (s.baseCellId && topic) paths.push({ key: `series:${s.baseCellId}`, topic });
  }

  return paths;
}
