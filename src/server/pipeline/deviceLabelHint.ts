/**
 * The remedy appended to a refused `device` label: `device` names an executePlan device label,
 * so a caller that passed a device serial or UDID there is pointed at `deviceId` (#17954).
 */
export function deviceLabelHint(deviceLabel: string): string {
  return (
    "`device` is an executePlan device label (declared in its devices list), not a device id; " +
    `to target a device by id, pass deviceId: '${deviceLabel}' instead.`
  );
}
