import { useEffect } from 'react';

// ---------------------------------------------------------------------------
// Portal layers vs. host panels that close on outside click.
//
// UNSTreePicker's dropdown portals to document.body — physically outside the
// container the host mounted us into. The host's config panel treats a click in
// that popover as an outside click and closes, so selecting an option shuts the
// panel instead of committing the topic.
//
// The host opts a subtree out via `data-zone-ignore`. index.ts stamps our mount
// container, but a portaled layer never lives inside it, so we stamp floating
// layers as they appear. One MutationObserver on document.body, refcounted so
// several mounted components share it.
// ---------------------------------------------------------------------------

/** Floating layers that must be exempt from the host's outside-click handling. */
const PORTAL_SELECTORS = [
  '.fds-uns-tree-picker__popover',
  '.fds-uns-path-input__popover',   // legacy component, still portals the same way
  '.fds-dropdown-menu__wrapper',
  '.fds-popover',
  '.fds-modal',
];

const SELECTOR = PORTAL_SELECTORS.join(',');

function stamp(root: ParentNode) {
  if (root instanceof Element && root.matches(SELECTOR)) {
    root.setAttribute('data-zone-ignore', '');
  }
  root.querySelectorAll?.(SELECTOR).forEach((el) => el.setAttribute('data-zone-ignore', ''));
}

let refCount = 0;
let observer: MutationObserver | null = null;

function acquire() {
  refCount += 1;
  if (observer) return;
  stamp(document.body);                       // catch layers already mounted
  observer = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) stamp(node as Element);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function release() {
  refCount -= 1;
  if (refCount > 0 || !observer) return;
  observer.disconnect();
  observer = null;
}

/**
 * Stamp `data-zone-ignore` on floating layers for as long as this component is
 * mounted, so clicking inside a portaled dropdown does not read as an outside
 * click to the host panel.
 */
export function useZoneIgnorePortals() {
  useEffect(() => {
    acquire();
    return release;
  }, []);
}
