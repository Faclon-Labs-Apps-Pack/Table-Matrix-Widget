---
name: widget-bindable-fields
description: >
  Use this skill whenever generating or updating a Widget Configurator. This skill is MANDATORY whenever any configurator is created or modified — it
  ensures the configurator correctly identifies bindable uiConfig fields, renders a plain
  text input for them (where user types a UNS topic path directly), and writes
  dynamicBindingPathList on save. Triggers include: "create a widget configurator", "add
  variable binding to a field", "update configurator", "add dynamicBindingPathList", "make
  this field accept a variable", or any task where a configurator saves widget config. Never
  generate a configurator without reading this skill first. This pairs with the
  widget-datalayer-architecture skill — both must be followed together.
---

# Widget Bindable Fields Skill

## Core Principle — Read This First

> **`{{}}` is the bindable field marker. The configurator scans uiConfig for `{{topic}}` strings at save time and builds `dynamicBindingPathList` from them — no runtime scanning ever.**

Every IoSense widget configurator must:
1. Identify which `uiConfig` fields are **bindable** (can accept a `{{UNS-topic}}` value)
2. Render a **plain text input** for those fields — user types `{{iosense/plant1/.../lastdp}}` directly
3. On save, walk the `uiConfig`, find every field matching `{{...}}`, extract the topic inside, and write `{ key, topic }` into `dynamicBindingPathList`

This is what powers the mini-engine's `resolveAndCompute` call. Without `dynamicBindingPathList`, the engine has no topics to fetch.

---

## 1. What is a Bindable Field?

A bindable field is any `uiConfig` field whose value comes from a live device/sensor reading via the UNS (Unified Namespace).

**Always bindable — these fields must always support UNS topic input:**

| Field type | Examples |
|---|---|
| Primary data value | `variable`, `series[n].dataSource` |
| Numeric thresholds driven by data | `gaugeConfig.min`, `gaugeConfig.max`, `plotlines[n].value` |
| Display labels driven by data | `gaugeConfig.title`, `series[n].name` |

**Never bindable — these fields are structural, not data-driven:**

| Field type | Examples |
|---|---|
| Chart type selectors | `chartType: "gauge"` |
| Style tokens | `style.card.borderRadius`, `style.chart.fontSize` |
| Boolean toggles | `style.card.wrapInCard`, `hideToggle` |
| IDs and keys | `_id`, `series[n].id` |
| Static display-only strings | `unit`, `label` (unless driven by live data) |

---

## 2. How Bindable Fields Are Rendered

Bindable fields use a **plain `<input type="text">`** or the design-sdk `TextInput`. The user types the UNS topic path wrapped in `{{}}`.

> **Prefer `UNSTreePicker` over `TextInput` for all bindable fields.** `UNSTreePicker` (from `@faclon-labs/design-sdk/UNSTreePicker`, design-sdk 0.7+) browses workspace → nodes lazily and commits `{{uns:wsId://path}}` directly, so no resolve step is needed. It supersedes `UNSPathInput`, which required the whole tree upfront and emitted display names. Only use bare `TextInput` for fields where UNS browsing is not appropriate. The `:op` aggregation variants are the selectable leaves, never the bare Tag. See **DevHarness.md → UNS Injection Props** for the host contract.

The placeholder must always show an example `{{topic}}` value.

```tsx
// ✅ CORRECT — bindable field, user types {{topic}} syntax
<TextInput
  label="Variable"
  placeholder="e.g. {{uns:wsId://iosense/plant1/voltage:last}} or type / to browse"
  value={variable}
  onChange={({ value }) => setVariable(value)}
/>

// ❌ NOT bindable — structural, use select
<select value={chartType} onChange={e => setChartType(e.target.value)}>
  <option value="gauge">Gauge</option>
</select>
```

**State type for bindable fields is always `string`** — the value may be `""`, a static string, or `"{{iosense/...}}"`:

```tsx
// ✅ CORRECT — always string state for bindable fields
const [variable, setVariable] = useState<string>('');
const [minTopic, setMinTopic] = useState<string>('');
```

---

## 3. Writing `dynamicBindingPathList` on Save — THE CRITICAL RULE

When the configurator saves, it must walk the `uiConfig` it just built, find every field matching `{{...}}`, extract the topic inside (strip the braces), and write `{ key, topic }` entries into `dynamicBindingPathList`.

