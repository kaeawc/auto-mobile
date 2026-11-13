# Performance traces

| Tool                             | What it does                      | Requires |
| -------------------------------- | --------------------------------- | -------- |
| 📈 <code>performanceTrace</code> | Record a native performance trace | —        |

`performanceTrace` records an Instruments trace (`xctrace`) on iOS or a Perfetto trace on Android.
Call it with `action: "start"` and a `template` to begin recording. It returns a `traceId`. Call
it with `action: "stop"` and that `traceId` to stop the recorder and get the artifact path and a
summary.

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
