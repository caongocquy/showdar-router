import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse, createErrorResult } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { createChatComboHealthHooks } from "../services/comboHealthHooks.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import {
  createLatencyTrace,
  runWithLatencyTrace,
  runWithAttempt,
  getActiveLatencyTrace,
} from "open-sse/utils/latencyTrace.js";

function latencyEndpointOf(request, clientRawRequest) {
  try { return new URL(request.url).pathname || null; } catch { return clientRawRequest?.endpoint || null; }
}

function finalizeLatencyFromResponse(trace, res) {
  try {
    if (!trace || trace.finalized) return;
    if (!res) { trace.finalize("failed"); return; }
    const ct = res.headers?.get?.("content-type") || "";
    // A piped SSE response is finalized by its stream terminal (handleComplete/
    // handleError/handleDisconnect) — the wrapper must not close t5 at return
    // time. Handing off here also flips streamReturned, which unlocks those
    // terminal finalizes (and client t4 marks) for this request.
    if (ct.includes("text/event-stream") && trace.finalizeOnComplete) {
      trace.streamReturned = true;
      return;
    }
    const status = res.status || 200;
    trace.finalize(status === 499 ? "cancelled" : status >= 400 ? "failed" : "completed");
  } catch { /* fail-open */ }
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  const trace = createLatencyTrace({ endpoint: latencyEndpointOf(request, clientRawRequest) });
  if (!trace) return handleChatRequest(request, clientRawRequest);
  try {
    const result = await runWithLatencyTrace(trace, () => handleChatRequest(request, clientRawRequest));
    finalizeLatencyFromResponse(trace, result);
    return result;
  } catch (err) {
    trace.finalize(err?.name === "AbortError" ? "cancelled" : "failed");
    throw err;
  }
}

async function handleChatRequest(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch (error) {
    // A client that disappears mid-body is a cancellation, not a malformed request.
    if (request.signal?.aborted || error?.name === "AbortError") {
      return errorResponse(499, "Request aborted");
    }
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // One logical-request id per client request, minted once so the
  // account-fallback loop reuses it across every internal retry.
  if (!clientRawRequest.logicalRequestId) {
    clientRawRequest.logicalRequestId = globalThis.crypto.randomUUID();
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel, options = {}) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, options.signal, !!isPanel);
        },
        ...createChatComboHealthHooks(log),
        requestSignal: request.signal,
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      ...createChatComboHealthHooks(log),
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, _isPanel, options = {}) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, options.signal, false, options.comboFallbackRemaining),
        adapterAdded
      ),
      requestSignal: request?.signal || null,
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      ...createChatComboHealthHooks(log),
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, _isPanel, options = {}) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, options.signal, false, options.comboFallbackRemaining),
        adapterAdded
      ),
      requestSignal: request?.signal || null,
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, request?.signal || null);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, signal = null, isPanel = false, comboFallbackRemaining = false) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel, options = {}) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, options.signal, !!isPanel, options.comboFallbackRemaining);
          },
          ...createChatComboHealthHooks(log),
          requestSignal: request.signal,
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        ...createChatComboHealthHooks(log),
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m, _isPanel, options = {}) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, options.signal, false, options.comboFallbackRemaining),
          adapterAdded
        ),
        requestSignal: request?.signal || null,
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Phase D1: solo selection mark (t1). Skipped when combo/fusion already
  // recorded the selection — combo-level attempts own those requests.
  const trace = getActiveLatencyTrace();
  trace?.markSoloSelection();

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  // Earliest upstream reset across exhausted accounts. The combo layer derives
  // its client-facing Retry-After from this, so dropping it here would strand
  // the hint even though route health knows it.
  let exhaustedResetsAtMs = null;

  while (true) {
    // A client that already left must not trigger another account dispatch.
    if (signal?.aborted) return createErrorResult(499, "Request aborted").response;
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return createErrorResult(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", exhaustedResetsAtMs).response;
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    // Phase D1: one attempt per account iteration. Combo/fusion requests carry
    // their own attempt record (comboActive) — never double-record.
    const attempt = trace && !trace.comboActive ? trace.beginAttempt({ ordinal: 0, model: modelStr }) : null;
    let result;
    try {
      result = await runWithAttempt(attempt, async () => handleChatCore({
        body: { ...body, model: `${provider}/${model}` },
        modelInfo: { provider, model },
        credentials: refreshedCredentials,
        log,
        clientRawRequest,
        connectionId: credentials.connectionId,
        userAgent,
        apiKey,
        ccFilterNaming: !!chatSettings.ccFilterNaming,
        rtkEnabled: !!chatSettings.rtkEnabled,
        headroomEnabled: !!chatSettings.headroomEnabled,
        headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
        headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
        headroomTimeoutMs: chatSettings.headroomTimeoutMs,
        cavemanEnabled: !!chatSettings.cavemanEnabled,
        cavemanLevel: chatSettings.cavemanLevel || "full",
        ponytailEnabled: !!chatSettings.ponytailEnabled,
        ponytailLevel: chatSettings.ponytailLevel || "full",
        signal,
        isPanel,
        comboFallbackRemaining,
        pxpipeEnabled: !!chatSettings.pxpipeEnabled,
        pxpipeMinChars: chatSettings.pxpipeMinChars,
        pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
        // Lazily warms the in-process module on first use; null when not installed (fail-open)
        pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
        onPxpipeEvent: appendPxpipeEvent,
        providerThinking,
        // Detect source format by endpoint + body
        sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            ...newCreds,
            existingProviderSpecificData: credentials.providerSpecificData,
            testStatus: "active"
          });
        },
        onRequestSuccess: async () => {
          await clearAccountError(credentials.connectionId, credentials, model);
          // "Consecutive" strikes: a success clears the breaker for this pair.
          clearAntigravityStrikes(credentials.connectionId, model);
        }
      }));
    } catch (err) {
      // chatCore mostly returns error results, but a thrown pre-dispatch error
      // (logger/headroom/pxpipe) must still close the attempt record.
      trace?.finishAttempt(attempt, {
        result: err?.name === "AbortError" ? "cancelled" : "failure",
        status: err?.name === "AbortError" ? 499 : Number(err?.status) || 500,
        errorText: err?.message || String(err),
        aborted: err?.name === "AbortError",
      });
      throw err;
    }

    if (result.success) {
      trace?.finishAttempt(attempt, { result: "success", status: result.response?.status ?? 200 });
      trace?.noteWinner(attempt);
      return result.response;
    }

    // Phase D1: record the failed attempt (classified enum reason only).
    const attemptStatus = result.status ?? result.response?.status ?? 500;
    trace?.finishAttempt(attempt, {
      result: attemptStatus === 499 ? "cancelled" : "failure",
      status: attemptStatus,
      errorText: result.error || "",
      aborted: attemptStatus === 499,
    });

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs, { routeAware: true })).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      const resetMs = Number(resetsAtMs);
      if (Number.isFinite(resetMs) && (exhaustedResetsAtMs == null || resetMs < exhaustedResetsAtMs)) {
        exhaustedResetsAtMs = resetMs;
      }
      continue;
    }

    return result.response;
  }
}
