---
name: widget-dev-harness
description: >
  Use this skill whenever setting up or updating the App.tsx dev harness for a widget.
  Triggers include: "wire up the widget preview", "connect configurator to widget",
  "set up App.tsx", "preview widget locally", or any task that involves rendering a widget
  alongside its configurator in development. Always read alongside widget-datalayer-architecture
  and mini-engine skills.
---

# Widget Dev Harness Skill

## What the Dev Harness Does

The dev harness (`App.tsx`) wires:

1. **Configurator** → produces `DataPointEnvelope` with `dynamicBindingPathList`
2. **Mini-Engine** → calls `resolve(envelope, { authentication })` → real `resolveAndCompute` API call
3. **Widget** → receives `config = envelope.uiConfig` and `data = DataEntry[]`, renders as it would in production

It simulates the full DataLayer → Widget flow with real backend calls. No dummy data.

---

## Auth Flow

Visit `http://localhost:3000/?token=<SSO_TOKEN>` once to exchange an SSO token for a JWT. The JWT is stored in `localStorage.bearer_token` and reused across sessions.

```typescript
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const ssoToken = params.get('token');
  if (ssoToken && !auth) {
    validateSSOToken(ssoToken).then((jwt) => {
      if (jwt) {
        localStorage.setItem('bearer_token', jwt);
        setAuth(jwt);
      }
    });
  }
}, []);
```

---

## UNS Injection Props (Angular Production vs Dev Harness)

The UNS topic field is **`UNSTreePicker`** (design-sdk 0.7.16+), imported from the
barrel; node types and the topic helpers come from the subpath:

```ts
import { UNSTreePicker } from '@faclon-labs/design-sdk';
import type { UNSNode, UNSWorkspace } from '@faclon-labs/design-sdk/UNSTreePicker';
```

It commits `{{uns:<wsId>://<path>}}` itself — **there is no resolve step.** That was
the old `UNSPathInput` flow, which needed a whole tree up front that no endpoint
produces, which is why it always came up empty.

Gate injected-vs-hook on the **pair** of props, and feed the hook `undefined` when
the host injects, so the fallback does not fire a redundant round trip:

```ts
const hasInjectedUNS = unsWorkspaces !== undefined && loadUnsChildren !== undefined;
const hook = useUNSTreePicker(hasInjectedUNS ? undefined : authentication);
```

Props to declare on the configurator (these exact names — the host injects them):

```ts
unsWorkspaces?: UNSWorkspace[];
isLoadingWorkspaces?: boolean;
loadUnsChildren?: (wsId: string, parentId?: string) => Promise<UNSNode[]>;
searchUnsNodes?: (wsId: string, query: string, limit?: number) => Promise<UNSNode[]>;
```

**Dev harness (App.tsx):** pass only `authentication`; `useUNSTreePicker` fetches.

### Reshaping the flat node list

`nodes?graph=uns:<wsId>&expandPostfix=true` returns a flat list: Tags plus
`virtualProperty` rows pathed `<tagPath>:<op>`. **The aggregation suffix is
mandatory** — a topic without one resolves to nothing, so the `:op` variants, not
the bare Tags, must be the selectable leaves:

- Tag **with** variants → `type: 'Folder'`, `hasChildren: true`, `childCount = n`;
  its `:op` variants become the `Tag` leaves beneath it.
- Tag **without** variants → `type: 'Tag'`, `hasChildren: false`.

`type` and `hasChildren` must agree. Search runs client-side over the leaves only.

### Two endpoint traps

> **`/uns/workspaces` does not exist** — it 404s. Workspaces come from
> `nodes?graph=uns:_workspaces` filtered to `type === 'Workspace'`. The failure is a
> rejected fetch, not an empty list, so the symptom is a picker with no workspaces
> and no error.

> **The response is double-nested:** `{ data: { data: [...] } }`. Read it as
> `body?.data?.data ?? body?.data ?? []`.

### Portals

