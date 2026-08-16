# Graph Structure

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** Nodes, edges, and history are all persisted in SQLite. See the [Status Glossary](../../status-glossary.md) for chip definitions.

The navigation graph captures:

- **Nodes**: Unique UI states identified by AutoMobile SDK navigation events + view hierarchy hashing
- **Edges**: Tool calls that cause navigation
- **History**: Sequence of screens visited

## Graph Structure

### Nodes

Each node is identified by:
```typescript
{
  screenId: string,        // Unique identifier
  screenName: string,      // Screen name
  title: string,           // Screen title/label
  signature: string,       // View hierarchy fingerprint
  timestamp: number        // First seen time
}
```

### Edges

Edges record the method of navigation in terms of UI interaction:
```typescript
{
  from: string,           // Source screen ID
  to: string,             // Destination screen ID
  trigger: {
    action: string,       // "tap", "swipe", etc.
    element: string,      // Element that triggered transition
    text: string          // Element text/description
  },
  count: number,          // Times this transition occurred
  avgDuration: number     // Average transition time
}
```

## Retention

The persisted graph accumulates cross-build/device/session data over time
(the `(app, build)` provenance observation rows, plus heavy assets like node
screenshots). A background pass bounds it with a tiered policy keyed on each
row's `last_seen_at` recency, running every 6 hours in the daemon.

The pass is **conservative** — the most-recently-seen build key per app (the
active context) is never age-deleted or orphan-swept, and its newest
observation is never evicted by the size cap:

- **Screenshots (short TTL)** — a node's stored screenshot pointer is cleared
  and the file unlinked once the node has not been seen for the screenshot TTL.
  The light node row survives.
- **Provenance / structure (long TTL)** — observation rows older than the
  structure TTL are pruned, and build keys left with no observations are swept.
- **Size cap (backstop)** — a per-app **and** a global budget on observation
  rows; when over budget the oldest rows by `last_seen_at` are evicted.

### Configuration

All thresholds are overridable via environment variables (positive integers;
an invalid value falls back to the default):

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTOMOBILE_NAV_RETENTION_SCREENSHOT_TTL_MS` | `604800000` (7 days) | Max age of a node screenshot before its pointer is cleared. |
| `AUTOMOBILE_NAV_RETENTION_STRUCTURE_TTL_MS` | `7776000000` (90 days) | Max age of an observation row before it is pruned. |
| `AUTOMOBILE_NAV_RETENTION_PER_APP_MAX_OBSERVATIONS` | `50000` | Max observation rows kept per app before the LRU cap evicts oldest. |
| `AUTOMOBILE_NAV_RETENTION_GLOBAL_MAX_OBSERVATIONS` | `500000` | Max observation rows kept across all apps. |
| `AUTOMOBILE_NAV_RETENTION_INTERVAL_MS` | `21600000` (6 hours) | How often the background retention pass runs. |
