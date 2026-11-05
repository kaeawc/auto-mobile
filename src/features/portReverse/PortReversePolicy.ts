import { ENV, readEnvTrimmed } from "../../config/env";
import { PortReverseError } from "./PortReverseError";

/** Ports below this are privileged and always refused. */
export const MIN_REVERSE_PORT = 1024;
const MAX_PORT = 65535;

export interface PortRange {
  min: number;
  max: number;
}

/** Which ports a client may reverse. Undefined `allowed` means every unprivileged port. */
export interface PortReversePolicy {
  allowed?: readonly PortRange[];
}

export const PORT_REVERSE_ALLOWED_PORTS_ENV = ENV.PORT_REVERSE_ALLOWED_PORTS.name;

function parseRange(token: string): PortRange | undefined {
  const match = /^(\d+)(?:-(\d+))?$/.exec(token);
  if (match === null) {
    return undefined;
  }
  const min = Number(match[1]);
  const max = Number(match[2] ?? match[1]);
  return min <= max && max <= MAX_PORT ? { min, max } : undefined;
}

/**
 * Reads the allowlist from `AUTOMOBILE_PORT_REVERSE_ALLOWED_PORTS`: comma-separated ports or
 * inclusive ranges (`3000-3999,8080`). Unset or blank allows every unprivileged port. A value with
 * any invalid entry allows nothing, so a typo fails closed instead of widening the allowlist.
 */
export function portReversePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PortReversePolicy {
  const raw = readEnvTrimmed(ENV.PORT_REVERSE_ALLOWED_PORTS, env);
  if (!raw) {
    return {};
  }
  const ranges = raw.split(",").map((token) => parseRange(token.trim()));
  return { allowed: ranges.every((range) => range !== undefined) ? ranges : [] };
}

function isAllowed(policy: PortReversePolicy, port: number): boolean {
  if (!Number.isInteger(port) || port < MIN_REVERSE_PORT || port > MAX_PORT) {
    return false;
  }
  return policy.allowed?.some((range) => port >= range.min && port <= range.max) ?? true;
}

/** Throws `port_reverse_port_refused` naming every privileged or disallowed port. */
export function assertPortsAllowed(policy: PortReversePolicy, ports: readonly number[]): void {
  const refused = [...new Set(ports.filter((port) => !isAllowed(policy, port)))];
  if (refused.length === 0) {
    return;
  }
  const allowed = policy.allowed
    ? `the allowlist in ${PORT_REVERSE_ALLOWED_PORTS_ENV}`
    : `${MIN_REVERSE_PORT}-${MAX_PORT}`;
  throw new PortReverseError(
    "port_reverse_port_refused",
    `Refused to reverse port(s) ${refused.join(", ")}: device and host ports must be within ${allowed} (privileged ports below ${MIN_REVERSE_PORT} are never reversed).`,
    refused,
  );
}
