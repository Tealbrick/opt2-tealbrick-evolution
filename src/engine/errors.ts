// Engine errors: a code, an HTTP status for the owner ops, details. ops.ts maps them to TbError (CORE §8 envelope).
export class EngineError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, status = 422, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
