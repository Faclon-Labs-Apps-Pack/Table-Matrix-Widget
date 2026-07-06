import { createRoot, Root } from 'react-dom/client';
import React from 'react';
import { TableWidget } from './TableWidget';
import { withTableWidgetDefaults } from '../../iosense-sdk/defaults';
import '@faclon-labs/design-sdk/styles.css';

const roots = new Map<string, Root>();

// Patch defaults onto whatever the host passes the moment the widget mounts /
// updates, so a freshly-added instance with a partial/absent uiConfig still gets
// every required key (e.g. `config.style.card`) before React renders.
function withDefaults(props: any) {
  return { ...props, config: withTableWidgetDefaults(props?.config) };
}

function mount(containerId: string, props: any) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.setAttribute('data-zone-ignore', '');

  if (roots.has(containerId)) {
    roots.get(containerId)!.unmount();
    roots.delete(containerId);
  }

  const root = createRoot(container);
  roots.set(containerId, root);
  root.render(React.createElement(TableWidget, withDefaults(props)));
}

function update(containerId: string, props: any) {
  const root = roots.get(containerId);
  if (!root) return;
  root.render(React.createElement(TableWidget, withDefaults(props)));
}

function unmount(containerId: string) {
  const root = roots.get(containerId);
  if (!root) return;
  root.unmount();
  roots.delete(containerId);
}

(window as any).ReactWidgets = (window as any).ReactWidgets ?? {};
(window as any).ReactWidgets['TableWidget'] = { mount, update, unmount };
