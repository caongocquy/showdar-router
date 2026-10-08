import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure, createTerminalGuard } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

// Final usage for a Responses terminal payload that lacks provider usage:
// real accumulated usage first, estimation as last resort (marked estimated).
// Never called when the payload already carries valid usage — real wins.
function finalResponsesUsage(state, body, contentLength) {
  if (!hasValidUsage(state.usage)) {
    state.usage = estimateUsage(body, contentLength, FORMATS.OPENAI);
  }
  const u = state.usage;
  if (!u || typeof u !== "object") return null;
  return {
    input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    ...(u.estimated ? { estimated: true } : {}),
  };
}

// True for Responses terminal events that must carry final usage.
// Translators emit { event, data }; raw chunks carry .type — accept both.
function isResponsesUsageTerminal(item) {
  const type = item?.event ?? item?.type;
  return type === "response.completed" || type === "response.done" || type === "response.incomplete";
}

// Inject final usage into a Responses terminal event lacking provider usage.
function injectTerminalUsage(item, state, body, contentLength) {
  if (!isResponsesUsageTerminal(item)) return;
  const payload = item.data ?? item;
  if (!payload?.response || hasValidUsage(payload.response.usage)) return;
  const usage = finalResponsesUsage(state, body, contentLength);
  if (!usage) return;
  const next = { ...payload, response: { ...payload.response, usage } };
  if (item.data) item.data = next;
  else item.response = next.response;
}

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    customToolNames = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    credentials = null
  } = options;

  let buffer = "";
  let usage = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, customToolNames: new Set(customToolNames || []), model, sessionId: credentials?._clientSessionId || null }
    : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let finishReason = null;
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  let finalized = false;

  // One authoritative terminal guard per stream, shared with the disconnect/
  // error wrapper through the transformStream property (pipeWithDisconnect):
  // once a terminal event has actually been enqueued, a later transport error
  // must never append a second one.
  const terminalGuard = createTerminalGuard();
  // A Responses-client usage terminal awaiting a trailing usage chunk or EOF.
  // Only the terminal event is ever held — content chunks stream through
  // immediately, so first-token latency and backpressure are unaffected.
  let heldTerminal = null;

  // Usage/logging tail, callable from transform() as well as flush(): a client that
  // closes right after the terminal event cancels the reader, and flush() never runs.
  const finalizeStream = () => {
    if (finalized) return;
    finalized = true;
    trackPendingRequest(model, provider, connectionId, false);

    const isPassthrough = mode === STREAM_MODE.PASSTHROUGH;
    let finalUsage = isPassthrough ? usage : state?.usage;

    if (!hasValidUsage(finalUsage) && totalContentLength > 0) {
      finalUsage = estimateUsage(body, totalContentLength, isPassthrough ? FORMATS.OPENAI : sourceFormat);
      if (finalUsage && typeof finalUsage === "object") {
        // Mark as estimated only when real provider usage is genuinely unavailable
        finalUsage.estimated = true;
      }
      if (isPassthrough) usage = finalUsage; else state.usage = finalUsage;
    }

    if (hasValidUsage(finalUsage)) {
      logUsage(isPassthrough ? provider : (state?.provider || targetFormat), finalUsage, model, connectionId, apiKey);
    } else {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
    }

    if (onStreamComplete) {
      onStreamComplete({
        content: accumulatedContent,
        thinking: accumulatedThinking
      }, finalUsage, ttftAt, finishReason || state?.finishReason || null);
    }
  };

  // A Responses-client terminal event that still lacks usable usage: hold it
  // (never content) so a trailing include_usage chunk can supply the real
  // numbers instead of a premature estimate. Emitted on one of three triggers:
  // real usage arrives, the [DONE] sentinel, or genuine EOF (flush).
  const shouldHoldTerminal = (item) =>
    isResponsesUsageTerminal(item) &&
    !hasValidUsage((item.data ?? item).response?.usage) &&
    !hasValidUsage(state?.usage);

  const emitHeldTerminal = (controller) => {
    if (!heldTerminal) return;
    const item = heldTerminal;
    heldTerminal = null;
    injectTerminalUsage(item, state, body, totalContentLength);
    const output = formatSSE(item, sourceFormat);
    reqLogger?.appendConvertedChunk?.(output);
    controller.enqueue(sharedEncoder.encode(output));
    sseEmittedCount++;
    terminalGuard.mark(item.data?.response?.id ?? null);
    finalizeStream();
  };

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;
          let responsesTerminal = false;
          let terminalId = null;
          // Upstream [DONE] is forwarded below; remember it so flush() never
          // appends a second sentinel (no double [DONE]).
          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]") {
            streamDoneSent = true;
          }

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());
              if (parsed?.response?.id) {
                terminalId = parsed.response.id;
                terminalGuard.setResponseId(terminalId);
              }

              const idFixed = fixInvalidId(parsed);
              const parsedFinishReason = parsed.choices?.[0]?.finish_reason;
              if (parsedFinishReason) finishReason = parsedFinishReason;

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
              // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
              // every streaming delta. @ai-sdk/openai-compatible checks
              // `delta.tool_calls != null` — an empty array passes this check,
              // causing premature `reasoning-end` on every chunk.
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                    delete choice.delta.tool_calls;
                    fieldsInjected = true;
                  }
                }
              }

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = mergeUsage(usage, extracted);
              }

              responsesTerminal = isOpenAIResponsesTerminalEvent(currentOpenAIResponsesEvent, parsed);

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch {
              // Skip non-JSON data lines silently — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML, rate-limit
              // messages) in the SSE stream that would break downstream JSON decoders.
              continue;
            }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          // Responses clients (codex CLI) close on response.completed instead of [DONE]
          if (responsesTerminal) {
            terminalGuard.mark(terminalId);
            finalizeStream();
            controller.terminate();
            return;
          }
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;
        // Latch the active response identity early (first write wins) so any
        // synthesized terminal reuses it instead of inventing resp_<timestamp>.
        if (parsed?.response?.id) terminalGuard.setResponseId(parsed.response.id);

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        // Terminal state BEFORE this event: first terminal is re-emitted,
        // later duplicate terminals get dropped (wire-level dedup).
        const terminalBefore = openAIResponsesTerminalSeen;
        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // Release a held usage terminal first (usage is final by now).
          emitHeldTerminal(controller);

          // Every translated Responses stream must terminate explicitly: if no
          // terminal went out (no finish_reason arrived), synthesize
          // response.failed — never a bare EOF — and never a second terminal
          // when one was already emitted (terminalGuard is authoritative).
          let synthesizedFailed = false;
          if (sourceFormat === FORMATS.OPENAI_RESPONSES && !terminalGuard.hasEmitted()) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure(terminalGuard.getResponseId());
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            terminalGuard.mark(null);
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
            synthesizedFailed = true;
          }

          if ((keepsOpenAIResponsesFormat || synthesizedFailed) && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }
          streamDoneSent = true;
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          finalizeStream();
          controller.terminate();
          return;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) {
          state.usage = mergeUsage(state.usage, extracted); // Keep original usage for logging
          // Trailing include_usage chunk arrived: release a held terminal right
          // away so the real usage reaches the client on the terminal itself.
          if (heldTerminal && hasValidUsage(state.usage)) emitHeldTerminal(controller);
        }

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          // Drop duplicate terminal events after the first has gone out
          if (terminalBefore && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
            currentOpenAIResponsesEvent = null;
            continue;
          }
          const item = { event: openAIResponsesEventName, data: parsed };
          // Terminal without usable usage: hold it until trailing usage or EOF
          // so an estimate can never beat real numbers (see shouldHoldTerminal).
          if (shouldHoldTerminal(item)) {
            heldTerminal = item;
            currentOpenAIResponsesEvent = null;
            continue;
          }
          // Real payload usage is never overwritten; estimates are marked estimated.
          injectTerminalUsage(item, state, body, totalContentLength);
          const output = formatSSE(item, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          // Responses clients (codex) close on the terminal instead of [DONE]
          if (isOpenAIResponsesTerminalEvent(openAIResponsesEventName, item.data)) {
            terminalGuard.mark(item.data?.response?.id ?? null);
            finalizeStream();
          }
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);
        if (state.finishReason) finishReason = state.finishReason;
        // The translator latches the wire response ID on its first emitted event;
        // reuse it for any later synthesized terminal (never a second identity).
        if (state.started) terminalGuard.setResponseId(state.responseId);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            // Terminal Responses events must carry final usage (real or marked
            // estimate). A usage terminal lacking usage is held instead so a
            // trailing include_usage chunk can still supply the real numbers.
            if (shouldHoldTerminal(item)) {
              heldTerminal = item;
              continue;
            }
            injectTerminalUsage(item, state, body, totalContentLength);

            const output = formatSSE(item, sourceFormat);
            if (item.choices?.[0]?.finish_reason) finishReason = item.choices[0].finish_reason;
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
            if (sourceFormat === FORMATS.OPENAI_RESPONSES && isOpenAIResponsesTerminalEvent(item.event, item.data)) {
              terminalGuard.mark(item.data?.response?.id ?? null);
              // Responses clients close on the terminal: finalize accounting here
              // so a client disconnect right after the terminal still counts once.
              finalizeStream();
            }
          }
        }
      }
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }

          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          // Gemini-family clients (Antigravity, Vertex, Gemini) reject this sentinel with 400 syntax errors.
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
          if (!streamDoneSent && !isGeminiFamily) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          finalizeStream();
          return;
        }

        if (buffer.trim()) {
          // Same parse as the transform loop: without targetFormat this only
          // accepts "data: " lines, so an NDJSON provider (Ollama) lost whatever
          // arrived without its closing newline.
          const parsed = parseSSELine(buffer.trim(), targetFormat);
          // parseSSELine turns the SSE sentinel "data: [DONE]" into { done: true },
          // which must not be translated. An Ollama chunk also carries done:true,
          // but it is the real final chunk — it holds finish_reason and the token
          // counts — so it has to go through.
          const isDoneSentinel = parsed?.done && targetFormat !== FORMATS.OLLAMA;
          if (parsed && !isDoneSentinel) {
            // Same accumulation the transform loop does, so finalizeStream() can
            // log a tail chunk's tokens instead of falling back to null.
            const extracted = extractUsage(parsed);
            if (extracted) state.usage = mergeUsage(state.usage, extracted);

            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);
            if (state.finishReason) finishReason = state.finishReason;
            if (state.started) terminalGuard.setResponseId(state.responseId);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                if (item === null || item === undefined) continue;
                injectTerminalUsage(item, state, body, totalContentLength);
                const output = formatSSE(item, sourceFormat);
                if (item.choices?.[0]?.finish_reason) finishReason = item.choices[0].finish_reason;
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
                if (isOpenAIResponsesTerminalEvent(item.event, item.data)) {
                  terminalGuard.mark(item.data?.response?.id ?? null);
                }
              }
            }
          }
        }

        // §5: a tool call whose arguments were still streaming when the upstream
        // closed must not be reported as a successful completion. Suppress the
        // translator's flush-time terminal (and the tool item close) — the
        // guard-based synthesis below turns this into response.failed.
        if (state?.funcItemAdded) {
          const partialTool = Object.keys(state.funcItemAdded).some(
            (i) => state.funcItemAdded[i] && !state.funcItemDone[i]
          );
          if (partialTool) state.suppressTerminal = true;
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            injectTerminalUsage(item, state, body, totalContentLength);
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            if (isOpenAIResponsesTerminalEvent(item.event, item.data)) {
              terminalGuard.mark(item.data?.response?.id ?? null);
            }
          }
        }

        // Genuine EOF: release a held usage terminal (real usage if it arrived,
        // marked estimate as the last resort).
        emitHeldTerminal(controller);

        // Every translated Responses stream must terminate explicitly: if no
        // terminal event ever went out (no finish_reason, partial tool call,
        // unannounced close), synthesize response.failed — never a bare EOF,
        // never a second terminal (terminalGuard is authoritative).
        let synthesizedFailed = false;
        if (sourceFormat === FORMATS.OPENAI_RESPONSES && !terminalGuard.hasEmitted()) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure(terminalGuard.getResponseId());
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          terminalGuard.mark(null);
          openAIResponsesTerminalSeen = true;
          synthesizedFailed = true;
        }

        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if ((keepsOpenAIResponsesFormat || synthesizedFailed) && !openAIResponsesDoneSent && !streamDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          openAIResponsesDoneSent = true;
          streamDoneSent = true;
        }

        finalizeStream();
      } catch (error) {
        console.log("Error in flush:", error);
        finalizeStream();
      }
    }
  });
  // Share terminal authority with the disconnect/error boundary: the wrapper
  // consults this guard so a transport failure can never append a second
  // terminal after one has actually been emitted.
  transformStream.terminalGuard = terminalGuard;
  return transformStream;
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, customToolNames = null, credentials = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    customToolNames,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    credentials
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}
