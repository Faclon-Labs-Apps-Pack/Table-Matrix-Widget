import { useState, useEffect } from 'react';
import { TableWidget } from './components/TableWidget/TableWidget';
import { TableWidgetConfiguration } from './components/TableWidgetConfiguration/TableWidgetConfiguration';
import { TableWidgetEnvelope, DataEntry, WidgetEvent } from './iosense-sdk/types';
import { validateSSOToken } from './iosense-sdk/api';
import { resolve } from './iosense-sdk/mini-engine';
import '@faclon-labs/design-sdk/styles.css';
import './App.css';

export default function App() {
  const [envelope, setEnvelope] = useState<TableWidgetEnvelope | undefined>(undefined);
  const [data, setData] = useState<DataEntry[]>([]);
  const [auth, setAuth] = useState<string>(localStorage.getItem('bearer_token') ?? '');
  const [timeOverride, setTimeOverride] = useState<{ startTime: number; endTime: number } | undefined>(undefined);

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

  useEffect(() => {
    if (!envelope || !auth) return;
    console.log('[App] resolving envelope:', envelope.dynamicBindingPathList, 'override:', timeOverride);
    resolve(envelope, { authentication: auth, override: timeOverride }).then(({ data: resolved }) => {
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
    }
  }

  return (
    <div className="app">
      <div className="app__config">
        <TableWidgetConfiguration config={envelope} authentication={auth} onChange={setEnvelope} />
      </div>
      <div className="app__widget">
        {envelope ? (
          <div style={{ width: envelope.uiConfig.widgetWidth ?? 700, height: envelope.uiConfig.widgetHeight ?? 500 }}>
            <TableWidget config={envelope.uiConfig} data={data} onEvent={handleEvent} />
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
