/** One internet socket a process holds, as `lsof` reports it. */
export interface NetworkActivitySocket {
  /** `TCP` or `UDP`. */
  protocol: string;
  /** Local `address:port`; `*:*` for an unbound UDP socket. */
  local: string;
  /** Remote `address:port`, absent for a listening or unconnected socket. */
  remote?: string;
  /** TCP state such as `ESTABLISHED`, `LISTEN` or `CLOSE_WAIT`; absent for UDP. */
  state?: string;
}

/** One simulator process that has internet sockets open or bytes on them. */
export interface NetworkActivityProcess {
  pid: number;
  name: string;
  /** Bundle id of the installed app whose bundle holds the executable (app extensions included). */
  appId?: string;
  sockets: NetworkActivitySocket[];
  /** Bytes received on the sockets open at read time, since each socket opened. */
  bytesIn: number;
  /** Bytes sent on the sockets open at read time, since each socket opened. */
  bytesOut: number;
}

export interface NetworkActivityState {
  supported: boolean;
  /** Busiest processes with sockets or traffic: bytes, then socket count, descending; capped. */
  processes?: NetworkActivityProcess[];
  /** Processes in the simulator's tree when it was read, active or not. */
  processCount?: number;
  /** Processes with sockets or traffic before the cap; `processes` holds at most 50. */
  activeProcessCount?: number;
  /** True when `activeProcessCount` exceeds the cap and the quietest processes were dropped. */
  truncated?: boolean;
  /** Host tools that failed; the rest of the snapshot is still returned. */
  warnings?: string[];
  error?: string;
}
