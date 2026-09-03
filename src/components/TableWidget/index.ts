import { createRoot, Root } from 'react-dom/client';
import React from 'react';
import { TableWidget } from './TableWidget';
import '@faclon-labs/design-sdk/styles.css';

const roots = new Map<string, Root>();

// Props pass through untouched: TableWidget itself deep-merges its config over
// defaults (withTableWidgetDefaults, memoized on the config identity). Merging
// here as well applied defaults twice and handed the component a fresh config
// object on every host update(), defeating its useMemo/effect guards.

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
  root.render(React.createElement(TableWidget, props));
}

function update(containerId: string, props: any) {
  const root = roots.get(containerId);
  if (!root) return;
  root.render(React.createElement(TableWidget, props));
}

function unmount(containerId: string) {
  const root = roots.get(containerId);
  if (!root) return;
  root.unmount();
  roots.delete(containerId);
}

(window as any).ReactWidgets = (window as any).ReactWidgets ?? {};
(window as any).ReactWidgets['TableWidget'] = { mount, update, unmount };
