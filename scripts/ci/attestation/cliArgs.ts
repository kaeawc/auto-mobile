import { GateResult } from "./attestationSchema";
export function parseGateSpec(spec: string): GateResult {
  const equals = spec.indexOf("=");
  const colon = spec.lastIndexOf(":");
  if (equals <= 0 || colon <= equals + 1 || colon === spec.length - 1) {
    throw new Error(`invalid gate spec: ${spec}`);
  }
  const name = spec.slice(0, equals);
  const status = spec.slice(equals + 1, colon).toLowerCase();
  const durationSeconds = Number(spec.slice(colon + 1));
  if (
    !name.trim() ||
    !["pass", "fail", "skip"].includes(status) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 0
  ) {
    throw new Error(`invalid gate spec: ${spec}`);
  }
  return { name, status: status as GateResult["status"], durationSeconds };
}
