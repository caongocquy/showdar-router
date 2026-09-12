// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

export const TRANSIENT_COOLDOWN_MS = 30 * 1000;
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
export const DAILY_QUOTA_MIN_PROBE_MS = 6 * 60 * 60 * 1000;

const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

export const ERROR_RULES = [
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};

// Route-level recovery windows. These are intentionally independent from
// credential backoff: combo routing can skip a dead route while credentials
// remain available for other models.
export const ROUTE_HEALTH_CONFIG = {
  quota: { baseMs: 30_000, maxMs: 15 * 60_000, state: "cooldown" },
  transient_rate_limit: { baseMs: 30_000, maxMs: 15 * 60_000, state: "cooldown" },
  daily_quota: { baseMs: DAILY_QUOTA_MIN_PROBE_MS, maxMs: 24 * 60 * 60 * 1000, state: "cooldown" },
  subscription: { baseMs: 30 * 60_000, maxMs: 60 * 60_000, state: "cooldown" },
  authentication: { baseMs: 5 * 60_000, maxMs: 15 * 60_000, state: "cooldown" },
  unsupported_model: { baseMs: 10 * 60_000, maxMs: 30 * 60_000, state: "cooldown" },
  model_not_found: { baseMs: 10 * 60_000, maxMs: 30 * 60_000, state: "cooldown" },
  provider_capacity: { baseMs: 15_000, maxMs: 2 * 60_000, state: "open" },
  network: { baseMs: 30_000, maxMs: 5 * 60_000, state: "open" },
  timeout: { baseMs: 60_000, maxMs: 10 * 60_000, state: "open" },
  unknown: { baseMs: 30_000, maxMs: 2 * 60_000, state: "open" },
};
