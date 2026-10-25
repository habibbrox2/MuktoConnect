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
  HttpError,
  parseModelIds,
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

export class OpenAICompatProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  /** Last model list handed to VS Code, used to resolve fallback ids. */
  private cache: vscode.LanguageModelChatInformation[] = [];
  /** Model promoted by a successful automatic switch (session memory). */
  private promoted: string | undefined;
  private warnedAboutKey = false;

  constructor(
    readonly vendor: VendorId,
    private readonly spec: VendorSpec,
    private readonly secrets: vscode.SecretStorage,
    private readonly registry: ProviderRegistry,
    private readonly log: (message: string) => void,
  ) {}

  refresh(): void {
    this.cache = [];
    this.changeEmitter.fire();
  }

  clearPromoted(): void {
    this.promoted = undefined;
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

    const apiKey = await this.resolveApiKey(options.silent);
    if (this.spec.requiresKey && !apiKey) {
      if (!options.silent && !this.warnedAboutKey) {
        this.warnedAboutKey = true;
        vscode.window
          .showWarningMessage(
            `${this.spec.displayName}: no API key set. Run "MuktoConnect: Manage ${this.spec.displayName} Provider" to add one.`,
            'Manage',
          )
          .then((choice) => {
            if (choice === 'Manage') {
              void vscode.commands.executeCommand(`muktoconnect.manage${commandSuffix(this.spec.id)}`);
            }
          });
      }
      return [];
    }

    let discovered: string[] = [];
    try {
      discovered = await this.fetchModelIds(settings.modelsUrl, apiKey, settings.baseUrl);
      this.log(`${this.spec.displayName}: discovered ${discovered.length} models from ${settings.modelsUrl}`);
    } catch (error) {
      this.log(`${this.spec.displayName}: model list failed (${describe(error)}), falling back to configured ids.`);
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
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new HttpError(`GET ${url} -> ${response.status}`, response.status);
    }
    return parseModelIds(await response.json());
  }

  private async resolveApiKey(prompt: boolean): Promise<string | undefined> {
    const existing = await this.secrets.get(this.spec.secretKey);
    if (existing) {
      return existing;
    }
    if (!prompt || !this.spec.requiresKey) {
      return undefined;
    }
    const entered = await vscode.window.showInputBox({
      title: `${this.spec.displayName} API key`,
      prompt: `Enter your ${this.spec.displayName} API key (stored in VS Code SecretStorage)`,
      password: true,
      ignoreFocusOut: true,
    });
    const trimmed = entered?.trim();
    if (trimmed) {
      await this.secrets.store(this.spec.secretKey, trimmed);
      return trimmed;
    }
    return undefined;
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

    const refs = buildCandidateRefs(model.id, settings.fallbackModels, this.promoted, retry.autoSwitch);
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
    for (const entry of targets) {
      if (token.isCancellationRequested) {
        throw new Error('Request cancelled.');
      }
      if (!entry.target) {
        lastError = entry.error ?? lastError;
        continue;
      }

      const target = entry.target;
      let attempt = 0;
      const maxAttempts = Math.max(1, retry.maxAttempts);

      while (attempt < maxAttempts) {
        if (token.isCancellationRequested) {
          throw new Error('Request cancelled.');
        }
        attempt += 1;
        try {
          await this.streamOnce(target, messages, options, tracked, token, retry.timeoutMs);
          this.noteSuccess(model, target);
          return;
        } catch (error) {
          if (emitted) {
            // Partial output already reached the chat; restarting would duplicate it.
            throw error;
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
  ): Promise<void> {
    const url = `${stripTrailingSlash(target.baseUrl)}/chat/completions`;
    const body: Record<string, unknown> = {
      model: target.info.id,
      messages: toOpenAiMessages(messages),
      stream: true,
    };

    const tools = toOpenAiTools(options.tools);
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
      this.log(`${this.spec.displayName}: POST ${url} (model=${target.info.id})`);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.log(`${this.spec.displayName}: HTTP ${response.status} ${response.statusText} - ${text.slice(0, 200)}`);
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
      this.log(`${this.spec.displayName}: streaming response started`);
      await this.consume(response.body, progress, token);
      this.log(`${this.spec.displayName}: streaming response ended`);
    } finally {
      clearTimeout(timer);
      cancelSubscription.dispose();
    }
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
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const buffers = new Map<number, ToolCallBuffer>();
    const completed = new Set<number>();

    const emitBuffered = (index: number, strict: boolean): boolean => {
      const buffer = buffers.get(index);
      if (!buffer || completed.has(index)) {
        return false;
      }
      if (!buffer.name) {
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
      progress.report(new vscode.LanguageModelToolCallPart(callId, buffer.name, parsed.value));
      buffers.delete(index);
      completed.add(index);
      return true;
    };

    const handlePayload = (payload: string): boolean => {
      if (payload.trim() === '[DONE]') {
        for (const index of [...buffers.keys()]) {
          emitBuffered(index, false);
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
        progress.report(new vscode.LanguageModelTextPart(delta.text));
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
        emitBuffered(call.index, false);
      }
      if (delta.finishReason) {
        for (const index of [...buffers.keys()]) {
          emitBuffered(index, true);
        }
        return false;
      }
      return true;
    };

    try {
      let chunkCount = 0;
      while (!token.isCancellationRequested) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunkCount++;
        const decoded = decoder.decode(value, { stream: true });
        const payloads = parser.push(decoded);
        for (const payload of payloads) {
          if (!handlePayload(payload)) {
            return;
          }
        }
      }
      for (const payload of parser.flush()) {
        handlePayload(payload);
      }
      for (const index of [...buffers.keys()]) {
        emitBuffered(index, false);
      }
      this.log(`Stream ended with ${chunkCount} chunks`);
    } finally {
      reader.releaseLock();
    }
  }

  // ----------------------------------------------------------- fallback targets

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

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function commandSuffix(vendor: VendorId): string {
  switch (vendor) {
    case 'muktodwar':
      return 'MuktoDwar';
    case 'kilo':
      return 'Kilo';
    case 'opencode':
      return 'OpenCode';
    default:
      return 'Custom';
  }
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
