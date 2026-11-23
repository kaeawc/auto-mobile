# iOS Simulator network activity

`getDeviceState` `networkActivity` reads an iOS Simulator's per-process sockets and traffic from
the host. Simulator processes run on the host as the same user, so plain host tools see them with
no privileges. Source: `src/features/utility/networkActivity/`.

## Read path

1. `ps -axo pid=,ppid=,rss=,pcpu=,command=` (the shared `readHostProcessTable` snapshot).
   `simulatorProcessTree` keeps the `launchd_sim` whose command names
   `/CoreSimulator/Devices/<UDID>/` and every descendant. Other host processes that name the
   directory are not roots. An empty tree means the simulator is not
   booted, and the read stops with an error.
2. In parallel:
   - `lsof -nP -a -i -p <tree pids> -F pcPnT`: per process, each internet socket's protocol,
     `local->remote` name and TCP state. lsof exits 1 when a listed pid has exited or none holds a
     socket. It still prints what it found. The reader parses exit 1 and fails only when stderr has text.
   - `nettop -P -L 1 -x -J bytes_in,bytes_out`: one host-wide sample of `<name>.<pid>,<in>,<out>`
     rows, joined to the tree by pid.
   - `simctl listapps`: each app's bundle path.
3. A process gets an `appId` when its `ps` executable starts with an app's bundle path. The
   longest path wins, so an extension inside an app maps to that app. `ps` shows runtime-root apps
   under `/var/run/...` and `simctl listapps` under `/private/var/run/...`. The matcher drops
   `/private` from both before comparing.
4. The reader leaves out processes with no socket and no bytes. It sorts the rest by bytes, then
   socket count, and caps them at 50; `activeProcessCount` and `truncated` report the cut. The name
   is lsof's, then nettop's (truncated to 15 characters), then the executable basename.

## Byte counts

A single nettop sample reports the bytes on the flows open at that moment, counted from each
flow's start. A flow that closed before nettop started is not reported. On a held connection the
count matched the server's sent-byte total exactly (2424879 bytes, #19020).

## Platform support

Only an iOS Simulator is read. Android and physical iOS devices return `supported: false`, and a
failed `ps` becomes a field `error`. A failed `lsof`, `nettop` or `simctl listapps` degrades only
its part (no sockets, zero bytes, no `appId`) and adds a `warnings` entry.

The design choice is recorded in
[Read Simulator network activity with host tools](../../../devlog/2026-11-23-simulator-network-activity-host-tools.md).
