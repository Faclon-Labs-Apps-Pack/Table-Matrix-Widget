import { useState, useEffect, useRef } from 'react';
import { TableWidget } from './components/TableWidget/TableWidget';
import { TableWidgetConfiguration } from './components/TableWidgetConfiguration/TableWidgetConfiguration';
import { TableWidgetEnvelope, DataEntry, WidgetEvent } from './iosense-sdk/types';
import { validateSSOToken } from './iosense-sdk/api';
import { resolve } from './iosense-sdk/mini-engine';
import { buildDynamicBindingPathList } from './iosense-sdk/bindings';
import { useUNSTree } from './iosense-sdk/useUNSTree';
import '@faclon-labs/design-sdk/styles.css';
import './App.css';

export default function App() {
  const [envelope, setEnvelope] = useState<TableWidgetEnvelope | undefined>(undefined);
  const [data, setData] = useState<DataEntry[]>([]);
  const [auth, setAuth] = useState<string>(localStorage.getItem('bearer_token') ?? '');
  const [timeOverride, setTimeOverride] = useState<{ startTime: number; endTime: number } | undefined>(undefined);

  // UNS topic browser for the widget's on-canvas Cell Config popover (dev-harness
  // side — production/Angular injects equivalents). Same hook the configurator uses.
  const uns = useUNSTree(auth);

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
      // Widget edited a cell binding on the canvas — rebuild the binding index
      // and persist the envelope; the re-resolve effect below fetches new data.
      const { uiConfig } = event.payload;
      setEnvelope((prev) =>
        prev ? { ...prev, uiConfig, dynamicBindingPathList: buildDynamicBindingPathList(uiConfig) } : prev,
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
              unsTree={uns.unsTree}
              isLoadingTree={uns.isLoadingTree}
              onLoadWorkspaces={uns.loadWorkspaces}
              resolveUNSValue={uns.resolveUNSValue}
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
