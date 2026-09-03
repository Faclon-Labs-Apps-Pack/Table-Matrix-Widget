import { BindingType, DataValue, ResolveSlot } from './types';

const STAGING_BASE = 'https://stagingsv.iosense.io/api';
const GRAPH = 'iosense_test_uns';

export async function validateSSOToken(ssoToken: string): Promise<string> {
  const res = await fetch(`${STAGING_BASE}/account/validateSSO`, {
    method: 'GET',
    headers: { token: ssoToken },
  });
  const json = await res.json();
  if (!json.success || !json.token) throw new Error('SSO validation failed');
  return json.token;
}

// One entry of the resolveAndCompute request `config[]`. `type: 'series'` is
// what makes the endpoint bucket the window and return `slots` — without it a
// topic collapses to the single value its aggregation postfix asks for.
export interface ResolveConfigItem {
  key: string;
  topic: string;
  type?: BindingType;
}

// One row of the resolveAndCompute response. Single-value rows carry `value`;
// series rows carry `slots` (and no `value`). A row that failed to resolve
// carries `error`, or `skipped` + `reason` when the leaf is not computable.
export interface ResolveRow {
  key: string;
  value?: DataValue;
  slots?: ResolveSlot[];
  path?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
  meta?: {
    type?: string;
    unit?: string;
    dataPrecision?: number | null;
    aggregation?: { operator?: string | null; downscale?: number | null; resolution?: string | null };
  };
}

// Bucket size for series rows. Anything the endpoint accepts as `timeFrame`.
export type ResolveTimeFrame = 'minute' | 'hour' | 'day' | 'week' | 'month';

export async function resolveAndCompute(
  authentication: string,
  config: ResolveConfigItem[],
  startTime: number,
  endTime: number,
  options?: { timeFrame?: ResolveTimeFrame; timezone?: string },
): Promise<ResolveRow[]> {
  const res = await fetch(`${STAGING_BASE}/account/uns/resolveAndCompute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authentication}`,
    },
    body: JSON.stringify({
      graph: GRAPH,
      config,
      startTime,
      endTime,
      ...(options?.timeFrame ? { timeFrame: options.timeFrame } : {}),
      ...(options?.timezone ? { timezone: options.timezone } : {}),
    }),
  });
  const json = await res.json();
  if (json?.success === false) {
    throw new Error(`resolveAndCompute failed: ${(json.errors ?? []).join(', ') || res.status}`);
  }
  return (json?.data ?? []) as ResolveRow[];
}

export async function fetchUNSNodes(
  authentication: string,
  graph: string,
  label?: string,
  limit = 100,
  expandPostfix = false,
): Promise<Array<{ id: string; type: string; name?: string; path: string | null; parentId: string | null }>> {
  const params = new URLSearchParams({ graph, limit: String(limit) });
  if (label) params.set('label', label);
  if (expandPostfix) params.set('expandPostfix', 'true');
  const res = await fetch(`${STAGING_BASE}/account/uns/nodes?${params}`, {
    headers: { Authorization: `Bearer ${authentication}` },
  });
  if (!res.ok) throw new Error(`uns/nodes ${res.status} for graph=${graph}`);
  const json = await res.json();
  // The endpoint double-nests: { data: { data: [...] } }. Some deployments return
  // the single-nested shape, so accept both rather than silently yielding [].
  return (json?.data?.data ?? json?.data ?? []) as Array<{
    id: string; type: string; name?: string; path: string | null; parentId: string | null;
  }>;
}
