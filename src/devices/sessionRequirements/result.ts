import type {
  RequirementResult,
  SessionRequirementError,
  SessionRequirementErrorCode,
} from "./types";

export function success<T>(value: T): RequirementResult<T> {
  return { ok: true, value };
}

export function failure(
  code: SessionRequirementErrorCode,
  message: string,
  options: { transient?: boolean; field?: string } = {},
): RequirementResult<never> {
  const error: SessionRequirementError = {
    code,
    message,
    transient: options.transient ?? false,
    ...(options.field === undefined ? {} : { field: options.field }),
  };
  return { ok: false, error };
}
