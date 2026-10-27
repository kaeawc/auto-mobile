/** Only the trace id is loggable; callers may retain private metadata in their own scope. */
export type LogContextProvider = () => { readonly traceId: string } | undefined;

let logContextProvider: LogContextProvider | undefined;

export function setLogContextProvider(provider: LogContextProvider | undefined): void {
  logContextProvider = provider;
}

export function currentLogContext(): ReturnType<LogContextProvider> {
  return logContextProvider?.();
}
