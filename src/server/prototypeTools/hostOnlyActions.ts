/**
 * Prototype actions the host answers alone, with no device or scope (#18083). Startup-safe on
 * purpose: `registration.ts` routes these before the lazily loaded runtime (which pulls in
 * node:http for the preview server) is imported.
 */
export type PrototypeMockBackendAction =
  | "defineBackend"
  | "clearBackend"
  | "backendLog"
  | "publish";
export type PrototypePreviewAction = "serve" | "stop";
export type PrototypeHostOnlyAction =
  | "screenMap"
  | "share"
  | PrototypeMockBackendAction
  | PrototypePreviewAction;

export const isMockBackendAction = (action: string): action is PrototypeMockBackendAction =>
  ["defineBackend", "clearBackend", "backendLog", "publish"].includes(action);

export const isPrototypePreviewAction = (action: string): action is PrototypePreviewAction =>
  action === "serve" || action === "stop";

export const isPrototypeHostOnlyAction = (action: string): action is PrototypeHostOnlyAction =>
  action === "screenMap" ||
  action === "share" ||
  isMockBackendAction(action) ||
  isPrototypePreviewAction(action);
