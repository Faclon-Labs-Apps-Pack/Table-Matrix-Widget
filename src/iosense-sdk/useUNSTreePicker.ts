import { useState, useEffect, useRef, useCallback } from 'react';
import type { UNSNode, UNSWorkspace } from '@faclon-labs/design-sdk/UNSTreePicker';
import { fetchUNSNodes } from './api';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UseUNSTreePickerResult {
  /** Pass to UNSTreePicker `workspaces` prop. */
  workspaces: UNSWorkspace[];
  /** Pass to UNSTreePicker `isLoadingWorkspaces` prop. */
  isLoadingWorkspaces: boolean;
  /** Call from UNSTreePicker `onOpen`. Fetches the workspace list once; later calls are no-ops. */
  loadWorkspaces: () => void;
  /** Pass to UNSTreePicker `loadChildren`. Omit parentId for a workspace's top level. */
  loadChildren: (wsId: string, parentId?: string) => Promise<UNSNode[]>;
  /** Pass to UNSTreePicker `searchNodes`. Matches on node name and path. */
  searchNodes: (wsId: string, query: string, limit?: number) => Promise<UNSNode[]>;
}

// ---------------------------------------------------------------------------
// Module-level singleton cache — shared across ALL hook instances on the page.
// Workspaces fetched once even when 10 widgets mount simultaneously; a workspace's
// nodes fetched by Widget A are instantly available to Widget B.
//
// UNSTreePicker builds the committed `{{uns:<wsId>://<path>}}` topic itself from
// each node's `unsId` + `path`, so unlike the old UNSPathInput wiring there is no
// display-name → topic meta map to maintain here.
// ---------------------------------------------------------------------------

interface WorkspaceNodes {
  /** Children keyed by parent id; '' holds the workspace's top level. */
  byParent: Map<string, UNSNode[]>;
  /** Selectable leaves only — the search corpus. Folders are never search hits. */
  leaves: UNSNode[];
}

const _cache: {
  workspaces: UNSWorkspace[] | null;
  /** In-flight or settled per-workspace fetch, keyed by wsId. Dedupes concurrent drills. */
  nodes: Map<string, Promise<WorkspaceNodes>>;
  listeners: Set<() => void>;
} = {
  workspaces: null,
  nodes: new Map(),
  listeners: new Set(),
};

let _workspacesInFlight: Promise<void> | null = null;

