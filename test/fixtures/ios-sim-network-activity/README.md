Fixtures for `src/features/utility/networkActivity` (#19020).

Captured back to back on Xcode 27.2 with an iPhone 17 simulator on the iOS 27.2 runtime
(UDID `E32B356F-D6E3-427D-A0CC-2BDA07C5CFCF`). The probe app `dev.automobile.netprobe19020`
(pid 15965) held one HTTP connection to a host server on `127.0.0.1:47120`, which had sent it
2424879 bytes at capture time; its request was 207 bytes.

- `ps-simulator-tree.txt`: `ps -axo pid=,ppid=,rss=,pcpu=,command=`, keeping only `launchd` and
  the 310 processes under the simulator's `launchd_sim`. The home directory is replaced with
  `/Users/user/`.
- `lsof-internet-sockets.txt`: `lsof -nP -a -i -p <tree pids> -F pcPnT`, unchanged.
- `nettop-process-bytes.txt`: `nettop -P -L 1 -x -J bytes_in,bytes_out`, keeping the header,
  `launchd`, `syslogd` and the simulator's rows; other host processes are removed. nettop
  truncates names to 15 characters (`intelligenceflo`).
