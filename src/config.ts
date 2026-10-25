import * as vscode from 'vscode';

/** Providers contributed to Copilot Chat. */
export type VendorId = 'muktodwar' | 'kilo' | 'opencode' | 'custom';

export interface VendorSpec {
  readonly id: VendorId;
  readonly displayName: string;
  /** Base URL used when the user has not configured one. Empty means "must be configured". */
  readonly defaultBaseUrl: string;
  readonly defaultModelsUrl: string;
  /** Whether a key is expected; `custom` endpoints (e.g. Ollama) may be anonymous. */
  readonly requiresKey: boolean;
  /** SecretStorage key for the API key. */
  readonly secretKey: string;
}

export const VENDORS: readonly VendorSpec[] = [
  {
    id: 'muktodwar',
    displayName: 'MuktoDwar',
    defaultBaseUrl: 'http://127.0.0.1:8787/v1',
    defaultModelsUrl: 'http://127.0.0.1:8787/v1/models',
    requiresKey: true,
    secretKey: 'muktoconnect.muktodwar.apiKey',
  },
  {
    id: 'kilo',
    displayName: 'Kilo Gateway',
    defaultBaseUrl: 'https://ai-gateway.kilo.ai/api/v1',
    defaultModelsUrl: '',
    requiresKey: true,
    secretKey: 'muktoconnect.kilo.apiKey',
  },
  {
    id: 'opencode',
    displayName: 'OpenCode Console / Zen',
    defaultBaseUrl: 'https://opencode.ai/inference/openai/v1',
    defaultModelsUrl: 'https://opencode.ai/inference/v1/models',
    requiresKey: true,
    secretKey: 'muktoconnect.opencode.apiKey',
  },
  {
    id: 'custom',
    displayName: 'Custom OpenAI-Compatible',
    defaultBaseUrl: '',
    defaultModelsUrl: '',
    requiresKey: false,
    secretKey: 'muktoconnect.custom.apiKey',
  },
];

export function vendorSpec(id: VendorId): VendorSpec {
  const found = VENDORS.find((v) => v.id === id);
  if (!found) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return found;
}

export interface VendorSettings {
  readonly baseUrl: string;
  readonly modelsUrl: string;
  readonly modelIds: readonly string[];
  readonly fallbackModels: readonly string[];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function readVendorSettings(spec: VendorSpec): VendorSettings {
  const cfg = vscode.workspace.getConfiguration('muktoconnect');
  const baseUrl = (cfg.get<string>(`${spec.id}.baseUrl`) ?? spec.defaultBaseUrl).trim();
  const configuredModelsUrl = (cfg.get<string>(`${spec.id}.modelsUrl`) ?? '').trim();
  const modelsUrl = configuredModelsUrl || (baseUrl ? joinUrl(baseUrl, 'models') : '');
  return {
    baseUrl: stripTrailingSlash(baseUrl),
    modelsUrl: stripTrailingSlash(modelsUrl),
    modelIds: readStringArray(cfg.get(`${spec.id}.modelIds`)),
    fallbackModels: readStringArray(cfg.get(`${spec.id}.fallbackModels`)),
  };
}

export interface RetrySettings {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly autoSwitch: boolean;
  readonly timeoutMs: number;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readRetrySettings(): RetrySettings {
  const cfg = vscode.workspace.getConfiguration('muktoconnect');
  return {
    maxAttempts: Math.max(1, Math.floor(positiveOr(cfg.get<number>('retry.maxAttempts'), 3))),
    baseDelayMs: Math.max(0, positiveOr(cfg.get<number>('retry.baseDelayMs'), 500)),
    autoSwitch: cfg.get<boolean>('retry.autoSwitch') !== false,
    timeoutMs: positiveOr(cfg.get<number>('request.timeoutMs'), 120000),
  };
}

export function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.replace(/\/+$/, '') : url;
}

export function joinUrl(base: string, path: string): string {
  return `${stripTrailingSlash(base)}/${path.replace(/^\/+/, '')}`;
}
