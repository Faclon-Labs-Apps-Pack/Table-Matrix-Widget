# IOsense Widget — Architecture Rules

Read the four skill files below **before touching any widget code**. They are the source of truth.

| Skill file | What it covers |
|---|---|
| `.claude/skills/Envelope.md` | Widget/configurator/mini-engine contract, envelope shape, DO/DON'T checklist |
| `.claude/skills/Bindable.md` | How `{{topic}}` bindings work, `buildDynamicBindingPathList` implementation |
| `.claude/skills/MiniEngine.md` | `resolve()` data pipeline, `resolveAndCompute` API, DataEntry contract |
| `.claude/skills/DevHarness.md` | `App.tsx` wiring, auth flow, console logs to expect |

---

## Non-Negotiable Rules

1. **Widget never fetches data** — all data arrives through the `data: DataEntry[]` prop from the mini-engine
2. **Envelope shape**: `{ _id, type, general, uiConfig, dynamicBindingPathList }` — **no `apiConfig`**
3. **Configurator always calls `buildDynamicBindingPathList(uiConfig)`** before emitting via `onChange()`
4. **One resolveAndCompute call** covers all bindings — no per-field fetch loops
5. **All UI uses `@faclon-labs/design-sdk`** components and CSS tokens — no custom components, no hardcoded colors or spacing

---

## Starting a New Widget

1. Run `./init-widget.sh YourWidgetName` — renames all `WidgetTemplate` placeholders
2. Add widget-specific types to `src/iosense-sdk/types.ts`
3. Implement the configurator in `src/components/YourWidgetNameConfiguration/`
4. Implement the widget renderer in `src/components/YourWidgetName/`
5. Run `npm start` — dev harness shows live preview at `http://localhost:3000`
6. Authenticate once: visit `http://localhost:3000/?token=<SSO_TOKEN>`

---

## Configurator Overlay Pattern

Use this pattern whenever a configurator needs an "add / edit" modal (e.g. Add Data Source, Add Alert, Add Rule). No need to re-explain it — follow this recipe exactly.

### 1. Ref + position state

Attach a `ref` to the root configurator `<div>` and compute the modal position when the trigger is clicked:

```tsx
const configRef = useRef<HTMLDivElement>(null);
const [modalX, setModalX] = useState(0);
const [modalY, setModalY] = useState(0);

function openModal(e: React.MouseEvent) {
  e.stopPropagation();                              // prevent parent handlers (e.g. accordion)
  if (configRef.current) {
    const rect = configRef.current.getBoundingClientRect();
    setModalX(rect.right + 30);                     // 30 px gap to the right of config panel
    setModalY(rect.top);                            // top-aligned with config panel
  }
  setIsOpen(true);
}
```

Apply the ref to the configurator root:
```tsx
<div className="dp-config" ref={configRef}>
```

### 2. Modal JSX

```tsx
<Modal
  isOpen={isOpen}
  positionX={modalX}
  positionY={modalY}
  className="dp-<name>-modal"                      // scoped class for width override
  onClose={handleClose}
  header={<ModalHeader title="Add …" onClose={handleClose} />}
  footer={
    <ModalFooter
      primaryAction={<Button variant="Primary" label="Add …" onClick={handleSubmit} />}
    />
  }
>
  <ModalBody>
    <div className="dp-<name>-modal__body">
      {/* form fields stacked flex-column */}
    </div>
  </ModalBody>
</Modal>
```

### 3. CSS (width + body layout)

`Modal.size` only accepts Small/Medium/Large — override width via the scoped class:

```css
.dp-<name>-modal .fds-modal {
  width: 280px;                                     /* or whatever width is required */
}

.dp-<name>-modal__body {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-04, 12px);
}
```

### 4. Imports

```tsx
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@faclon-labs/design-sdk/Modal';
import { Button } from '@faclon-labs/design-sdk/Button';
```

### Rules

- `positionX` / `positionY` are viewport-absolute px values — always derive from `getBoundingClientRect()`. Since design-sdk 0.7.30, providing both automatically makes the backdrop transparent (the old `transparent: true` cast is gone from the runtime — do not use it).
- `e.stopPropagation()` on every trigger that lives inside an accordion header or other click handler.
- Reset all form state in `handleClose` **and** at the end of `handleSubmit`.
