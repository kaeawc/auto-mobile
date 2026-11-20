# iOS Simulator profiling fixtures

| File                              | Capture command                                  | Output                                                         |
| --------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `launchctl-list.txt`              | `xcrun simctl spawn <udid> launchctl list`       | Process list from a booted Simulator with Settings open.       |
| `leaks-output-graph-success.txt`  | `leaks <simulator-app-pid> --outputGraph=<path>` | Standard output from a successful graph write.                 |
| `leaks-not-running.txt`           | `leaks <exited-pid> --outputGraph=<path>`        | Standard error from a PID that was gone.                       |
| `leaks-no-privileges.txt`         | `leaks <restricted-pid> --outputGraph=<path>`    | Standard error from a process the host user could not inspect. |
| `leaks-read-memgraph-summary.txt` | `leaks <path-to-memgraph>`                       | Summary from reading the saved graph.                          |
