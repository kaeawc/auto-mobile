/** Classify captured requests independently of the platform that recorded them. */
export function isFailedNetworkRequest(request: {
  statusCode?: number | null;
  error?: string | null;
}): boolean {
  const { statusCode, error } = request;
  return (
    Boolean(error?.trim()) ||
    typeof statusCode !== "number" ||
    !Number.isFinite(statusCode) ||
    statusCode <= 0 ||
    statusCode >= 400
  );
}
