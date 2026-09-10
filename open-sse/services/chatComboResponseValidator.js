function hasMeaningfulOpenAIPayload(json) {
  const choice = json?.choices?.[0];
  const delta = choice?.delta || {};
  const message = choice?.message || {};

  if (typeof delta.content === "string" && delta.content.length > 0) return true;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
  if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  if (delta.function_call && typeof delta.function_call === "object") return true;

  if (typeof message.content === "string" && message.content.length > 0) return true;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  if (message.function_call && typeof message.function_call === "object") return true;

  // Defensive support for Responses-style translated events.
  if (typeof json?.delta === "string" && json.delta.length > 0) return true;
  if (typeof json?.text === "string" && json.text.length > 0) return true;
  if (String(json?.type || "").includes("tool") && json?.delta) return true;

  return false;
}

function scanSseText(buffer) {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      if (hasMeaningfulOpenAIPayload(JSON.parse(payload))) {
        return { meaningful: true, remainder };
      }
    } catch {
      // Ignore non-JSON SSE payloads and continue scanning.
    }
  }

  return { meaningful: false, remainder };
}

function replayResponse(response, reader, bufferedChunks) {
  const body = new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of bufferedChunks) controller.enqueue(chunk);
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function validateChatComboResponse(response) {
  if (!response?.ok) {
    return { ok: false, response, status: response?.status || 502, errorText: "Upstream response failed" };
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    try {
      const json = await response.clone().json();
      if (hasMeaningfulOpenAIPayload(json)) return { ok: true, response };
    } catch {
      // A successful non-JSON response is not a valid chat completion.
    }
    return { ok: false, status: 502, errorText: "Empty or invalid successful chat response" };
  }

  if (!response.body) {
    return { ok: false, status: 502, errorText: "Successful chat response has no body" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const bufferedChunks = [];
  let textBuffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value?.length) continue;

    bufferedChunks.push(value);
    textBuffer += decoder.decode(value, { stream: true });
    const scan = scanSseText(textBuffer);
    textBuffer = scan.remainder;

    if (scan.meaningful) {
      return {
        ok: true,
        response: replayResponse(response, reader, bufferedChunks),
      };
    }
  }

  textBuffer += decoder.decode();
  if (textBuffer) {
    const finalScan = scanSseText(`${textBuffer}\n`);
    if (finalScan.meaningful) {
      return {
        ok: true,
        response: replayResponse(response, reader, bufferedChunks),
      };
    }
  }

  return {
    ok: false,
    status: 502,
    errorText: "Successful chat stream contained no content, reasoning, or tool-call delta",
  };
}
