/**
 * Pure OpenAI-compatible protocol helpers: SSE parsing, failure classification,
 * backoff, and fallback candidate ordering. No VS Code imports, so this module
 * can be unit tested under plain Node.
 */

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

/** An HTTP-level failure carrying the status code when one exists. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
    readonly headers?: Headers,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  getRetryAfterMs(): number | undefined {
    if (!this.headers) {
      return undefined;
    }
    const retryAfter = this.headers.get('retry-after') || this.headers.get('Retry-After');
    if (!retryAfter) {
      return undefined;
    }
    // Try as seconds
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
    // Try as HTTP date
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      const diff = date - Date.now();
      return diff > 0 ? Math.round(diff) : undefined;
    }
    return undefined;
  }
}

/** What to do after a failed attempt against one model. */
export type FailureKind = 'retry' | 'switch' | 'fatal';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 507, 522, 524, 529]);

/**
 * Decide whether an attempt should be retried on the same model, switched to
 * the next fallback model, or abort the request outright.
 *
 * - transient (network/timeouts, 408/429/5xx)  -> retry with backoff
 * - model-specific (400/404), auth/quota (401/403/402) -> switch model
 * - cancellation -> fatal
 */
export function classifyFailure(status?: number, cancelled = false): FailureKind {
  if (cancelled) {
    return 'fatal';
  }
  if (status === undefined) {
    return 'retry'; // network error / timeout, no HTTP status
  }
  if (RETRYABLE_STATUS.has(status)) {
    return 'retry';
  }
  if (status >= 500) {
    return 'retry';
  }
  return 'switch';
}

/** Exponential backoff with jitter, capped at 8s. `attempt` is 1-based. */
export function backoffDelay(attempt: number, baseMs: number, maxMs = 8000): number {
  const exponential = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, maxMs);
  const jitter = capped * 0.25 * Math.random();
  return Math.round(capped + jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ordered list of model references to try for a request:
 * promoted model (auto-switch memory) -> selected model -> configured chain.
 */
export function buildCandidateRefs(
  selected: string,
  fallbacks: readonly string[],
  promoted: string | undefined,
  autoSwitch: boolean,
): string[] {
  const refs: string[] = [];
  const push = (ref: string): void => {
    const trimmed = ref.trim();
    if (trimmed && !refs.includes(trimmed)) {
      refs.push(trimmed);
    }
  };
  if (autoSwitch && promoted) {
    push(promoted);
  }
  push(selected);
  for (const fallback of fallbacks) {
    if (fallback !== selected) {
      push(fallback);
    }
  }
  return refs;
}

/**
 * Parses SSE payloads incrementally. Feed decoded text chunks, receive the
 * `data:` payloads (with the `[DONE]` sentinel passed through unchanged).
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    const payloads: string[] = [];
    for (const line of lines) {
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice(5);
      payloads.push(payload.startsWith(' ') ? payload.slice(1) : payload);
    }
    return payloads;
  }

  /** Flush any trailing payload that arrived without a final newline. */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = '';
    if (rest.startsWith('data:')) {
      const payload = rest.slice(5);
      return [payload.startsWith(' ') ? payload.slice(1) : payload];
    }
    return [];
  }
}

export function tryParseJson(text: string): { ok: true; value: object } | { ok: false } {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return { ok: true, value: parsed as object };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export interface StreamDeltaToolCall {
  index: number;
  id?: string;
  name?: string;
  args?: string;
}

export interface StreamDelta {
  text?: string;
  toolCalls?: StreamDeltaToolCall[];
  finishReason?: string;
}

/** Extract the parts we care about from one OpenAI chat-completion stream chunk. */
export function readDelta(payload: unknown): StreamDelta | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const outer = payload as Record<string, unknown>;
  const choices = outer.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const choice = choices[0] as Record<string, unknown>;
  const delta = (choice.delta ?? {}) as Record<string, unknown>;
  const result: StreamDelta = {};
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    result.text = delta.content;
  }
  if (Array.isArray(delta.tool_calls)) {
    result.toolCalls = delta.tool_calls.map((raw, position) => {
      const call = (raw ?? {}) as Record<string, unknown>;
      const fn = (call.function ?? {}) as Record<string, unknown>;
      return {
        index: typeof call.index === 'number' ? call.index : position,
        id: typeof call.id === 'string' ? call.id : undefined,
        name: typeof fn.name === 'string' ? fn.name : undefined,
        args: typeof fn.arguments === 'string' ? fn.arguments : undefined,
      };
    });
  }
  if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
    result.finishReason = choice.finish_reason;
  }
  return result;
}

export interface NonStreamedCompletion {
  text?: string;
  toolCalls?: OpenAIToolCall[];
}

/**
 * Recognize a full (non-streamed) OpenAI chat completion sitting in a response
 * body that was not an SSE stream — some compatible gateways ignore
 * `stream: true` and answer with a single JSON object.
 *
 * Returns `undefined` for anything else (error bodies, HTML, partial JSON, or a
 * completion that carries no content at all).
 */
export function parseNonStreamedCompletion(body: string): NonStreamedCompletion | undefined {
  const json = tryParseJson(body.trim());
  if (!json.ok) {
    return undefined;
  }
  const root = json.value as Record<string, unknown>;
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const choice = choices[0];
  if (!choice || typeof choice !== 'object') {
    return undefined;
  }
  const message = (choice as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const msg = message as Record<string, unknown>;
  const result: NonStreamedCompletion = {};
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    result.text = msg.content;
  }
  if (Array.isArray(msg.tool_calls)) {
    const calls: OpenAIToolCall[] = [];
    for (const raw of msg.tool_calls) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const call = raw as Record<string, unknown>;
      const fn = call.function as Record<string, unknown> | undefined;
      const name = fn && typeof fn.name === 'string' ? fn.name : undefined;
      const args = fn && typeof fn.arguments === 'string' ? fn.arguments : undefined;
      if (!name) {
        continue;
      }
      calls.push({
        id: typeof call.id === 'string' && call.id ? call.id : `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name, arguments: args ?? '{}' },
      });
    }
    if (calls.length > 0) {
      result.toolCalls = calls;
    }
  }
  if (!result.text && !result.toolCalls) {
    return undefined;
  }
  return result;
}

/** Tolerant model-id extraction from `/models` responses. */
export function parseModelIds(payload: unknown): string[] {
  let entries: unknown[] = [];
  if (Array.isArray(payload)) {
    entries = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      entries = obj.data;
    } else if (Array.isArray(obj.models)) {
      entries = obj.models;
    } else if (Array.isArray(obj.results)) {
      entries = obj.results;
    }
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.trim()) {
        ids.push(entry.trim());
      }
      continue;
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const id = obj.id ?? obj.name ?? obj.model;
      if (typeof id === 'string' && id.trim()) {
        ids.push(id.trim());
      }
    }
  }
  return ids;
}
