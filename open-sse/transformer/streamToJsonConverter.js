/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */
import { STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";

/**
 * Read an entire SSE stream with bounded first-chunk and idle deadlines.
 * Timeout/abort cancel the reader (releasing the lock) and surface a typed
 * error instead of hanging forever on a silent or stalled upstream.
 * @returns {Promise<string>} full decoded text
 */
export async function readAllWithDeadlines(stream, { signal, firstChunkTimeoutMs = STREAM_FIRST_CHUNK_TIMEOUT_MS, idleTimeoutMs = STREAM_STALL_TIMEOUT_MS } = {}) {
  if (!stream || typeof stream.getReader !== "function") return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let timedOut = false;
  let timer = null;
  const armTimer = (ms) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
    }, ms);
  };
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal?.aborted) {
    try { reader.cancel().catch(() => {}); } catch { /* already closed */ }
    if (signal.reason instanceof Error) throw signal.reason;
    const err = new Error("Request aborted");
    err.name = "AbortError";
    throw err;
  }
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  armTimer(firstChunkTimeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimer(idleTimeoutMs);
      out += decoder.decode(value, { stream: true });
    }
    if (signal?.aborted) {
      if (signal.reason instanceof Error) throw signal.reason;
      const err = new Error("Request aborted");
      err.name = "AbortError";
      throw err;
    }
    if (timedOut) {
      const err = new Error("Upstream stream timed out");
      err.code = "UPSTREAM_TIMEOUT";
      throw err;
    }
    return out + decoder.decode();
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* lock already gone */ }
  }
}

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = "completed";
    if (parsed.response?.usage) {
      state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
      state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
      state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
    }
  } else if (eventType === "response.incomplete") {
    state.status = "incomplete";
    state.incompleteDetails = parsed.response?.incomplete_details ?? null;
    if (parsed.response?.usage) {
      state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
      state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
      state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @param {object} [options] - { signal, firstChunkTimeoutMs, idleTimeoutMs }
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream, options = {}) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const text = await readAllWithDeadlines(stream, options);
  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    incompleteDetails: null,
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  const messages = text.split("\n\n");
  const last = messages.pop();
  for (const msg of messages) {
    processSSEMessage(msg, state);
  }
  if (last && last.trim()) {
    processSSEMessage(last, state);
  }

  // EOF without a terminal event: the upstream died mid-response. Never
  // report a truncated stream as a success payload.
  if (state.status === "in_progress") {
    const err = new Error("Upstream stream ended before a terminal event");
    err.code = "STREAM_TRUNCATED";
    throw err;
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    ...(state.status === "incomplete" ? { incomplete_details: state.incompleteDetails } : {}),
    output,
    usage: state.usage
  };
}
