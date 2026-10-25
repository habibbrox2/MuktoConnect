# MuktoConnect

**Custom AI providers and models for GitHub Copilot Chat.**

MuktoConnect (মুক্তসংযোগ) is a standalone VS Code extension — a sister product of
[MuktoDwar](https://github.com/habibbrox2/MuktoDwar) — that registers your own
providers as first-class models in Copilot Chat, including **Agent mode**, using
the stable Language Model Chat Provider API. It streams responses, supports tool
calling, and **retries failures with backoff, then automatically fails over to
another model** when a model or provider is unhealthy.

MuktoConnect is its own project: no MuktoDwar source code lives here. It only
*talks to* MuktoDwar (or any other OpenAI-compatible endpoint) as a client.

## Brand

![MuktoConnect mark](assets/icon.png)

| File | Purpose |
|---|---|
| [`assets/icon.svg`](assets/icon.svg) | Source mark — calligraphic Bangla: bold `ম` on a Bangladesh-green tile, its শিরোরেখা flowing into MuktoDwar's gate crown, flag disc in the doorway |
| [`assets/copilot-chat.svg`](assets/copilot-chat.svg) | The official GitHub Copilot Chat logo (vector), inlined on the disc |
| [`assets/icon.png`](assets/icon.png) | 128×128 extension icon (declared as `icon` in package.json) |
| [`assets/icon-256.png`](assets/icon-256.png), [`assets/icon-512.png`](assets/icon-512.png) | Larger PNG renders |
| [`assets/muktoconnect.ico`](assets/muktoconnect.ico) | Windows icon, 16/32/48/64/128/256 |
| [`assets/logo-dark.svg`](assets/logo-dark.svg) / [`logo-dark.png`](assets/logo-dark.png) | Horizontal lockup for dark surfaces |
| [`assets/logo-light.svg`](assets/logo-light.svg) / [`logo-light.png`](assets/logo-light.png) | Horizontal lockup for light surfaces |

The mark is **calligraphic Bangla**: a bold `ম` (Nirmala UI) hangs from its
matra, and that headline bar (শিরোরেখা) runs right and merges into the crown of
MuktoDwar's free gate, whose doorway holds the **flag-red disc** carrying the
**official GitHub Copilot Chat logo** in white — all on a solid
**Bangladesh-green** tile. Solid shapes only, no gradients; 16px to 512px
renders straight from the sources (128px icon ≈ 3 KB).

Palette: Bangladesh green `#006A4E`, flag red `#F42A41`, white `#FFFFFF`.
Wordmark: Segoe UI Bold, −1.5 tracking — `Mukto` in white / `#0A2018`,
`Connect` in `#A7E8C9` / `#006A4E`; tagline `#8FD9B4` (dark) / `#3F5A4C`
(light). Building the PNGs requires a Bengali-capable font (Nirmala UI on
Windows) for the `ম` glyph.

Regenerate every PNG/ICO from the SVG sources with:

```bash
npm run brand:build
```

## Providers

| Vendor | Default base URL | Key | Notes |
|---|---|---|---|
| `muktodwar` | `http://127.0.0.1:8787/v1` | gateway token | Your local MuktoDwar gateway. Ships with `mukto-auto/free`, which resolves to any free model you allowlisted. |
| `kilo` | `https://ai-gateway.kilo.ai/api/v1` | Kilo API key | Kilo Gateway, OpenAI-compatible. Models look like `openai/gpt-5.4`. |
| `opencode` | `https://opencode.ai/inference/openai/v1` | Console API key | OpenCode Console / Zen. Note its model list lives at `https://opencode.ai/inference/v1/models`, which the default already uses. |
| `custom` | *(you set it)* | optional | Any OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, another gateway. |

Model discovery uses `GET <modelsUrl>` (`Authorization: Bearer <key>` when a key
is set). Any `data[]` / `models[]` / `results[]` payload shape is accepted, and
manually configured `modelIds` are always exposed even when that endpoint fails.

## Install / run

```bash
npm install
npm run compile          # tsc -> out/
npm run test:unit        # retry, fallback, SSE and delta tests
```

**Run in the Extension Development Host:** open this folder in VS Code and press
`F5`. In the new window open *Chat*, then **Manage Models** and enable the
models from MuktoDwar / Kilo Gateway / OpenCode / Custom.

**Package a VSIX:**

```bash
npx @vscode/vsce package
code --install-extension muktoconnect-0.1.0.vsix
```

Requires VS Code **1.104+** (the `languageModelChatProviders` contribution point
and `vscode.lm.registerLanguageModelChatProvider`). If your organization
disables Copilot's Bring Your Own Language Model Key policy, contributed models
are hidden by your administrator.

## Setup

Every provider has a **Manage** command (`MuktoConnect: Manage … Provider`) that
offers:

- **Set / clear API key** — stored in VS Code SecretStorage, never in settings,
  logs or the repository.
- **Set base URL / models URL** — override the defaults.
- **Add model ID** — expose a model that the models endpoint does not list.
- **Add fallback model** — a plain model id for this provider, or
  `vendor:modelId` to fail over to a *different* provider
  (e.g. `muktodwar:mukto-auto/free`).
- **Test connection** — `GET <modelsUrl>` and report how many models are visible.
- **Refresh model list** — re-runs discovery; the model picker updates.

Then open **Chat → Manage Models (Manage Language Models)** and enable the
models you want in the picker.

## Retry and automatic model fallback

For each request the extension builds an ordered candidate list:

1. the **promoted** model, if a previous request already failed over
   (`retry.autoSwitch`, on by default),
2. the model you selected in Copilot Chat,
3. the configured `fallbackModels` chain, in order.

Each candidate gets up to `retry.maxAttempts` attempts:

| Failure | Action |
|---|---|
| Network error / timeout, `408`, `409`, `425`, `429`, `5xx` | retry same model with exponential backoff (×2 + 25% jitter, capped at 8 s) |
| `400`, `401`, `402`, `403`, `404`, other `4xx` | switch to the next candidate immediately — no pointless retries |
| Cancellation | abort |
| Any output already streamed to the chat | abort — restarting would duplicate the visible answer |

When a fallback candidate answers successfully it is **promoted**: subsequent
requests try it first until it fails itself (then it is demoted). The switch is
announced with a status-bar message and written to the **MuktoConnect** output
channel (`MuktoConnect: Show Provider Logs`), not injected into the chat text.

Fallback targets from another vendor resolve through that vendor's own base URL
and stored key; if its key is missing the entry is skipped with a log line.

## Settings

All settings live under `muktoconnect.*`:

| Setting | Default | Purpose |
|---|---|---|
| `<vendor>.baseUrl` | per vendor | OpenAI-compatible base URL |
| `<vendor>.modelsUrl` | per vendor | Model list URL (`<baseUrl>/models` if empty) |
| `<vendor>.modelIds` | `["mukto-auto/free"]` for MuktoDwar, else `[]` | Always-exposed model ids |
| `<vendor>.fallbackModels` | Kilo/OpenCode → `muktodwar:mukto-auto/free` | Ordered failover chain |
| `retry.maxAttempts` | `3` | Attempts per model on retryable failures |
| `retry.baseDelayMs` | `500` | Backoff base (doubles each attempt + jitter) |
| `retry.autoSwitch` | `true` | Remember a model that took over |
| `request.timeoutMs` | `120000` | Per-attempt timeout |

## Development notes

- `src/openai.ts` is deliberately free of VS Code imports so the retry,
  backoff, fallback-ordering, SSE and delta logic runs under plain Node in
  `test/unit-tests.js`.
- `src/provider.ts` implements `LanguageModelChatProvider`:
  `provideLanguageModelChatInformation` (discovery),
  `provideLanguageModelChatResponse` (streaming + retry/fallback) and
  `provideTokenCount`.
- `src/messages.ts` converts VS Code parts to the OpenAI wire format, including
  assistant `tool_calls` and standalone `role: "tool"` result messages.

## Verified

- `npm run compile` — clean (`tsc -p ./`, strict mode).
- `npm run test:unit` — 21/21 passing (failure classification, backoff bounds,
  candidate ordering incl. promotion, SSE reassembly across chunk boundaries,
  text + tool-call delta assembly, model-list payload shapes).

Not yet verified in this environment: an end-to-end request through the Copilot
Chat UI, which requires launching the Extension Development Host against a
running gateway with real keys.
