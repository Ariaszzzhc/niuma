export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface ApiErrorBody {
  readonly error: ApiError;
}

const statusFor = (code: string): number => {
  switch (code) {
    case "bad_request":
    case "invalid_json":
    case "schema_mismatch":
      return 400;
    case "unauthorized":
      return 401;
    case "not_found":
    case "session_not_found":
    case "approval_not_found":
      return 404;
    case "conflict":
    case "turn_in_flight":
      return 409;
    case "internal":
    default:
      return 500;
  }
};

export class HttpError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    details?: unknown,
    status?: number,
  ) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.details = details;
    this.status = status ?? statusFor(code);
  }
}

export const httpError = (
  code: string,
  message: string,
  details?: unknown,
): HttpError => new HttpError(code, message, details);
