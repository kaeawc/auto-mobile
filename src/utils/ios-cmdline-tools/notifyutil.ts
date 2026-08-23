export const IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS = 5000;

export function parseNotifyutilState(raw: string): boolean | null {
  const lines = raw.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    const match = line.trim().match(/(?:^|\s)([01])$/);
    if (match) {
      return match[1] === "1";
    }
  }
  return null;
}

export function iosNotifyutilGetCommand(deviceId: string, key: string): string {
  return `spawn ${deviceId} notifyutil -g ${key}`;
}

export function iosNotifyutilRegisteredSetReadPostCommand(
  deviceId: string,
  key: string,
  value: "0" | "1",
): string {
  return (
    `spawn ${deviceId} notifyutil -1 ${key} ` + `-s ${key} ${value} ` + `-g ${key} ` + `-p ${key}`
  );
}
