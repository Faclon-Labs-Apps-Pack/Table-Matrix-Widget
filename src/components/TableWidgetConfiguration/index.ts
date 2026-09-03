import { createRoot, Root } from 'react-dom/client';
import React from 'react';
import { TableWidgetConfiguration } from './TableWidgetConfiguration';
import '@faclon-labs/design-sdk/styles.css';

const roots = new Map<string, Root>();

// Props pass through untouched: the configurator itself defaults its incoming
// uiConfig (withTableWidgetDefaults) — merging here too applied defaults twice
// and churned the config identity on every host update().

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
  root.render(React.createElement(TableWidgetConfiguration, props));
}

function update(containerId: string, props: any) {
  const root = roots.get(containerId);
  if (!root) return;
  root.render(React.createElement(TableWidgetConfiguration, props));
}

function unmount(containerId: string) {
  const root = roots.get(containerId);
  if (!root) return;
  root.unmount();
  roots.delete(containerId);
}

(window as any).ReactWidgets = (window as any).ReactWidgets ?? {};
(window as any).ReactWidgets['TableWidgetConfiguration'] = { mount, update, unmount };