```typescript
const VARIABLE_REGEX = /^\{\{(.+)\}\}$/;

function buildDynamicBindingPathList(uiConfig: UIConfig): Array<{ key: string; topic: string }> {
  const paths: Array<{ key: string; topic: string }> = [];

  function walk(obj: any, currentPath: string): void {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'string') {
      const match = VARIABLE_REGEX.exec(obj.trim());
      if (match) paths.push({ key: currentPath, topic: match[1] }); // match[1] = topic without {{ }}
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }
    if (typeof obj === 'object') {
      Object.entries(obj).forEach(([key, val]) => {
        walk(val, currentPath ? `${currentPath}.${key}` : key);
      });
    }
  }

  walk(uiConfig, '');
  return paths;
}

// Usage in configurator's save handler
function buildEnvelope(existing, variable, sources, style): WidgetEnvelope {
  const uiConfig = { variable, sources, style };
  return {
    _id: existing?._id ?? `widget_${Date.now()}`,
    type: 'WidgetType',
    general: existing?.general ?? { title: '' },
    uiConfig,
    dynamicBindingPathList: buildDynamicBindingPathList(uiConfig),
  };
}
```

### What the output looks like

```typescript
// User typed "{{iosense/plant1/.../voltage/lastdp}}" in the variable field
uiConfig.variable = "{{uns:ws_abc123://iosense/plant1/voltage:last}}"

// buildDynamicBindingPathList extracts the topic (strips {{ }})
dynamicBindingPathList: [
  { key: "sources[0].unsPath", topic: "uns:ws_abc123://iosense/plant1/voltage:last" },
]

// Static fields (no {{}}) are NOT in the list
// sources[0].label = "Voltage"  → not included (no {{}} wrapper)
// style.card.wrapInCard = true  → not included (boolean, never bindable)
```

---

## 4. Complete Configurator Save Contract

> Full envelope interface: see **Envelope.md §2** — `WidgetConfigEnvelope`.

**Rules:**
- `dynamicBindingPathList` is **always present** — even if empty array `[]` when no `{{}}` bindings
- Each entry has **both `key` and `topic`**: `key` is the uiConfig dot-path, `topic` is the UNS topic **without** `{{}}`
- It is built by scanning `uiConfig` for `{{...}}` patterns at save time — `buildDynamicBindingPathList(uiConfig)`
- It contains **only fields with `{{}}` wrapper** — static string values are excluded
- Paths use **bracket notation for arrays**: `series[0].dataSource` not `series.0.dataSource`
- `apiConfig` does **not** exist in this envelope — all data resolution goes through `resolveAndCompute`

---

## 5. How Widget Consumes the `data` Prop

The mini-engine reads `dynamicBindingPathList`, calls `resolveAndCompute` with the topics, gets back `{ key, value }` pairs, and passes them as `DataEntry[]` to the widget.

```typescript
// uiConfig saved by configurator — {{}} wrapper intact
config.variable = "{{iosense/plant1/.../voltage/lastdp}}"

// dynamicBindingPathList extracted from uiConfig
dynamicBindingPathList = [
  { key: "variable", topic: "iosense/plant1/.../voltage/lastdp" },  // topic = stripped {{}}
]

// mini-engine resolves → widget's data prop
data = [
  { key: "variable", value: "436" },  // resolved from UNS
]
```

Widget always reads bindable values via `getValue()` — never directly from `config`:

```typescript
function getValue(key: string, config: any, data: DataEntry[]): any {
  const entry = data.find(d => d.key === key);
  return entry !== undefined ? entry.value : getValueAtPath(config, key);
}

function getValueAtPath(obj: any, path: string): any {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .reduce((acc, k) => acc?.[k], obj);
}

// Usage in widget
const rawValue = getValue('variable', config, data);   // "436" from data
const minVal   = getValue('gaugeConfig.min', config, data);

// Loading state — data is [] until mini-engine resolves first binding
if (data.length === 0) return <WidgetSkeleton config={config} />;
```

---

## 6. Concrete Example — DataPoint Widget Configurator

