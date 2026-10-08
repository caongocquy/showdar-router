// Helpers for OpenAI Responses API streaming termination + event framing
import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";

// Responses API events that signal the stream has reached a terminal state
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.incomplete",
  "response.failed",
  "error"
]);

export function getOpenAIResponsesEventName(eventName, chunk) {
  if (eventName) return eventName;
  if (chunk && typeof chunk.type === "string") return chunk.type;
  return null;
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (OPENAI_RESPONSES_TERMINAL_EVENTS.has(type)) return true;
  const status = chunk?.response?.status;
  return status === "completed" || status === "incomplete" || status === "failed";
}

const sharedEncoder = new TextEncoder();

// Per-stream terminal-emission guard: the single authoritative record of
// whether a terminal event was actually emitted to the client (not merely
// parsed or intended). Shared between the SSE transform and the disconnect/
// error wrapper (via transformStream.terminalGuard) so a transport failure can
// never append a second terminal. Per-instance closure — no global state.
export function createTerminalGuard() {
  let emitted = false;
  let responseId = null;
  return {
    // Record an emitted terminal; also latches the active response ID (first write wins).
    mark: (id) => {
      emitted = true;
      if (id && !responseId) responseId = id;
    },
    setResponseId: (id) => {
      if (id && !responseId) responseId = id;
    },
    hasEmitted: () => emitted,
    getResponseId: () => responseId
  };
}

// Encoded response.failed + [DONE] payload for aborted/stalled Responses streams.
// The optional guard supplies the stream's active response ID so a synthesized
// failure reuses the existing response identity (never a second resp_<timestamp>).
export function buildAbortedResponsesTerminalBytes(guard = null) {
  return sharedEncoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure(guard?.getResponseId?.() ?? null)}data: [DONE]\n\n`);
}

// Synthesize a response.failed event for streams that close without a terminal event
export function formatIncompleteOpenAIResponsesStreamFailure(responseId = null) {
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: responseId || `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: "stream_error",
          code: "stream_disconnected",
          message: "stream closed before response.completed"
        }
      }
    }
  }, FORMATS.OPENAI_RESPONSES);
}