function _notifyAll() {
  _cache.listeners.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
// Flat node list → parent-keyed index
//
// The /uns/nodes endpoint returns a flat list filtered to `label=Operational`,
// so a node's parentId may point at an intermediate node (e.g. a Line) that the
// filter excluded. Those orphans are anchored at the workspace top level rather
// than dropped — otherwise filtering would make them unreachable in the picker.
//
// `expandPostfix` additionally returns virtualProperty nodes (":last", ":avg", …)
// that share their Tag's name and differ only by a colon suffix on the path.
// They are attached as children of that Tag by path prefix, not by parentId.
// ---------------------------------------------------------------------------

function indexWorkspaceNodes(
  wsId: string,
  raw: Array<{ id: string; type: string; name?: string; path: string | null; parentId: string | null }>,
): WorkspaceNodes {
  const tags: typeof raw = [];
  /** Virtual properties grouped by their owning Tag's path. */
  const vpsByTagPath = new Map<string, typeof raw>();
  /** Ids of tags that some other tag claims as its parent. */
  const parentIds = new Set<string>();
  const tagIds = new Set<string>();

  for (const node of raw) {
    if (!node.name) continue;
    if (node.type === 'virtualProperty') {
      // "<tagPath>:<suffix>" — everything before the last colon owns this property.
      const path = node.path ?? '';
      const cut = path.lastIndexOf(':');
      if (cut <= 0) continue;
      const tagPath = path.substring(0, cut);
      const bucket = vpsByTagPath.get(tagPath);
      if (bucket) bucket.push(node);
      else vpsByTagPath.set(tagPath, [node]);
    } else {
      tags.push(node);
      tagIds.add(node.id);
      if (node.parentId) parentIds.add(node.parentId);
    }
  }

  const byParent = new Map<string, UNSNode[]>();
  const leaves: UNSNode[] = [];

  const push = (parentKey: string, node: UNSNode) => {
    const bucket = byParent.get(parentKey);
    if (bucket) bucket.push(node);
    else byParent.set(parentKey, [node]);
    if (!node.hasChildren) leaves.push(node);
  };

  for (const tag of tags) {
    const path = tag.path ?? tag.name!;
    const vps = vpsByTagPath.get(path) ?? [];

    // Anchor under parentId only when that parent survived the label filter.
    const parentKey = tag.parentId && tagIds.has(tag.parentId) ? tag.parentId : '';

    const isFolder = vps.length > 0 || parentIds.has(tag.id);

    push(parentKey, {
      id: tag.id,
      unsId: wsId,
      // 'Tag' marks a selectable leaf; anything else is a folder. A Tag that owns
      // :op variants is NOT selectable — only its variants resolve to data.
      type: isFolder ? 'Folder' : 'Tag',
      name: tag.name!,
      path,
      hasChildren: isFolder,
      childCount: vps.length || undefined,
    });

    // Virtual properties share their Tag's name — key them by the colon suffix
    // (":last", ":avg") so each row is distinguishable in the dropdown.
    for (const vp of vps) {
      const vpPath = vp.path!;
      push(tag.id, {
        id: vp.id,
        unsId: wsId,
        type: 'Tag',                 // the aggregation variant IS the selectable leaf
        name: vpPath.substring(vpPath.lastIndexOf(':')),
        path: vpPath,
        hasChildren: false,
      });
    }
  }

  return { byParent, leaves };
}

// ---------------------------------------------------------------------------
// useUNSTreePicker
//
// Pass `undefined` for `authentication` when the host injects UNS data — that makes
// every loader a no-op instead of firing a redundant round trip behind the host.
// ---------------------------------------------------------------------------

export function useUNSTreePicker(authentication?: string): UseUNSTreePickerResult {
  const [, setTick] = useState(0);
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(false);

  const authRef = useRef(authentication);
  useEffect(() => { authRef.current = authentication; }, [authentication]);

  // Subscribe this instance to cache updates; unsubscribe on unmount.
  useEffect(() => {
    const notify = () => setTick((v) => v + 1);
    _cache.listeners.add(notify);
    return () => { _cache.listeners.delete(notify); };
  }, []);

  const loadWorkspaces = useCallback(() => {
    // null means not yet fetched; [] means fetched but empty — both are valid.
    if (!authRef.current || _cache.workspaces !== null || _workspacesInFlight) return;
    setIsLoadingWorkspaces(true);
    _workspacesInFlight = fetchUNSNodes(authRef.current, 'uns:_workspaces')
      .then((nodes) => {
        const list: UNSWorkspace[] = [];
        for (const n of nodes) {
          if (n.type === 'Workspace' && n.name) list.push({ id: n.id, name: n.name });
        }
        console.log('[UNS] workspaces loaded:', list.map((w) => w.name));
        _cache.workspaces = list;
        _notifyAll();
      })
      .catch((err) => { console.error('[UNS] workspace fetch failed:', err); })
      .finally(() => {
        _workspacesInFlight = null;
        setIsLoadingWorkspaces(false);
      });
  }, []);

  const ensureNodes = useCallback((wsId: string): Promise<WorkspaceNodes> => {
    const cached = _cache.nodes.get(wsId);
    if (cached) return cached;

    const auth = authRef.current;
    if (!auth) return Promise.resolve({ byParent: new Map(), leaves: [] });

    console.log(`[UNS] fetching nodes for workspace: ${wsId}`);
    const pending = fetchUNSNodes(auth, `uns:${wsId}`, 'Operational', 100, true)
      .then((nodes) => {
        console.log(`[UNS] ${wsId}: ${nodes.length} nodes loaded`);
        return indexWorkspaceNodes(wsId, nodes);
      })
      .catch((err) => {
        console.error(`[UNS] node fetch failed for ${wsId}:`, err);
        _cache.nodes.delete(wsId);   // let the next drill retry
        return { byParent: new Map(), leaves: [] } as WorkspaceNodes;
      });

    _cache.nodes.set(wsId, pending);
    return pending;
  }, []);

  const loadChildren = useCallback(
    async (wsId: string, parentId?: string): Promise<UNSNode[]> => {
      const { byParent } = await ensureNodes(wsId);
      return byParent.get(parentId ?? '') ?? [];
    },
    [ensureNodes],
  );

  const searchNodes = useCallback(
    async (wsId: string, query: string, limit = 50): Promise<UNSNode[]> => {
      const { leaves } = await ensureNodes(wsId);
      const q = query.trim().toLowerCase();
      if (!q) return [];
      return leaves
        .filter((n) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
        .slice(0, limit);
    },
    [ensureNodes],
  );

  return {
    workspaces: _cache.workspaces ?? [],
    isLoadingWorkspaces,
    loadWorkspaces,
    loadChildren,
    searchNodes,
  };
}
