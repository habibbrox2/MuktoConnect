import * as vscode from 'vscode';
import { readVendorSettings, VENDORS, VendorId, VendorSpec } from './config';
import { parseModelIds, sleep, backoffDelay } from './openai';
import { OpenAICompatProvider, ProviderRegistry, UnifiedLanguageModelProvider } from './provider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('MuktoConnect');
  const log = (message: string): void => output.appendLine(`[${new Date().toISOString()}] ${message}`);
  log('MuktoConnect activated.');

  // Respect an existing user or organization preference. If no chat default is
  // configured (or the previous MuktoConnect-Auto ID is still set), use Auto as the default for new chat conversations.
  const chatConfiguration = vscode.workspace.getConfiguration('chat');
  const configuredDefaultModel = chatConfiguration.get<string>('defaultModel');
  if (!configuredDefaultModel || configuredDefaultModel === 'muktoconnect:muktoconnect-auto') {
    void chatConfiguration.update(
      'defaultModel',
      'muktoconnect:auto',
      vscode.ConfigurationTarget.Global,
    ).then(
      () => log('Set chat.defaultModel to muktoconnect:auto (default missing or migrated from the previous Auto ID).'),
      (error: unknown) => log(`Could not set chat.defaultModel: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  const registry = new ProviderRegistry();

  for (const spec of VENDORS) {
    const provider = new OpenAICompatProvider(spec.id, spec, context.secrets, registry, log);
    registry.register(provider);

    context.subscriptions.push(
      vscode.commands.registerCommand(managementCommand(spec.id), () =>
        manageProvider(spec, provider, context, log),
      ),
    );
  }

  // Register exactly one VS Code-visible provider; it aggregates all configured backends.
  const unifiedProvider = new UnifiedLanguageModelProvider(
    VENDORS.map((spec) => registry.get(spec.id)).filter(
      (provider): provider is OpenAICompatProvider => provider !== undefined,
    ),
    log,
  );
  context.subscriptions.push(
    unifiedProvider,
    vscode.lm.registerLanguageModelChatProvider('muktoconnect', unifiedProvider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('muktoconnect.manageAll', async () => {
      const picked = await vscode.window.showQuickPick(
        VENDORS.map((spec) => ({ label: spec.displayName, description: spec.id, spec })),
        { title: 'Manage MuktoConnect Provider', placeHolder: 'Choose a backend to configure' },
      );
      if (picked) {
        const provider = registry.get(picked.spec.id);
        if (provider) {
          await manageProvider(picked.spec, provider, context, log);
        }
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('muktoconnect.showLogs', () => output.show(true)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('muktoconnect.diagnoseModelSelection', () => {
      const available = typeof vscode.lm?.registerLanguageModelChatProvider === 'function';
      log(`Model-selection runtime diagnostic: VS Code ${vscode.version}; app=${vscode.env.appName}; language-model provider API=${available ? 'available' : 'unavailable'}.`);
      log('The stable Language Model Chat Provider API does not expose a supported default-model-selection capability query. The proposed isDefault field is not a stable contract, so this diagnostic does not enable it or change model selection.');
      output.show(true);
      vscode.window.showInformationMessage(
        `Diagnostics recorded for VS Code ${vscode.version}. Stable API default-model selection is not exposed.`,
      );
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('muktoconnect.clearPromotedModel', () => {
      for (const spec of VENDORS) {
        const provider = registry.get(spec.id);
        if (provider) {
          provider.clearPromoted();
        }
      }
      vscode.window.showInformationMessage('MuktoConnect: auto-switched model cleared.');
      log('Auto-switched model cleared for all providers.');
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('muktoconnect.checkForUpdates', async () => {
      try {
        const response = await fetch('https://api.github.com/repos/habibbrox2/MuktoConnect/releases/latest');
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json() as { tag_name: string; html_url: string };
        if (!data.tag_name || !data.html_url) {
          throw new Error('Invalid release metadata');
        }
        const currentVersion = vscode.extensions.getExtension('habibbrox2.muktoconnect')?.packageJSON.version || '0.0.0';
        const latestVersion = data.tag_name.replace(/^v/, '').trim();
        if (!isValidSemver(latestVersion)) {
          throw new Error('Invalid version tag');
        }
        if (compareSemver(latestVersion, currentVersion) <= 0) {
          vscode.window.showInformationMessage('MuktoConnect is up to date.');
        } else {
          // Retry with backoff on transient errors
          let success = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const baseButtons: readonly string[] = ['Download', 'View Release'];
              const buttons = attempt > 0
                ? [...baseButtons, 'Retry']
                : baseButtons;
              const choice = await vscode.window.showInformationMessage(
                `MuktoConnect ${latestVersion} is available (current: ${currentVersion})`,
                ...buttons
              );
              if (choice === 'Retry') {
                await sleep(backoffDelay(attempt + 1, 1000)); // exponential backoff with jitter
                continue;
              }
              success = true;
              if (choice === 'Download') {
                vscode.env.openExternal(vscode.Uri.parse(data.html_url));
              } else if (choice === 'View Release') {
                vscode.env.openExternal(vscode.Uri.parse(data.html_url));
              }
              break;
            } catch {
              await sleep(backoffDelay(attempt + 1, 1000));
            }
          }
          if (!success) {
            vscode.window.showErrorMessage('Failed to check for updates after retries.');
            return;
          }
        }
        log(`Update check: current=${currentVersion}, latest=${latestVersion}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to check for updates: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
  // Check for updates on activation (once per day)
  const lastCheck = context.globalState.get<number>('muktoconnect.lastUpdateCheck', 0);
  const now = Date.now();
  if (now - lastCheck > 24 * 60 * 60 * 1000) {
    context.globalState.update('muktoconnect.lastUpdateCheck', now);
    vscode.commands.executeCommand('muktoconnect.checkForUpdates');
  }
}

function isValidSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function parseSemver(version: string): [number, number, number] | null {
  if (!isValidSemver(version)) {
    return null;
  }
  const core = version.split('-')[0].split('+')[0];
  const parts = core.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) {
    return null;
  }
  return [parts[0], parts[1], parts[2]];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    // Fallback to string comparison if parsing fails
    if (a === b) {
      return 0;
    }
    return a > b ? 1 : -1;
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] > pb[i] ? 1 : -1;
    }
  }
  return 0;
}

