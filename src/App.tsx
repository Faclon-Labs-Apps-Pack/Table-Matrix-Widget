import { useState, useEffect, useRef } from 'react';
import { TableWidget } from './components/TableWidget/TableWidget';
import { TableWidgetConfiguration } from './components/TableWidgetConfiguration/TableWidgetConfiguration';
import { TableWidgetEnvelope, DataEntry, WidgetEvent } from './iosense-sdk/types';
import { validateSSOToken } from './iosense-sdk/api';
import { resolve } from './iosense-sdk/mini-engine';
import { buildDynamicBindingPathList } from './iosense-sdk/bindings';
import { useUNSTreePicker } from './iosense-sdk/useUNSTreePicker';
import '@faclon-labs/design-sdk/styles.css';
import './App.css';

export default function App() {
  const [envelope, setEnvelope] = useState<TableWidgetEnvelope | undefined>(undefined);
  const [data, setData] = useState<DataEntry[]>([]);
  const [auth, setAuth] = useState<string>(localStorage.getItem('bearer_token') ?? '');
  const [timeOverride, setTimeOverride] = useState<{ startTime: number; endTime: number } | undefined>(undefined);

  // UNS topic browser for the widget's on-canvas Cell Config popover (dev-harness
  // side — production/Angular injects equivalents). Same hook the configurator uses.
  const uns = useUNSTreePicker(auth);

  // Eager-load the workspace list: the widget's picker calls its own internal
  // hook's loadWorkspaces on open, which is a no-op when the host injects the
  // UNS source (as this harness does) — without this the injected list stays
  // empty until the configurator's picker happens to be opened first.
  const loadWorkspacesRef = useRef(uns.loadWorkspaces);
  loadWorkspacesRef.current = uns.loadWorkspaces;
  useEffect(() => {
    if (auth) loadWorkspacesRef.current();
  }, [auth]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get('token');
    if (ssoToken && !auth) {
      validateSSOToken(ssoToken)
        .then((jwt) => {
          if (jwt) {
            localStorage.setItem('bearer_token', jwt);
            setAuth(jwt);
            const url = new URL(window.location.href);
            url.searchParams.delete('token');
            window.history.replaceState({}, '', url.toString());
          }
        })
        .catch(console.error);
    }
  }, []);

  // Most configurator edits (style, filter config, title, layout) never touch
  // a UNS binding — re-running resolveAndCompute for those is a wasted network
  // round-trip that's the main source of visible widget repaint lag, since the
  // widget's `config` prop already updates instantly regardless. Skip the
  // fetch entirely when the actual inputs to resolve() (bindings + time
  // window) haven't changed since the last resolve.
  const lastResolvedSignatureRef = useRef<string | null>(null);
  // Guards against a slower, older request resolving after a newer one and
  // clobbering `data` with stale values — only the most recent request wins.
  const resolveRequestIdRef = useRef(0);

  useEffect(() => {
    if (!envelope || !auth) return;

    const signature = JSON.stringify({
      bindings: envelope.dynamicBindingPathList,
      timeConfig: envelope.timeConfig ?? null,
      override: timeOverride ?? null,
    });
    if (signature === lastResolvedSignatureRef.current) return;
    lastResolvedSignatureRef.current = signature;

    const requestId = ++resolveRequestIdRef.current;
    console.log('[App] resolving envelope:', envelope.dynamicBindingPathList, 'override:', timeOverride);
    resolve(envelope, { authentication: auth, override: timeOverride }).then(({ data: resolved }) => {
      if (requestId !== resolveRequestIdRef.current) return; // superseded by a newer resolve
      console.log('[App] resolved data:', resolved);
      setData(resolved);
    });
  }, [envelope, auth, timeOverride]);

  function handleEvent(event: WidgetEvent) {
    console.log('[Widget Event]', event);
    if (event.type === 'TIME_CHANGE') {
      setTimeOverride({
        startTime: Number(event.payload.startTime),
        endTime: Number(event.payload.endTime),
      });
    } else if (event.type === 'CONFIG_CHANGE') {
      // Widget edited config on the canvas. The payload carries the rebuilt
      // binding index (the widget enforces the list-matches-uiConfig
      // invariant itself); a host can persist the payload verbatim. The
      // rebuild fallback is only for events from older widget builds.
      const { uiConfig, dynamicBindingPathList } = event.payload;
      setEnvelope((prev) =>
        prev
          ? { ...prev, uiConfig, dynamicBindingPathList: dynamicBindingPathList ?? buildDynamicBindingPathList(uiConfig) }
          : prev,
      );
    }
  }

  return (
    <div className="app">
      <div className="app__config">
        <TableWidgetConfiguration
          config={envelope}
          authentication={auth}
          editMode={!!envelope}
          onBack={() => console.log('[App] onBack')}
          onChange={setEnvelope}
        />
      </div>
      <div className="app__widget">
        {envelope ? (
          <div style={{ width: envelope.uiConfig.widgetWidth ?? 700, height: envelope.uiConfig.widgetHeight ?? 500 }}>
            <TableWidget
              config={envelope.uiConfig}
              data={data}
              onEvent={handleEvent}
              editable
              unsWorkspaces={uns.workspaces}
              isLoadingWorkspaces={uns.isLoadingWorkspaces}
              loadUnsChildren={uns.loadChildren}
              searchUnsNodes={uns.searchNodes}
            />
          </div>
        ) : (
          <div className="app__empty">
            <p className="BodyMediumRegular">Configure the widget in the left panel to preview it here.</p>
          </div>
        )}
      </div>
    </div>
  );
}
