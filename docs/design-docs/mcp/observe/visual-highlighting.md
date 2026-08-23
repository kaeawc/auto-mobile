# Visual Highlighting

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd> <kbd>🤖 Android</kbd> <kbd>🍎 iOS</kbd>

Expose visual highlight overlays (box, circle, or path) as an MCP tool for debugging UI layout and state.

> See the [Status Glossary](../../status-glossary.md) for chip definitions.

## MCP Tool

- `highlight`
  - Params:
    - `shape`: required highlight shape definition
    - Optional `description`
    - `platform`: `android` | `ios`
    - Optional device targeting: `deviceId`, `device`, `sessionUuid`
    - Optional `timeoutMs` override
  - Returns: success flag and optional error message.
  - iOS app-under-test rendering: requires the AutoMobileSDK in-app bridge, which renders the overlay in the app process. iOS cannot draw an overlay into another app from the test runner (the runner's window only composites while the runner itself is foreground, which never happens during automation), so highlighting a foreground app without the SDK returns an actionable error.
  - Screenshot-derived bounds with `sourceWidth`/`sourceHeight` are scaled to the target overlay size before drawing.
  - Highlights auto-remove after their animation completes.

## Examples

### Highlight element during bug report

```javascript
await highlight({
  shape: {
    type: "box",
    bounds: { x: 100, y: 200, width: 300, height: 150 },
    style: { strokeColor: "#FF0000", strokeWidth: 3 },
  },
  platform: "ios",
});
```

### Generate bug report with highlights

```javascript
await bugReport({
  platform: "android",
  includeScreenshot: true,
  highlights: [
    {
      description: "Expected button location",
      shape: {
        type: "box",
        bounds: { x: 120, y: 280, width: 220, height: 90 },
        style: { strokeColor: "#FF0000", strokeWidth: 6 },
      },
    },
  ],
  includeHighlightsInScreenshot: true,
});
```

### Multiple highlights for comparison

```javascript
await highlight({
  shape: {
    type: "circle",
    bounds: { x: 200, y: 300, width: 50, height: 50 },
    style: { strokeColor: "#00FF00", strokeWidth: 3 },
  },
  platform: "ios",
});

await highlight({
  shape: {
    type: "circle",
    bounds: { x: 210, y: 310, width: 50, height: 50 },
    style: { strokeColor: "#FF0000", strokeWidth: 3 },
  },
  platform: "android",
});
```

## Response Format

```typescript
{
  success: boolean;
  error?: string;
}
```
