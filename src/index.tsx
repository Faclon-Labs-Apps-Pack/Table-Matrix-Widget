import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// Dev-only: this entry is built in development mode only (production builds the
// per-component index.ts files), so the harness stands in for the host and loads
// the design-sdk sheet exactly once. Widget bundles ship no SDK CSS of their own
// — see src/iosense-sdk/hostProvidedStyles.css.
import '@faclon-labs/design-sdk/styles.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