function managementCommand(vendor: VendorId): string {
  switch (vendor) {
    case 'muktodwar':
      return 'muktoconnect.manageMuktoDwar';
    case 'kilo':
      return 'muktoconnect.manageKilo';
    case 'opencode':
      return 'muktoconnect.manageOpenCode';
    default:
      return 'muktoconnect.manageCustom';
  }
}

interface ManageAction {
  readonly label: string;
  readonly description?: string;
  readonly run: () => Promise<void>;
}

async function manageProvider(
  spec: VendorSpec,
  provider: OpenAICompatProvider,
  context: vscode.ExtensionContext,
  log: (message: string) => void,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('muktoconnect');
  const update = (key: string, value: unknown): Thenable<void> =>
    config.update(key, value, vscode.ConfigurationTarget.Global);

  const hasKey = Boolean(await context.secrets.get(spec.secretKey));
  const settings = readVendorSettings(spec);

  const actions: ManageAction[] = [];

  if (spec.requiresKey) {
    actions.push({
      label: '$(key) Set API key',
      description: hasKey ? 'Stored — enter a new value to replace it' : 'Not set',
      run: async () => {
        const entered = await vscode.window.showInputBox({
          title: `${spec.displayName} API key`,
          prompt: 'Stored in VS Code SecretStorage and never written to settings.',
          password: true,
          ignoreFocusOut: true,
        });
        const trimmed = entered?.trim();
        if (trimmed) {
          await context.secrets.store(spec.secretKey, trimmed);
          provider.refresh();
          log(`${spec.displayName}: API key saved.`);
          vscode.window.showInformationMessage(`${spec.displayName} API key saved.`);
        }
      },
    });
    if (hasKey) {
      actions.push({
        label: '$(trash) Clear API key',
        run: async () => {
          await context.secrets.delete(spec.secretKey);
          provider.refresh();
          log(`${spec.displayName}: API key cleared.`);
        },
      });
    }
  }

  actions.push(
    {
      label: '$(server) Set base URL',
      description: settings.baseUrl || 'not set',
      run: async () => {
        const value = await vscode.window.showInputBox({
          title: `${spec.displayName} base URL`,
          prompt: 'OpenAI-compatible base URL (chat requests go to <base>/chat/completions).',
          value: settings.baseUrl,
          ignoreFocusOut: true,
        });
        if (value !== undefined) {
          await update(`${spec.id}.baseUrl`, value.trim());
          provider.refresh();
        }
      },
    },
    {
      label: '$(list-flat) Set models URL',
      description: settings.modelsUrl || 'defaults to <base>/models',
      run: async () => {
        const value = await vscode.window.showInputBox({
          title: `${spec.displayName} models URL`,
          prompt: 'Leave empty to derive it from the base URL.',
          value: settings.modelsUrl,
          ignoreFocusOut: true,
        });
        if (value !== undefined) {
          await update(`${spec.id}.modelsUrl`, value.trim());
          provider.refresh();
        }
      },
    },
    {
      label: '$(add) Add model ID',
      description: `${settings.modelIds.length} manual id(s)`,
      run: async () => {
        const value = await vscode.window.showInputBox({
          title: `${spec.displayName} model ID`,
          prompt: 'Model id to expose in Copilot Chat even if the models endpoint does not list it.',
          ignoreFocusOut: true,
        });
        const trimmed = value?.trim();
        if (trimmed) {
          await update(`${spec.id}.modelIds`, [...new Set([...settings.modelIds, trimmed])]);
          provider.refresh();
        }
      },
    },
    {
      label: '$(arrow-right) Add fallback model',
      description: settings.fallbackModels.length ? settings.fallbackModels.join(', ') : 'none',
      run: async () => {
        const value = await vscode.window.showInputBox({
          title: `${spec.displayName} fallback model`,
          prompt: 'Model id for this provider, or vendor:modelId for another provider (muktodwar:, kilo:, opencode:, custom:).',
          placeHolder: 'muktodwar:mukto-auto/free',
          ignoreFocusOut: true,
        });
        const trimmed = value?.trim();
        if (trimmed) {
          await update(`${spec.id}.fallbackModels`, [...new Set([...settings.fallbackModels, trimmed])]);
        }
      },
    },
    {
      label: '$(plug) Test connection',
      description: settings.baseUrl || 'base URL not set',
      run: async () => {
        await testConnection(spec, context, log);
      },
    },
    {
      label: '$(refresh) Refresh model list',
      run: async () => {
        provider.refresh();
        vscode.window.showInformationMessage(`${spec.displayName}: model list will refresh.`);
      },
    },
  );

  const picked = await vscode.window.showQuickPick(
    actions.map((action) => ({
      label: action.label,
      description: action.description,
      action,
    })),
    {
      title: `${spec.displayName}`,
      placeHolder: 'Configure how Copilot Chat talks to this provider',
    },
  );
  if (picked) {
    await picked.action.run();
  }
}

async function testConnection(
  spec: VendorSpec,
  context: vscode.ExtensionContext,
  log: (message: string) => void,
): Promise<void> {
  const settings = readVendorSettings(spec);
  if (!settings.baseUrl) {
    vscode.window.showErrorMessage(`${spec.displayName}: set a base URL first.`);
    return;
  }
  const apiKey = await context.secrets.get(spec.secretKey);
  if (spec.requiresKey && !apiKey) {
    vscode.window.showErrorMessage(`${spec.displayName}: set an API key first.`);
    return;
  }

  const url = settings.modelsUrl || `${settings.baseUrl}/models`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 300)}` : ''}`);
    }
    const ids = parseModelIds(await response.json());
    log(`${spec.displayName}: GET ${url} OK, ${ids.length} model(s).`);
    vscode.window.showInformationMessage(
      `${spec.displayName}: connected — ${ids.length} model(s) available at ${url}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${spec.displayName}: connection test failed — ${message}`);
    vscode.window.showErrorMessage(`${spec.displayName}: connection failed — ${message}`);
  }
}

export function deactivate(): void {
  // Providers are disposed through their subscriptions.
}
