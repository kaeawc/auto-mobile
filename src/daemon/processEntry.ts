/**
 * Parent PID captured the moment the process starts (#11041). This module must be the first import
 * of the process entrypoint: reading `process.ppid` later, after sockets and the PID file are up,
 * can return a subreaper's pid once the launcher has already exited, so the orphan watchdog would
 * never see the launcher go away.
 */
export const PROCESS_ENTRY_PARENT_PID: number = process.ppid;
