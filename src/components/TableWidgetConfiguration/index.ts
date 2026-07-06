import { createRoot, Root } from 'react-dom/client';
import React from 'react';
import { TableWidgetConfiguration } from './TableWidgetConfiguration';
import { withTableWidgetDefaults } from '../../iosense-sdk/defaults';
import '@faclon-labs/design-sdk/styles.css';

const roots = new Map<string, Root>();

// When an existing envelope is passed, patch its uiConfig with defaults so a
// stored config missing keys still pre-populates the form completely. An absent
// envelope (brand-new widget) is left as-is — the panel shows the default form.
function withDefaults(props: any) {
  if (!props?.config) return props;
  return {
    ...props,
    config: { ...props.config, uiConfig: withTableWidgetDefaults(props.config.uiConfig) },
  };
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
  root.render(React.createElement(TableWidgetConfiguration, withDefaults(props)));
}

function update(containerId: string, props: any) {
  const root = roots.get(containerId);
  if (!root) return;
  root.render(React.createElement(TableWidgetConfiguration, withDefaults(props)));
}

function unmount(containerId: string) {
  const root = roots.get(containerId);
  if (!root) return;
  root.unmount();
  roots.delete(containerId);
}

(window as any).ReactWidgets = (window as any).ReactWidgets ?? {};
(window as any).ReactWidgets['TableWidgetConfiguration'] = { mount, update, unmount };
