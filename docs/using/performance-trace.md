# Performance traces

| Tool                             | What it does                      | Platforms                                                                                                                                                   | Needs                             |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 📈 <code>performanceTrace</code> | Record a native performance trace | <span class="tool-platforms"><span role="img" aria-label="Android" title="Android">🤖</span> <span role="img" aria-label="iOS" title="iOS">🍎</span></span> | <span class="tool-needs">—</span> |

`performanceTrace` records an Instruments trace (`xctrace`) on iOS or a Perfetto trace on Android.
Call it with `action: "start"` and a `template` to begin recording. It returns a `traceId`. Call
it with `action: "stop"` and that `traceId` to stop the recorder and get the artifact path and a
summary.

## Android: record chosen Perfetto categories

On Android, `start` can take `categories` instead of a `template`. Pass exactly one of the two;
passing both or neither is refused.

| Parameter    | Values                                                                              | Default |
| ------------ | ----------------------------------------------------------------------------------- | ------- |
| `categories` | One or more of `sched`, `gfx`, `view`, `am`, `wm`, `binder_driver`, `memory`, `app` | —       |
| `bufferMb`   | Perfetto ring buffer size, 1 to 256 MB; only valid with `categories`                | 32      |

- `app` records the app's own atrace tags and needs an `appId`. Passing an `appId` adds `app` to
  the categories.
- `timeLimitMs` bounds the recording on the device, as it does for a template.
- The start and stop results list the resolved `categories` and `bufferMb`.
- A categories trace has no summary: `stop` returns the `.perfetto-trace` artifact path, an empty
  `summary` and a warning. Open the artifact in the Perfetto UI or `trace_processor`.
- iOS refuses `categories`; use a `template` there.

## iOS: unsupported Xcode and simulator combinations

With some Xcode versions, `xctrace` never finishes saving a trace on some simulator runtimes.
Stopping such a recording would wait until the stop timeout and return a trace with no data, so
`start` refuses these combinations before it records:

| Xcode  | Simulator runtime |
| ------ | ----------------- |
| 26.6.x | iOS 26.5.x        |

A refused `start` fails with an error that names the Xcode version and the simulator runtime. To
trace, choose one of these:

- Run AutoMobile with Xcode 27.x, for example by starting the daemon with
  `DEVELOPER_DIR=/Applications/Xcode-27.app/Contents/Developer`.
- Trace on a simulator with a different iOS runtime.

The check applies to simulators only. If AutoMobile cannot read the Xcode version or the simulator
runtime, it records as usual.
