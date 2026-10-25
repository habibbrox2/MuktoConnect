import * as vscode from 'vscode';
import { readVendorSettings, VENDORS, VendorId, VendorSpec } from './config';
import { parseModelIds } from './openai';
import { OpenAICompatProvider, ProviderRegistry } from './provider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('MuktoConnect');
  const log = (message: string): void => output.appendLine(`[${new Date().toISOString()}] ${message}`);
  log('MuktoConnect activated.');

  const registry = new ProviderRegistry();

  for (const spec of VENDORS) {
    const provider = new OpenAICompatProvider(spec.id, spec, context.secrets, registry, log);
    registry.register(provider);

    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(spec.id, provider));
    context.subscriptions.push(
      vscode.commands.registerCommand(managementCommand(spec.id), () =>
        manageProvider(spec, provider, context, log),
      ),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('muktoconnect.showLogs', () => output.show(true)),
  );
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
