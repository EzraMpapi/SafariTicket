/**
 * RFC 9457 problem details.
 *
 * Every failure leaves the API in the same shape, so a client can handle errors
 * generically instead of pattern-matching on prose. `type` is stable and
 * documented; `detail` is for humans and may change.
 */

export class ApiError extends Error {
  constructor(status, type, title, detail, extra = {}) {
    super(detail || title);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.title = title;
    this.detail = detail;
    this.extra = extra;
  }

  toProblem(instance) {
    return {
      type: `https://api.safaritiketi.co.tz/problems/${this.type}`,
      title: this.title,
      status: this.status,
      detail: this.detail,
      instance,
      ...this.extra,
    };
  }
}

export const badRequest = (detail, extra) =>
  new ApiError(400, "invalid-request", "Invalid request", detail, extra);

export const unauthorized = (detail = "Missing or invalid credentials.") =>
  new ApiError(401, "unauthorized", "Unauthorized", detail);

export const notFound = (detail = "No such resource.") =>
  new ApiError(404, "not-found", "Not found", detail);

export const conflict = (type, title, detail, extra) =>
  new ApiError(409, type, title, detail, extra);

export const unprocessable = (detail, extra) =>
  new ApiError(422, "unprocessable", "Cannot process request", detail, extra);

export const tooManyRequests = (retryAfterSec) =>
  new ApiError(429, "rate-limited", "Too many requests",
    "Slow down and retry shortly.", { retryAfter: retryAfterSec });

export const internal = () =>
  new ApiError(500, "internal", "Internal error",
    "Something went wrong on our side. The request id will help support trace it.");
