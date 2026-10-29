# MuktoConnect

![MuktoConnect Banner](assets/logo-dark.png)

**Custom AI providers and models for GitHub Copilot Chat.**

MuktoConnect (মুক্তসংযোগ) adds custom AI models to GitHub Copilot Chat through VS Code's Language Model Chat Provider API. It streams responses and forwards tool calls/results using the endpoint's OpenAI-compatible format. By default, it does not change Copilot Chat's selected default, inject model labels into response text, automatically continue interrupted answers, or switch to another model after a failure.

[![GitHub](https://img.shields.io/badge/GitHub-habibbrox2/MuktoConnect-blue?logo=github)](https://github.com/habibbrox2/MuktoConnect) [![Release](https://img.shields.io/github/v/release/habibbrox2/MuktoConnect?logo=github)](https://github.com/habibbrox2/MuktoConnect/releases/latest)

**[Download Latest Release](https://github.com/habibbrox2/MuktoConnect/releases/latest)**

A sister project of [MuktoDwar](https://github.com/habibbrox2/MuktoDwar). This extension only talks to providers as a client — no MuktoDwar source code is included.

## Brand

![MuktoConnect mark](assets/icon.png)

| File | Purpose |
|---|---|
| [`assets/icon.svg`](assets/icon.svg) | Source mark — calligraphic Bangla `ম` on Bangladesh-green tile, its matra flows into MuktoDwar's gate crown with the Copilot Chat logo in the doorway |
| [`assets/icon.png`](assets/icon.png) | 128×128 extension icon |
| [`assets/icon-256.png`](assets/icon-256.png), [`assets/icon-512.png`](assets/icon-512.png) | Larger renders |
| [`assets/muktoconnect.ico`](assets/muktoconnect.ico) | Windows icon (16-256) |
| [`assets/logo-dark.svg`](assets/logo-dark.svg) / [`logo-dark.png`](assets/logo-dark.png) | Horizontal lockup for dark surfaces |
| [`assets/logo-light.svg`](assets/logo-light.svg) / [`logo-light.png`](assets/logo-light.png) | Horizontal lockup for light surfaces |

**Design:** Calligraphic Bangla letter `ম` (Nirmala UI) with its headline bar merging into MuktoDwar's gate crown. Flag-red disc (`#F42A41`) in the doorway contains the official GitHub Copilot Chat logo in white, on solid Bangladesh-green (`#006A4E`) background. No gradients.

Regenerate assets: `npm run brand:build`

## Supported Providers

| Vendor | Default URL | Auth | Notes |
|---|---|---|---|
| `muktodwar` | `http://127.0.0.1:8787/v1` | Gateway token | Local MuktoDwar gateway. Default model `mukto-auto/free` routes to allowlisted free models. |
| `kilo` | `https://ai-gateway.kilo.ai/api/v1` | Kilo API key | [Kilo Gateway](https://kilo.ai/). Models like `openai/gpt-5.4`. |
| `opencode` | `https://opencode.ai/inference/openai/v1` | Console API key | [OpenCode Console / Zen](https://opencode.ai/). |
| `custom` | *user-defined* | Optional | Any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, etc.) |

## Installation

```bash
npm install
npm run compile
```

Run in Extension Development Host: open this folder in VS Code, press `F5`. In the new window, go to Chat → Manage Models and enable **MuktoConnect**. All models from configured backends (MuktoDwar, Kilo, OpenCode, and Custom) appear under this single provider; model names include the backend ID to distinguish duplicate model IDs. Only concrete model IDs are exposed, so the selected model and the request target stay aligned. MuktoConnect does not write to `chat.defaultModel`; choose the desired model in Copilot Chat yourself. Responses contain only model output—no injected `_Model: ..._` prefix. VS Code's stable Language Model Chat Provider API exposes model names in the picker but does not provide a separate response-part field for overriding the native per-response model attribution.

Package and install:
```bash
npx @vscode/vsce package
code --install-extension ./muktoconnect-<version>.vsix
```

**Requirements:** VS Code 1.104+ with `languageModelChatProviders` API support.

## Configuration

Use `MuktoConnect: Manage <Provider> Provider` commands to configure:
- API keys (stored in VS Code SecretStorage)
- Base URLs and model list URLs
- Custom model IDs
- Fallback model chains (e.g., `muktodwar:mukto-auto/free` or `kilo:openai/gpt-5.4`)

**Unified model picker:** `Auto / MuktoConnect` is pinned at the top. It selects an eligible free model and, on a safe pre-output failure, switches/falls back only to eligible free models across configured providers. Paid models are never used by Auto. Concrete models follow alphabetically and use vendor-qualified IDs so duplicate IDs do not collide. Use `MuktoConnect: Manage All Providers` to configure backends.

Provider discovery is intentionally silent. If a required API key or base URL is missing, MuktoConnect exposes no models for that provider and does not show repeated prompts while Copilot Chat refreshes its model list. Configure providers explicitly with the management commands, then refresh the model list.

## Copilot Chat Agent compatibility

MuktoConnect contributes models through VS Code's Language Model Chat Provider API. Tool calling is enabled for exposed models, and the extension translates VS Code messages/tool results to OpenAI Chat Completions format. Agent behavior still depends on the upstream model and endpoint correctly supporting tool calls and the required OpenAI-compatible request format; provider registration alone cannot guarantee parity with every built-in Copilot model. MuktoConnect forwards the tools VS Code supplies (including a sub-agent tool when the host exposes one), but it cannot create or force-enable VS Code sub-agents itself; availability and orchestration remain controlled by VS Code Agent Mode and its configuration.

Verify in a VS Code Extension Development Host with a configured endpoint:
- Agent mode can call a tool and consume its result in a subsequent model turn.
- Multiple tool calls and streamed tool-call arguments are handled correctly.
- Cancellation, rate limits, interrupted streams, and fallback do not duplicate already-visible output or repeat tool execution.
- Models that support image input are not assumed to support it by MuktoConnect; image input remains disabled until multimodal request mapping is implemented and tested.

## Request retries and fallback

For concrete model selections, each model is attempted at most once by default (`retry.maxAttempts: 1`); if a request fails before output/tool execution begins, fallback and provider switching are enabled by default. Fallback candidates are tried once each, free models are preferred, and quota exhaustion restricts subsequent candidates to confirmed free models. `Auto / MuktoConnect` always restricts initial selection and fallback to eligible free models. MuktoConnect never restarts a request after visible output or after tool-call generation begins, preventing duplicate output/tool execution. Interrupted-text continuation remains disabled by default.

Configure under `muktoconnect.*`:
- `retry.maxAttempts` — defaults to `1` (no repeated provider request).
- `retry.autoContinue` — defaults to `false`.
- `retry.autoFallback` — defaults to `true`; set false to disable fallback for concrete model selections. `Auto / MuktoConnect` still uses free-only routing.
- `retry.autoSwitch` — defaults to `true`; successful fallback models can be preferred on later requests.
- `retry.baseDelayMs` and `request.timeoutMs` — retry delay and request timeout.

The provider can prevent its own duplicate retries/fallbacks, but it cannot override Copilot Agent's host-level decision to retry a failed tool call. The underlying tool's failure message and the model's tool-calling reliability still matter.

## Development

```bash
npm run compile      # TypeScript compile
npm run test:unit    # Run unit tests
npm run brand:build  # Regenerate brand assets
npm run watch        # Watch mode
```

## Release & Auto-update

Push a stable version tag such as `v0.1.6` after merging the release workflow to `main`. The workflow runs compilation, unit tests, and streaming integration tests before packaging a VSIX and creating a GitHub Release. The tag version is applied to the packaged extension.

To enable automatic updates for users who install MuktoConnect from the VS Code Marketplace, configure a **trusted publishing policy** for publisher `habibbrox2` that allows this GitHub repository and `.github/workflows/release.yml`, then the workflow publishes with GitHub Actions OIDC (`vsce publish --oidc`) without a long-lived Marketplace token. Optionally configure the repository Actions secret `OVSX_PAT` to publish to Open VSX for compatible editors. Marketplace publishing will fail closed until trusted publishing is configured; a GitHub Release/VSIX upload alone does **not** enable automatic updates for manually installed VSIX files. Marketplace-installed extensions use VS Code's built-in auto-update setting.

Do not publish a tag until the workflow changes are merged into `main`, the Marketplace publisher/trusted policy is configured, and any optional Open VSX credentials are ready. Use a new, unused version for every release.

## Testing

- Unit and streaming tests run in GitHub Actions.
- A successful provider test run does not prove native Copilot Agent end-to-end behavior. Verify Read/Edit/Shell, failed tool recovery, cancellation, and actual model attribution in a VS Code Extension Development Host before release.

## License

MIT