The dropdown portals to `document.body`, outside the container `index.ts` stamps.
Host panels that close on outside click will close the moment an option is clicked.
`iosense-sdk/zoneIgnorePortals.ts` runs a refcounted `MutationObserver` that stamps
`data-zone-ignore` on `.fds-uns-tree-picker__popover` and friends as they mount;
call `useZoneIgnorePortals()` from any component rendering a picker.

---

## Full App.tsx Template

```tsx
import React, { useState, useEffect } from 'react';
import { DataPoint } from './components/DataPoint/DataPoint';
import { DataPointConfiguration } from './components/DataPointConfiguration/DataPointConfiguration';
import { DataEntry, DataPointEnvelope } from './iosense-sdk/types';
import { validateSSOToken } from './iosense-sdk/api';
import { resolve } from './iosense-sdk/mini-engine';
import './App.css';

export default function App() {
  const [envelope, setEnvelope] = useState<DataPointEnvelope | undefined>(undefined);
  const [data, setData] = useState<DataEntry[]>([]);
  const [auth, setAuth] = useState<string>(localStorage.getItem('bearer_token') ?? '');

  // Exchange SSO token from URL query param on first load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get('token');
    if (ssoToken && !auth) {
      validateSSOToken(ssoToken).then((jwt) => {
        if (jwt) {
          localStorage.setItem('bearer_token', jwt);
          setAuth(jwt);
        }
      });
    }
  }, []);

  // Re-resolve whenever envelope or auth changes
  useEffect(() => {
    if (!envelope || !auth) return;
    console.log('[App] resolving envelope:', envelope.dynamicBindingPathList);
    resolve(envelope, { authentication: auth }).then(({ data: resolved }) => {
      console.log('[App] resolved data:', resolved);
      setData(resolved);
    });
  }, [envelope, auth]);

  return (
    <div className="app">
      <div className="app__config">
        <DataPointConfiguration envelope={envelope} onChange={setEnvelope} />
      </div>
      <div className="app__widget">
        {envelope ? (
          <DataPoint
            config={envelope.uiConfig}
            data={data}
            onEvent={(e) => console.log('[Widget Event]', e)}
          />
        ) : (
          <div className="dp-widget dp-widget--empty">
            <span>Configure the widget to preview it.</span>
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## Console Logs to Expect

| Log | When | What it shows |
|---|---|---|
| `[App] resolving envelope:` | Every config change | `dynamicBindingPathList` array with `{ key, topic }` entries |
| `[App] resolved data:` | After resolveAndCompute returns | `DataEntry[]` with resolved values |
| `[DataPoint] config received` | Config prop changes | Raw `uiConfig`, topic string, sources |
| `[DataPoint] data received` | Data prop changes | Each entry + resolved variable value |
| `[DataPointConfiguration] envelope` | Any configurator change | Full envelope JSON |
| `[Widget Event]` | User interaction | `TIME_CHANGE`, `FILTER_CHANGE`, etc. |

---

## Rules

- `resolve()` is always called with the real bearer token — no dummy data
- Pass `config={envelope.uiConfig}` — never the whole envelope
- `data={[]}` when no envelope or no auth — widget shows loading skeleton
- `onEvent` logs to console in dev; real DataLayer handles it in production
- Auth token comes from `localStorage.bearer_token` — populated by SSO exchange via `?token=` query param
- `setData([])` is NOT called between config changes — widget holds last resolved value while re-fetching

---

## Checklist

- [ ] `auth` state initialised from `localStorage.getItem('bearer_token')`
- [ ] SSO token exchange runs once on mount via `?token=` query param
- [ ] `resolve()` called in `useEffect` on `[envelope, auth]` changes
- [ ] Widget receives `config={envelope.uiConfig}` — not the whole envelope
- [ ] `data={[]}` default when no envelope — widget skeleton shows correctly
- [ ] `onEvent` logs events to console
- [ ] App logs `dynamicBindingPathList` and resolved data on every config change