```tsx
const VARIABLE_REGEX = /^\{\{(.+)\}\}$/;

function buildDynamicBindingPathList(uiConfig) {
  const paths = [];
  function walk(obj, path) {
    if (typeof obj === 'string') {
      const match = VARIABLE_REGEX.exec(obj.trim());
      if (match) paths.push({ key: path, topic: match[1] });
    } else if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (obj && typeof obj === 'object') {
      Object.entries(obj).forEach(([k, v]) => walk(v, path ? `${path}.${k}` : k));
    }
  }
  walk(uiConfig, '');
  return paths;
}

const DataPointConfiguration = () => {
  const [variable, setVariable] = useState<string>('');  // user types {{topic}} here

  function buildEnvelope(): WidgetConfigEnvelope {
    const uiConfig = { variable, sources, style };
    return {
      _id: existing?._id ?? `dp_${Date.now()}`,
      type: 'DataPoint',
      general: { title: '' },
      uiConfig,
      dynamicBindingPathList: buildDynamicBindingPathList(uiConfig),
    };
  }

  return (
    <TextInput
      label="Variable"
      placeholder="e.g. {{uns:wsId://iosense/plant1/voltage:last}} or type / to browse"
      value={variable}
      onChange={({ value }) => { setVariable(value); emit(value, sources, style); }}
    />
  );
};
```

---

## 7. Checklist Before Submitting Any Configurator

- [ ] Every bindable field is a plain text input — user types `{{iosense/...}}` syntax
- [ ] Bindable field state is typed as `string`
- [ ] Bindable field placeholder shows an example `{{topic}}` value
- [ ] Non-bindable fields use appropriate input: `<select>` for chartType, color picker for colors, toggle for booleans
- [ ] `onSave()` calls `buildDynamicBindingPathList(uiConfig)` — scanner finds `{{}}` and extracts topics
- [ ] Each entry in `dynamicBindingPathList` uses `{ key, topic }` — NOT `{ key, value }`
- [ ] `topic` in `dynamicBindingPathList` has NO `{{}}` braces — they are stripped by the scanner
- [ ] Static values (no `{{}}`) are excluded from `dynamicBindingPathList`
- [ ] `dynamicBindingPathList` is always present — even `[]` when no bindings
- [ ] `apiConfig` is NOT in the envelope — never add it
- [ ] Configurator emits envelope with: `_id`, `type`, `general`, `uiConfig`, `dynamicBindingPathList`

---

## 8. What NOT to Do

```tsx
// ❌ WRONG — storing value instead of topic in dynamicBindingPathList (old architecture)
paths.push({ key: currentPath, value: obj.trim() });  // ← wrong
paths.push({ key: currentPath, topic: match[1] });    // ← correct

// ❌ WRONG — using {{API1.data}} style references (old architecture — API name, not a topic)
const [variable, setVariable] = useState('{{API1.data}}');

// ❌ WRONG — topic still has {{ }} braces
{ key: "sources[0].unsPath", topic: "{{uns:ws_abc://iosense/plant1/voltage:last}}" }   // ← braces not stripped
{ key: "sources[0].unsPath", topic: "uns:ws_abc://iosense/plant1/voltage:last" }       // ← correct

// ❌ WRONG — workspace name format (resolveUNSValue was not called or returned unchanged)
{ key: "sources[0].unsPath", topic: "Akash - Test/Voltage/:last" }  // ← display name leaked through

// ✅ CORRECT — workspace ID format
{ key: "sources[0].unsPath", topic: "uns:ws_abc123://iosense/plant1/voltage:last" }

// ❌ WRONG — apiConfig in envelope
return { timeConfig, apiConfig, uiConfig, dynamicBindingPathList };  // ← apiConfig must not exist

// ❌ WRONG — dot notation for array paths
{ key: "series.0.dataSource" }   // ← wrong
{ key: "series[0].dataSource" }  // ← correct

// ✅ CORRECT
const [variable, setVariable] = useState<string>('');

<TextInput
  placeholder="e.g. {{iosense/plant1/.../lastdp}}"
  value={variable}
  onChange={({ value }) => setVariable(value)}
/>

// buildDynamicBindingPathList scans uiConfig:
// finds: variable = "{{iosense/plant1/.../lastdp}}"
// extracts: match[1] = "iosense/plant1/.../lastdp"  (no braces)
// pushes: { key: "variable", topic: "iosense/plant1/.../lastdp" }
```
