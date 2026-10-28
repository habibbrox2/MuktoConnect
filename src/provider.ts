import * as vscode from 'vscode';
import {
  readRetrySettings,
  readVendorSettings,
  stripTrailingSlash,
  VENDORS,
  VendorId,
  VendorSpec,
} from './config';
import { toOpenAiMessages, toOpenAiTools } from './messages';
import {
  backoffDelay,
  buildCandidateRefs,
  classifyFailure,
  filterEligibleFallbackRefs,
  HttpError,
  NonStreamedCompletion,
  parseModelIds,
  parseNonStreamedCompletion,
  readDelta,
  sleep,
  SseParser,
  tryParseJson,
} from './openai';

const DEFAULT_MAX_INPUT_TOKENS = 128000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface ResolvedTarget {
  readonly vendor: VendorId;
  readonly info: vscode.LanguageModelChatInformation;
  readonly baseUrl: string;
  readonly apiKey?: string;
}

/** Shares providers so one vendor's models can be used as another vendor's fallback. */
export class ProviderRegistry {
  private readonly providers = new Map<VendorId, OpenAICompatProvider>();

  register(provider: OpenAICompatProvider): void {
    this.providers.set(provider.vendor, provider);
  }

  get(vendor: VendorId): OpenAICompatProvider | undefined {
    return this.providers.get(vendor);
  }
}

interface ToolCallBuffer {
  id?: string;
  name?: string;
  args: string;
}

/** What one streamed attempt actually put on the wire. */
interface StreamStats {
  /** Bytes read from the response stream. */
  chunks: number;
  /** `data:` payloads parsed out of the SSE stream. */
  payloads: number;
  /** Parts reported to VS Code (text or tool calls). */
  parts: number;
  /** Whether the provider sent an explicit end-of-turn marker. */
  completed: boolean;
  /** Body bytes, kept only while no payload has parsed (diagnostics + buffered completions). */
  raw: string;
}

