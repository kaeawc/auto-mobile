# Observe

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** Fully implemented. The tiered observation pipeline (Accessibility Service → uiautomator fallback with perceptual hash caching) is active. WebSocket freshness after interactions with a 5-second timeout is implemented. See the [Status Glossary](../../status-glossary.md) for chip definitions.

## UIAutomator Fallback

- CtrlProxy's accessibility hierarchy provides screen dimensions and typed window insets. On Android R and later this includes visible and stable system bars, cutouts, gesture insets, mandatory gesture insets, and tappable-element insets; older devices use named Android resource fallbacks.
- `insets.displayCutoutInfo` separates a physical cutout's identity from aggregate `displayCutout` edge insets. Android obtains bounds from `DisplayCutout.boundingRects` in the hierarchy's physical-pixel screen coordinates and captured rotation, reports `none` when the API reports no cutout, and conservatively classifies one broad edge obstruction as `notch` or one small inset obstruction as `hole_punch`. Multiple, malformed, unavailable, rotation-unstable, and ambiguous small edge-connected results are `unknown`; it never infers `dynamic_island` from device hardware.
- The legacy observation `dumpsys window` and `wm size` collectors have been removed.
- In parallel, the observer collects rotation, wakefulness, and back stack while view hierarchy is fetched separately.
- Active-window attribution is normally derived from CtrlProxy hierarchy metadata. Before CtrlProxy supplies either foreground-activity or hierarchy-package metadata, observation makes one narrow `dumpsys window` bootstrap fallback; it does not use legacy dumpsys collectors for inset or screen-size data.
- View Hierarchy
  - The best and fastest option is fetching it via the pre-installed and enabled accessibility service. This is never
    cached because that would introduce lag.

    ```mermaid
    flowchart LR
    A["Observe()"] --> B{"installed?"};
    B -->|"✅"| C{"running?"};
    B -->|"❌"| E["caching system"];
    C -->|"✅"| D["cat vh.json"];
    C -->|"❌"| E["uiautomator dump"];
    D --> I["Return"]
    E --> I;
    classDef decision fill:#CC2200,stroke-width:0px,color:white;
    classDef logic fill:#525FE1,stroke-width:0px,color:white;
    classDef result stroke-width:0px;
    class A,G,I result;
    class D,E,H logic;
    class B,C,F decision;
    ```

  - Latest iteration (WebSocket freshness)
    - After interactions, the observer waits for a WebSocket push from the accessibility service to deliver a fresh
      view hierarchy.
    - The wait uses a 5-second timeout. If no push arrives, the server falls back to a synchronous request to fetch
      the latest view hierarchy.
    - Debouncing is applied so rapid consecutive interactions do not trigger multiple overlapping fetches. The most
      recent pending request wins, and stale requests are dropped.

  - If the accessibility service is not installed or not enabled yet, we fall back to `uiautomator` output that is
    cached based on a perceptual hash plus pixel matching within a tolerance threshold.

  - Per-machine cache contract: nav-screenshot caches are local to the machine that produced them. The active image
    backend affects resize kernels and decoded pixels (`sharp` on macOS/Linux, `jimp` on Windows), so pHash and
    pixelmatch results can differ for the same screenshot across platforms. These caches are not portable across platforms;
    do not copy them between machines or platforms. Let each machine rebuild its own cache.

    ```mermaid
    flowchart LR
    A["Observe()"] --> B["Screenshot<br/>+perceptual hash"];
    B --> C{"hash<br/>match?"};
    C -->|"✅"| D["pixelmatch"];
    C -->|"❌"| E["uiautomator dump"];
    D --> F{"within tolerance?"};
    F -->|"✅"| G["Return"];
    F -->|"❌"| E;
    E --> H["Cache"];
    H --> I["Return New Hierarchy"];
    classDef decision fill:#CC2200,stroke-width:0px,color:white;
    classDef logic fill:#525FE1,stroke-width:0px,color:white;
    classDef result stroke-width:0px;
    class A,G,I result;
    class D,E,H logic;
    class B,C,F decision;
    ```

See [Observation Overview](../../mcp/observe/index.md) for the full list of collected fields and error handling.