export class OpenAICompatProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  /** Last model list handed to VS Code, used to resolve fallback ids. */
  private cache: vscode.LanguageModelChatInformation[] = [];
  /** Model promoted by a successful automatic switch (session memory). */
  private promoted: string | undefined;
  /** Cached model IDs per provider to avoid re-fetching. */
  private modelCache: Map<string, string[]> = new Map();
  /** In-memory quota cooldowns keyed by provider + model ID. */
  private readonly quotaCooldowns = new Map<string, number>();

  constructor(
    readonly vendor: VendorId,
    private readonly spec: VendorSpec,
    private readonly secrets: vscode.SecretStorage,
    private readonly registry: ProviderRegistry,
    private readonly log: (message: string) => void,
  ) {}

  refresh(): void {
    this.cache = [];
    this.modelCache.clear();
    this.changeEmitter.fire();
  }

  clearPromoted(): void {
    this.promoted = undefined;
  }
  clearModelCache(): void {
    this.modelCache.clear();
  }

  // ---------------------------------------------------------------- discovery

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const settings = readVendorSettings(this.spec);
    if (!settings.baseUrl) {
      if (!options.silent) {
        this.log(`${this.spec.displayName}: base URL is not configured, no models exposed.`);
      }
      return [];
    }

    // Model discovery must be side-effect-free: VS Code may call it repeatedly.
    // Missing credentials simply hide this provider until the user configures it
    // explicitly through the MuktoConnect management command.
    const apiKey = await this.resolveApiKey();
    if (this.spec.requiresKey && !apiKey) {
      this.log(`${this.spec.displayName}: API key is not configured; no models exposed.`);
      return [];
    }

    // Check model cache first
    const cachedIds = this.modelCache.get(this.spec.id);
    let discovered: string[] = [];
    if (cachedIds && cachedIds.length > 0) {
      this.log(`${this.spec.displayName}: using cached model list (${cachedIds.length} models).`);
      discovered = cachedIds;
    } else {
      try {
        discovered = await this.fetchModelIds(settings.modelsUrl, apiKey, settings.baseUrl);
        this.log(`${this.spec.displayName}: discovered ${discovered.length} models from ${settings.modelsUrl}`);
        // Cache the model IDs for future use
        this.modelCache.set(this.spec.id, dedupe([...settings.modelIds, ...discovered]));
      } catch (error) {
        this.log(`${this.spec.displayName}: model list failed (${describe(error)}), falling back to configured ids.`);
      }
    }
    if (token.isCancellationRequested) {
      return [];
    }

    const ids = dedupe([...settings.modelIds, ...discovered]);
    // Sort free models first
    const sortedIds = [...ids].sort((a, b) => {
      const aFree = /free/i.test(a) ? 1 : 0;
      const bFree = /free/i.test(b) ? 1 : 0;
      if (aFree !== bFree) {
        return bFree - aFree;
      }
      return a.localeCompare(b);
    });
    const infos = sortedIds.map((id) => this.toModelInformation(id));
    this.cache = infos;
    this.log(`${this.spec.displayName}: exposing ${infos.length} model(s).`);
    return infos;
  }

  private toModelInformation(id: string): vscode.LanguageModelChatInformation {
    const vendor = this.spec.displayName;
    const settings = readVendorSettings(this.spec);
    return {
      id,
      name: id,
      family: this.vendor,
      version: '1.0.0',
      tooltip: `${vendor} • ${id} • ${settings.baseUrl}`,
      detail: `${vendor} • ${settings.baseUrl}`,
      maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: { imageInput: false, toolCalling: true },
    };
  }

  private async fetchModelIds(
    modelsUrl: string,
    apiKey: string | undefined,
    baseUrl: string,
  ): Promise<string[]> {
    const url = stripTrailingSlash(modelsUrl || `${baseUrl}/models`);
    if (!url) {
      return [];
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      throw new HttpError(`GET ${url} -> ${response.status}`, response.status);
    }
    return parseModelIds(await response.json());
  }

  private async resolveApiKey(): Promise<string | undefined> {
    // Never prompt from model discovery. VS Code can request model information
    // repeatedly while opening chat, changing model pickers, or entering Agent mode.
    return this.secrets.get(this.spec.secretKey);
  }

  // ----------------------------------------------------------------- requests

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const retry = readRetrySettings();
    const settings = readVendorSettings(this.spec);

    let emitted = false;
    const tracked: vscode.Progress<vscode.LanguageModelResponsePart> = {
      report: (part) => {
        emitted = true;
        progress.report(part);
      },
    };

    // Only use fallback references belonging to currently eligible providers.
    // Eligibility is re-evaluated per request so removed credentials cannot leave
    // stale fallback targets active.
    const eligibleRefs = new Set<string>();
    for (const spec of VENDORS) {
      const provider = this.registry.get(spec.id);
      if (!provider) {
        continue;
      }
      const ids = await provider.getEligibleFallbackModelIds();
      for (const id of ids) {
        eligibleRefs.add(spec.id === this.vendor ? id : `${spec.id}:${id}`);
      }
    }

    const configuredFallbacks = filterEligibleFallbackRefs(settings.fallbackModels, eligibleRefs);
    const dynamicFallbacks = [...eligibleRefs].filter((ref) => ref !== model.id);
    // Prefer explicitly free models whenever choosing a fallback, regardless of provider order.
    const orderedFallbacks = dedupe([...configuredFallbacks, ...dynamicFallbacks]).sort(
      (a, b) => Number(isFreeModelRef(b)) - Number(isFreeModelRef(a)),
    );
    const promoted = this.promoted && eligibleRefs.has(this.promoted) ? this.promoted : undefined;
    if (this.promoted && !promoted) {
      this.log(`${this.spec.displayName}: ignoring promoted model "${this.promoted}" because its provider is not currently eligible.`);
      this.promoted = undefined;
    }
    const refs = buildCandidateRefs(
      model.id,
      orderedFallbacks,
      promoted,
      retry.autoSwitch,
    );
    const targets: { ref: string; target?: ResolvedTarget; error?: unknown }[] = [];
    for (const ref of refs) {
      try {
        targets.push({ ref, target: await this.resolveRef(ref, model) });
      } catch (error) {
        targets.push({ ref, error });
        this.log(`${this.spec.displayName}: fallback "${ref}" unavailable — ${describe(error)}`);
      }
    }

    let lastError: unknown;
    let quotaFallbackOnlyFree = false;
    for (const entry of targets) {
      if (token.isCancellationRequested) {
        throw new Error('Request cancelled.');
      }
      if (!entry.target) {
        lastError = entry.error ?? lastError;
        continue;
      }

      const target = entry.target;
      const cooldownKey = `${target.vendor}:${target.info.id}`;
      if (quotaFallbackOnlyFree && !isFreeModelRef(target.info.id)) {
        this.log(`${this.spec.displayName}: skipping non-free fallback ${cooldownKey} after a free-usage quota limit.`);
        continue;
      }
      const cooldownUntil = this.quotaCooldowns.get(cooldownKey) ?? 0;
      if (cooldownUntil > Date.now()) {
        this.log(`${this.spec.displayName}: skipping ${cooldownKey}; quota cooldown has ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s remaining.`);
        continue;
      }
      this.quotaCooldowns.delete(cooldownKey);
      let attempt = 0;
      const maxAttempts = Math.max(1, retry.maxAttempts);

      while (attempt < maxAttempts) {
        if (token.isCancellationRequested) {
          throw new Error('Request cancelled.');
        }
        attempt += 1;
        let attemptText = '';
        let attemptHasToolCall = false;
        const attemptProgress: vscode.Progress<vscode.LanguageModelResponsePart> = {
          report: (part) => {
            if (part instanceof vscode.LanguageModelTextPart) {
              attemptText += part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
              attemptHasToolCall = true;
            }
            tracked.report(part);
          },
        };
        try {
          await this.streamOnce(target, messages, options, attemptProgress, token, retry.timeoutMs, undefined, () => {
            attemptHasToolCall = true;
          });
          this.noteSuccess(model, target);
          return;
        } catch (error) {
          if (attemptText.length > 0 && !attemptHasToolCall && retry.autoContinue && !token.isCancellationRequested) {
            this.log(
              `${this.spec.displayName}: ${target.vendor}:${target.info.id} stream interrupted after partial text; attempting one continuation.`,
            );
            await this.streamOnce(target, messages, options, tracked, token, retry.timeoutMs, attemptText);
            this.noteSuccess(model, target);
            return;
          }
          if (emitted) {
            // Once output is visible, never restart the full answer or switch models mid-turn.
            throw error;
          }
          const quotaLimit = isQuotaLimitError(error);
          if (quotaLimit) {
            quotaFallbackOnlyFree = true;
            const retryAfterMs = error instanceof HttpError ? error.getRetryAfterMs() : undefined;
            // Free-usage quota errors will not heal by retrying the same model.
            // Keep the provider/model in cooldown and immediately try the next candidate.
            const cooldownMs = Math.min(Math.max(retryAfterMs ?? 60000, 1000), 15 * 60 * 1000);
            this.quotaCooldowns.set(cooldownKey, Date.now() + cooldownMs);
            this.log(
              `${this.spec.displayName}: quota limit detected for ${cooldownKey}; skipping same-model retries and cooling down for ${Math.ceil(cooldownMs / 1000)}s.`,
            );
            lastError = error;
            if (target.info.id === this.promoted || this.promoted === cooldownKey) {
              this.promoted = undefined;
            }
            break;
          }
          const kind = classifyFailure(
            error instanceof HttpError ? error.status : undefined,
            token.isCancellationRequested,
          );
          lastError = error;
          this.log(
            `${this.spec.displayName}: ${target.vendor}:${target.info.id} attempt ${attempt}/${maxAttempts}` +
              ` failed (${describe(error)}) → ${kind}`,
          );
          if (kind === 'fatal') {
            throw error;
          }
          if (target.info.id === this.promoted) {
            this.promoted = undefined; // demote a promoted model that just failed
          }
          if (kind === 'retry' && attempt < maxAttempts) {
            let delay = backoffDelay(attempt, retry.baseDelayMs);
            if (error instanceof HttpError && error.status === 429) {
              const retryAfter = error.getRetryAfterMs();
              if (retryAfter && retryAfter > 0) {
                delay = Math.min(Math.max(retryAfter, delay), 60000);
                this.log(`${this.spec.displayName}: using Retry-After ${Math.round(delay/1000)}s for rate limit.`);
              }
            }
            await sleep(delay);
            continue;
          }
          break; // move on to the next fallback model
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error('All candidate models failed.');
  }

  private noteSuccess(selected: vscode.LanguageModelChatInformation, target: ResolvedTarget): void {
    const switched = target.info.id !== selected.id || target.vendor !== this.vendor;
    if (!switched) {
      return;
    }
    this.log(`${this.spec.displayName}: request succeeded on ${target.vendor}:${target.info.id}.`);
    if (readRetrySettings().autoSwitch) {
      // Store full reference with vendor prefix for cross-provider fallback
      this.promoted = target.vendor !== this.vendor ? `${target.vendor}:${target.info.id}` : target.info.id;
      vscode.window.setStatusBarMessage(
        `$(check) MuktoConnect switched to ${target.info.id} (${target.vendor})`,
        6000,
      );
    }
  }

  private async streamOnce(
    target: ResolvedTarget,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    timeoutMs: number,
    continuationText?: string,
    onToolCallStart?: () => void,
  ): Promise<void> {
    const url = `${stripTrailingSlash(target.baseUrl)}/chat/completions`;
    const targetDisplayName = VENDORS.find((vendor) => vendor.id === target.vendor)?.displayName ?? target.vendor;
    const requestMessages = toOpenAiMessages(messages);
    // Opt-in diagnostics are deliberately restricted to simple greetings.
    const greetingDiagnostics = vscode.workspace.getConfiguration('muktoconnect')
      .get<boolean>('diagnostics.greetingResponse', false);
    const lastUserMessage = [...requestMessages].reverse().find((message) => message.role === 'user');
    const greetingRequest = Boolean(
      greetingDiagnostics && lastUserMessage && typeof lastUserMessage.content === 'string' &&
      /^(hi|hello|hey)[!. ]*$/i.test(lastUserMessage.content.trim()),
    );
    if (greetingRequest) {
      this.log(`Greeting diagnostic request: model=${target.info.id}; provider=${target.vendor}; messages=${requestMessages.length}; roles=${requestMessages.map((message) => message.role).join(',')}`);
    }
    const diagnosticText: string[] = [];
    const diagnosticProgress: vscode.Progress<vscode.LanguageModelResponsePart> = {
      report: (part) => {
        if (greetingRequest && part instanceof vscode.LanguageModelTextPart) {
          diagnosticText.push(part.value);
        }
        progress.report(part);
      },
    };
    if (continuationText) {
      requestMessages.push({ role: 'assistant', content: continuationText });
      requestMessages.push({
        role: 'user',
        content: 'Continue the previous answer from exactly where it stopped. Do not repeat any text already present. Continue with the next words only.',
      });
    }
    const body: Record<string, unknown> = {
      model: target.info.id,
      messages: requestMessages,
      stream: true,
    };

    // A text continuation must never re-issue tools from the interrupted turn.
    const tools = continuationText ? undefined : toOpenAiTools(options.tools);
    if (tools && tools.length > 0) {
      body.tools = tools;
      if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
        body.tool_choice = 'required';
      }
    }

    const modelOptions = (options.modelOptions ?? {}) as Record<string, unknown>;
    const requestedMax = typeof modelOptions.max_tokens === 'number' ? modelOptions.max_tokens : undefined;
    body.max_tokens = Math.min(requestedMax ?? target.info.maxOutputTokens, target.info.maxOutputTokens);
    for (const key of ['temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty']) {
      if (key in modelOptions) {
        body[key] = modelOptions[key];
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (target.apiKey) {
      headers.Authorization = `Bearer ${target.apiKey}`;
    }

    const controller = new AbortController();
    const cancelSubscription = token.onCancellationRequested(() => controller.abort());
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        throw this.toStreamError(error, token, `POST ${url}`);
      }
      this.log(`${targetDisplayName}: POST ${url} (model=${target.info.id})`);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.log(`${targetDisplayName}: HTTP ${response.status} ${response.statusText} - ${text.slice(0, 200)}`);
        throw new HttpError(
          `POST ${url} -> ${response.status} ${response.statusText}`,
          response.status,
          text.slice(0, 800),
          response.headers,
        );
      }
      if (!response.body) {
        throw new HttpError(`POST ${url}: empty response body`, undefined);
      }
      this.log(`${targetDisplayName}: streaming response started`);
      let stats: StreamStats;
      try {
        stats = await this.consume(response.body, diagnosticProgress, token, onToolCallStart);
      } catch (error) {
        // Mid-stream aborts (timeout, socket reset) must surface as a failed
        // attempt so the retry/fallback loop can handle them.
        throw this.toStreamError(error, token, `POST ${url}`);
      }
      this.log(
        `${targetDisplayName}: streaming response ended ` +
          `(${stats.chunks} chunks, ${stats.payloads} payloads, ${stats.parts} parts)`,
      );
      if (greetingRequest) {
        this.log(`Greeting diagnostic response (first 500 chars): ${JSON.stringify(diagnosticText.join('').slice(0, 500))}`);
      }
      if (token.isCancellationRequested) {
        return;
      }
      if (stats.parts > 0) {
        if (stats.completed) {
          return;
        }
        throw new HttpError(
          `POST ${url}: stream ended after partial output without a completion marker`,
          undefined,
        );
      }
      // A gateway that ignores `stream: true` answers with one JSON completion.
      if (stats.payloads === 0 && stats.raw.trim()) {
        const completion = parseNonStreamedCompletion(stats.raw);
        if (completion) {
          this.log(`${targetDisplayName}: response was not streamed; using the buffered completion.`);
          if (this.reportCompletion(completion, diagnosticProgress)) {
            return;
          }
        }
      }
      // Resolving with nothing emitted makes VS Code report its generic
      // "No response was returned" error, so fail the attempt with a real cause.
      throw this.emptyResponseError(url, response, stats);
    } finally {
      clearTimeout(timer);
      cancelSubscription.dispose();
    }
  }

  /** Report a buffered (non-streamed) completion; returns how many parts went out. */
  private reportCompletion(
    completion: NonStreamedCompletion,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): number {
    let parts = 0;
    if (completion.text) {
      progress.report(new vscode.LanguageModelTextPart(completion.text));
      parts += 1;
    }
    for (const call of completion.toolCalls ?? []) {
      const parsed = tryParseJson(call.function.arguments || '{}');
      if (!parsed.ok) {
        this.log(`Dropping tool call "${call.function.name}": arguments were not valid JSON.`);
        continue;
      }
      progress.report(new vscode.LanguageModelToolCallPart(call.id, call.function.name, parsed.value));
      parts += 1;
    }
    return parts;
  }

  /** Explain why a 2xx response produced no chat content. */
  private emptyResponseError(url: string, response: Response, stats: StreamStats): Error {
    const contentType = response.headers.get('content-type') || 'unknown';
    const body = stats.raw.trim();
    if (stats.payloads === 0) {
      if (!body) {
        return new HttpError(`POST ${url}: response body was empty`, undefined);
      }
      return new HttpError(
        `POST ${url}: expected an SSE stream, got "${contentType}" — ` +
          `first bytes: ${body.slice(0, 300)}`,
        undefined,
      );
    }
    return new HttpError(
      `POST ${url}: stream ended without any message content ` +
        `(${stats.payloads} payloads, content-type: ${contentType})`,
      undefined,
    );
  }

  private toStreamError(error: unknown, token: vscode.CancellationToken, context: string): Error {
    const name = error && typeof error === 'object' ? (error as { name?: string }).name : undefined;
    if (name === 'AbortError' || name === 'TimeoutError') {
      if (token.isCancellationRequested) {
        return new Error('Request cancelled.');
      }
      return new HttpError(`${context}: request timed out`, undefined);
    }
    return error instanceof Error ? error : new Error(`${context}: ${String(error)}`);
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    onToolCallStart?: () => void,
  ): Promise<StreamStats> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const buffers = new Map<number, ToolCallBuffer>();
    const completed = new Set<number>();
    const stats: StreamStats = { chunks: 0, payloads: 0, parts: 0, completed: false, raw: '' };

    const report = (part: vscode.LanguageModelResponsePart): void => {
      stats.parts += 1;
      progress.report(part);
    };

    const emitBuffered = (index: number, strict: boolean): boolean => {
      const buffer = buffers.get(index);
      if (!buffer || completed.has(index)) {
        return false;
      }
      if (!buffer.name) {
        if (strict) {
          this.log(`Dropping tool call #${index}: no function name was ever received.`);
          buffers.delete(index);
          completed.add(index);
        }
        return false;
      }
      const parsed = tryParseJson(buffer.args || '{}');
      if (!parsed.ok) {
        if (strict) {
          this.log(`Dropping tool call "${buffer.name}": arguments were not valid JSON.`);
          buffers.delete(index);
          completed.add(index);
        }
        return false;
      }
      const callId = buffer.id || `call_${Math.random().toString(36).slice(2, 10)}`;
      report(new vscode.LanguageModelToolCallPart(callId, buffer.name, parsed.value));
      buffers.delete(index);
      completed.add(index);
      return true;
    };

    const handlePayload = (payload: string): boolean => {
      // Record tool-call intent as soon as it appears on the wire, even if its JSON/arguments are truncated.
      if (payload.includes('"tool_calls"')) {
        onToolCallStart?.();
      }
      if (payload.trim() === '[DONE]') {
        stats.completed = true;
        for (const index of [...buffers.keys()]) {
          emitBuffered(index, true);
        }
        return false;
      }
      const json = tryParseJson(payload);
      if (!json.ok) {
        return true; // ignore keep-alives / malformed lines
      }
      const delta = readDelta(json.value);
      if (!delta) {
        return true;
      }
      if (delta.text) {
        report(new vscode.LanguageModelTextPart(delta.text));
      }
      for (const call of delta.toolCalls ?? []) {
        const buffer = buffers.get(call.index) ?? { args: '' };
        if (call.id) {
          buffer.id = call.id;
        }
        if (call.name) {
          buffer.name = call.name;
        }
        if (call.args) {
          buffer.args += call.args;
        }
        buffers.set(call.index, buffer);
        // Arguments arrive one fragment per delta, and the first delta usually
        // carries only the id/name with `arguments: ""`. Emitting here would
        // ship an empty {} input before the real arguments land (the model
        // would then run tools like Read with no `path`), so wait for
        // finish_reason / [DONE] / end of stream to flush.
      }
      if (delta.finishReason) {
        stats.completed = true;
        for (const index of [...buffers.keys()]) {
          emitBuffered(index, true);
        }
        return false;
      }
      return true;
    };

    try {
      while (!token.isCancellationRequested) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        stats.chunks += 1;
        const decoded = decoder.decode(value, { stream: true });
        if (stats.payloads === 0 && stats.raw.length < 262144) {
          stats.raw += decoded; // kept so a non-streamed body can still be read
        }
        const payloads = parser.push(decoded);
        stats.payloads += payloads.length;
        for (const payload of payloads) {
          if (!handlePayload(payload)) {
            return stats;
          }
        }
      }
      const trailing = parser.flush();
      stats.payloads += trailing.length;
      for (const payload of trailing) {
        handlePayload(payload);
      }
      for (const index of [...buffers.keys()]) {
        emitBuffered(index, true);
      }
      this.log(`Stream ended with ${stats.chunks} chunks`);
      return stats;
    } catch (error) {
      if (token.isCancellationRequested) {
        return stats; // the user stopped the request; not a failure
      }
      throw error; // timeout / socket reset — let the retry loop classify it
    } finally {
      reader.releaseLock();
    }
  }

  // ----------------------------------------------------------- fallback targets

  /**
   * Return model IDs that are safe to consider for fallback from this provider.
   * Required credentials and the base URL are checked before model discovery.
   */
  async getEligibleFallbackModelIds(): Promise<string[]> {
    const settings = readVendorSettings(this.spec);
    if (!settings.baseUrl) {
      return [];
    }

    const apiKey = await this.secrets.get(this.spec.secretKey);
    if (this.spec.requiresKey && !apiKey) {
      return [];
    }

    const cached = this.modelCache.get(this.spec.id);
    if (cached !== undefined) {
      return dedupe([...settings.modelIds, ...cached]);
    }

    const alreadyDiscovered = this.cache.map((entry) => entry.id);
    if (alreadyDiscovered.length > 0) {
      const ids = dedupe([...settings.modelIds, ...alreadyDiscovered]);
      this.modelCache.set(this.spec.id, ids);
      return ids;
    }

    try {
      const discovered = await this.fetchModelIds(settings.modelsUrl, apiKey, settings.baseUrl);
      const ids = dedupe([...settings.modelIds, ...discovered]);
      // Cache empty results too, so a failing models endpoint is not hammered
      // for every chat request. Refreshing the provider clears this cache.
      this.modelCache.set(this.spec.id, ids);
      this.log(`${this.spec.displayName}: fallback eligibility includes ${ids.length} model(s).`);
      return ids;
    } catch (error) {
      const configuredIds = dedupe(settings.modelIds);
      this.modelCache.set(this.spec.id, configuredIds);
      this.log(
        `${this.spec.displayName}: fallback model discovery failed (${describe(error)}); ` +
          `using ${configuredIds.length} explicitly configured model ID(s).`,
      );
      return configuredIds;
    }
  }

  /** Resolve a `modelId` or `vendor:modelId` reference into a concrete target. */
  private async resolveRef(
    ref: string,
    selected: vscode.LanguageModelChatInformation,
  ): Promise<ResolvedTarget> {
    const separator = ref.indexOf(':');
    const vendorPrefix = separator > 0 ? ref.slice(0, separator) : undefined;
    const isKnownVendor = vendorPrefix
      ? VENDORS.some((candidate) => candidate.id === vendorPrefix) && vendorPrefix !== this.vendor
      : false;

    if (isKnownVendor && vendorPrefix) {
      const other = this.registry.get(vendorPrefix as VendorId);
      if (!other) {
        throw new Error(`Provider "${vendorPrefix}" is not registered.`);
      }
      return other.resolveTarget(ref.slice(separator + 1));
    }
    if (ref === selected.id) {
      return this.selfTarget(selected);
    }
    return this.resolveTarget(ref);
  }

  /** Resolve a model id served by this provider (no credential prompting). */
  async resolveTarget(modelId: string): Promise<ResolvedTarget> {
    const cached = this.cache.find((entry) => entry.id === modelId);
    return this.selfTarget(cached ?? this.toModelInformation(modelId));
  }

  private async selfTarget(info: vscode.LanguageModelChatInformation): Promise<ResolvedTarget> {
    const settings = readVendorSettings(this.spec);
    if (!settings.baseUrl) {
      throw new Error(`${this.spec.displayName}: base URL is not configured.`);
    }
    const apiKey = await this.secrets.get(this.spec.secretKey);
    if (this.spec.requiresKey && !apiKey) {
      throw new Error(`${this.spec.displayName}: API key is not set.`);
    }
    return { vendor: this.vendor, info, baseUrl: settings.baseUrl, apiKey };
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') {
      return Math.ceil(text.length / 4);
    }
    let chars = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        chars += part.value.length;
      }
    }
    return Math.ceil(chars / 4);
  }
}

function isFreeModelRef(ref: string): boolean {
  return /free/i.test(ref);
}

function isQuotaLimitError(error: unknown): error is HttpError {
  if (!(error instanceof HttpError) || error.status !== 429) {
    return false;
  }
  const body = error.body ?? '';
  return /FreeUsageLimitError|free usage limit reached|quota(?:\s|_|-)*(?:exceeded|limit|reached)|insufficient quota/i.test(body);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function describe(error: unknown): string {
  if (error instanceof HttpError) {
    return error.body ? `${error.message} — ${error.body}` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
