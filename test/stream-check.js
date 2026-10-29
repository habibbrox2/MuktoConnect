'use strict';

/**
 * Behavior check for src/provider.ts streaming paths, run against a local
 * HTTP server. Stubs the `vscode` module so the compiled extension code can
 * be driven under plain Node.
 *
 * Run with: node test/stream-check.js
 */

const http = require('node:http');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

// ------------------------------------------------------------------ vscode stub

const CONFIG = new Map();
class TextPart {
  constructor(value) {
    this.value = value;
  }
}
class ToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}
class ToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

const promptCounts = { warning: 0, input: 0 };

const vscodeStub = {
  EventEmitter: class {
    constructor() {
      this.listeners = [];
    }
    get event() {
      return (listener) => {
        this.listeners.push(listener);
        return { dispose() {} };
      };
    }
    fire() {
      for (const listener of this.listeners) listener();
    }
  },
  workspace: {
    getConfiguration: () => ({
      get: (key) => (CONFIG.has(key) ? CONFIG.get(key) : undefined),
    }),
  },
  window: {
    setStatusBarMessage: () => ({ dispose() {} }),
    showWarningMessage: async () => { promptCounts.warning += 1; return undefined; },
    showInputBox: async () => { promptCounts.input += 1; return undefined; },
  },
  LanguageModelTextPart: TextPart,
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelChatToolMode: { Required: 1, Optional: 2 },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

// ------------------------------------------------------------------ test server

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) {
    res.write(`data: ${event}\n\n`);
  }
  res.end();
}

// one scenario at a time; the name selects how the server answers
const scenario = { name: null, requests: 0 };
const requestBodies = [];
const server = http.createServer((req, res) => {
  const requestChunks = [];
  req.on('data', (chunk) => requestChunks.push(chunk));
  req.on('end', () => { if (req.method === 'POST') requestBodies.push(Buffer.concat(requestChunks).toString('utf8')); });
  req.resume();
  const name = scenario.name;
  if (name === 'sse-ok') {
    sse(res, [
      JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'world' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ]);
    return;
  }
  if (name === 'json-completion') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'c1',
        choices: [{ message: { role: 'assistant', content: 'Buffered answer' }, finish_reason: 'stop' }],
      }),
    );
    return;
  }
  if (name === 'json-error') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream unavailable' } }));
    return;
  }
  if (name === 'html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>502 Bad Gateway</body></html>');
    return;
  }
  if (name === 'empty') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end();
    return;
  }
  if (name === 'sse-no-content') {
    sse(res, [
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      '[DONE]',
    ]);
    return;
  }
  if (name === 'midstream-reset') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': keep-alive\n\n');
    setTimeout(() => res.destroy(), 10);
    return;
  }
  if (name === 'quota-free-fallback' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'paid-other' }, { id: 'free-model' }, { id: 'paid-model' }] }));
    return;
  }
  if (name === 'quota-free-fallback' && req.method === 'POST') {
    req.on('end', () => {
      scenario.requests += 1;
      const body = JSON.parse(requestBodies[requestBodies.length - 1]);
      if (body.model === 'paid-model') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' } }));
        return;
      }
      if (body.model === 'free-model') {
        sse(res, [
          JSON.stringify({ choices: [{ delta: { content: 'Free fallback worked.' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          '[DONE]',
        ]);
        return;
      }
      res.writeHead(500);
      res.end('Unexpected paid fallback');
    });
    return;
  }
  if (name === 'toolcall-partial-truncated' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Make a second model eligible so the test proves we refuse to fail over after tool intent.
    res.end(JSON.stringify({ data: [{ id: 'fallback-model' }] }));
    return;
  }
  if (name === 'toolcall-partial-truncated' && req.method === 'POST') {
    scenario.requests += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Before tool call ' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_partial', function: { name: 'read_file', arguments: '{"path":' } }] } }] })}\n\n`);
    res.end();
    return;
  }
  if (name === 'partial-truncated' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  if (name === 'partial-truncated') {
    scenario.requests += 1;
    if (scenario.requests === 1) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial answer ' } }] })}\n\n`);
      res.end();
      return;
    }
    sse(res, [
      JSON.stringify({ choices: [{ delta: { content: 'continued safely.' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ]);
    return;
  }
  if (name === 'toolcall-multiple') {
    sse(res, [
      JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_read', function: { name: 'read_file', arguments: '' } },
        { index: 1, id: 'call_list', function: { name: 'list_dir', arguments: '' } },
      ] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: '{"path":"src/app.ts"}' } },
        { index: 1, function: { arguments: '{"path":"src"}' } },
      ] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ]);
    return;
  }
  if (name === 'toolcall-fragmented') {
    // Kilo/OpenAI style: first delta carries id + name with empty arguments,
    // the JSON arrives one fragment per delta, finish_reason comes last.
    sse(res, [
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] } },
        ],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"src/main.ts"}' } }] } }],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ]);
    return;
  }
  if (name === 'toolcall-nofinish') {
    // Some gateways never send finish_reason and just end with [DONE].
    sse(res, [
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_7', function: { name: 'ls', arguments: '' } }] } },
        ],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"dir":"src"}' } }] } }],
      }),
      '[DONE]',
    ]);
    return;
  }
  if (name === 'stall') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': keep-alive\n\n');
    // never finish — forces the request timeout to fire mid-stream
    return;
  }
  res.writeHead(404);
  res.end();
});

// ------------------------------------------------------------------ provider run

const buildDir = process.env.MUKTO_BUILD || path.join(__dirname, '..', 'out');
const { OpenAICompatProvider, ProviderRegistry } = require(path.join(buildDir, 'provider.js'));
const { toOpenAiMessages } = require(path.join(buildDir, 'messages.js'));

const secrets = new Map();
const secretStorage = {
  get: async (key) => secrets.get(key),
  store: async (key, value) => secrets.set(key, value),
};

const logs = [];
const spec = {
  id: 'custom',
  displayName: 'Custom OpenAI-Compatible',
  defaultBaseUrl: '',
  defaultModelsUrl: '',
  requiresKey: false,
  secretKey: 'muktoconnect.custom.apiKey',
};

function makeProvider(baseUrl, extra) {
  const overrides = extra || {};
  CONFIG.clear();
  CONFIG.set('custom.baseUrl', baseUrl);
  CONFIG.set('custom.modelsUrl', '');
  CONFIG.set('custom.modelIds', []);
  CONFIG.set('custom.fallbackModels', []);
  CONFIG.set('retry.maxAttempts', 1);
  CONFIG.set('retry.baseDelayMs', 10);
  CONFIG.set('retry.autoSwitch', false);
  CONFIG.set('retry.autoContinue', overrides.autoContinue !== false);
  CONFIG.set('request.timeoutMs', overrides.timeoutMs || 5000);
  const registry = new ProviderRegistry();
  const provider = new OpenAICompatProvider('custom', spec, secretStorage, registry, (m) => logs.push(m));
  registry.register(provider);
  return provider;
}

function makeModel(id) {
  return {
    id: id || 'test-model',
    name: id || 'test-model',
    family: 'custom',
    version: '1.0.0',
    tooltip: 'test',
    detail: 'test',
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    capabilities: { imageInput: false, toolCalling: true },
  };
}

function makeToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };
}

function makeMessages() {
  return [
    {
      role: vscodeStub.LanguageModelChatMessageRole.User,
      content: [new TextPart('Say hello')],
    },
  ];
}

async function run(baseUrl, extra, modelId, tools) {
  const provider = makeProvider(baseUrl, extra);
  const parts = [];
  await provider.provideLanguageModelChatResponse(
    makeModel(modelId),
    makeMessages(),
    { modelOptions: {}, tools },
    { report: (part) => parts.push(part) },
    makeToken(),
  );
  return parts;
}

// ------------------------------------------------------------------ scenarios

const results = [];

async function check(route, label, fn) {
  scenario.name = route;
  try {
    await fn();
    results.push({ name: label, ok: true });
  } catch (error) {
    results.push({ name: label, ok: false, error });
  }
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  await check('sse-ok', 'missing required credentials never prompt during repeated model discovery', async () => {
    // Populate the custom provider's base URL, then simulate required authentication.
    makeProvider(base);
    const requiredSpec = { ...spec, requiresKey: true };
    const requiredProvider = new OpenAICompatProvider('custom', requiredSpec, secretStorage, new ProviderRegistry(), (m) => logs.push(m));
    const before = { ...promptCounts };
    const first = await requiredProvider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    const second = await requiredProvider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    assert.deepStrictEqual(first, []);
    assert.deepStrictEqual(second, []);
    assert.deepStrictEqual(promptCounts, before, 'discovery must not open warning or input prompts');
  });

  await check('sse-ok', 'Copilot tool calls and tool results map to OpenAI message roles and call ids', async () => {
    const mapped = toOpenAiMessages([
      {
        role: vscodeStub.LanguageModelChatMessageRole.Assistant,
        content: [new TextPart('I will inspect the file.'), new ToolCallPart('call_read', 'read_file', { path: 'src/app.ts' })],
      },
      {
        role: vscodeStub.LanguageModelChatMessageRole.User,
        content: [new ToolResultPart('call_read', [new TextPart('export const answer = 42;')])],
      },
    ]);
    assert.deepStrictEqual(mapped, [
      { role: 'assistant', content: 'I will inspect the file.' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } },
      ] },
      { role: 'tool', content: 'export const answer = 42;', tool_call_id: 'call_read' },
    ]);
  });

  await check('sse-ok', 'streamed SSE response is passed through', async () => {
    const parts = await run(base);
    const text = parts.map((p) => (p instanceof TextPart ? p.value : '')).join('');
    assert.strictEqual(text, 'Hello world');
  });

  await check('sse-ok', 'requests silently cap model tools at 128 without a warning', async () => {
    requestBodies.length = 0;
    const tools = Array.from({ length: 138 }, (_, index) => ({
      name: `tool_${String(index).padStart(3, '0')}`,
      description: `Tool number ${index}`,
      inputSchema: { type: 'object', properties: {} },
    }));
    await run(base, {}, undefined, tools);
    const body = JSON.parse(requestBodies[requestBodies.length - 1]);
    assert.strictEqual(body.tools.length, 128, 'must never send more than 128 tool definitions');
    assert.strictEqual(body.tool_choice, 'auto', 'must explicitly enable automatic tool selection when tools are available');
    assert.strictEqual(body.tools[0].function.name, 'tool_000');
    assert.strictEqual(body.tools[127].function.name, 'tool_127');
  });

  await check('json-completion', 'gateway that ignores stream:true still answers', async () => {
    const parts = await run(base);
    const text = parts.map((p) => (p instanceof TextPart ? p.value : '')).join('');
    assert.strictEqual(text, 'Buffered answer');
  });

  await check('json-error', 'JSON error body with 200 fails instead of resolving empty', async () => {
    let parts = [];
    try {
      parts = await run(base);
    } catch (error) {
      assert.ok(/expected an SSE stream/.test(error.message), `message: ${error.message}`);
      assert.ok(/upstream unavailable/.test(error.message), `body preview missing: ${error.message}`);
      return;
    }
    assert.fail(`resolved with ${parts.length} parts instead of throwing`);
  });

  await check('html', 'HTML body with 200 fails instead of resolving empty', async () => {
    try {
      const parts = await run(base);
      assert.fail(`resolved with ${parts.length} parts instead of throwing`);
    } catch (error) {
      assert.ok(/expected an SSE stream/.test(error.message), `message: ${error.message}`);
    }
  });

  await check('empty', 'empty body fails instead of resolving empty', async () => {
    try {
      const parts = await run(base);
      assert.fail(`resolved with ${parts.length} parts instead of throwing`);
    } catch (error) {
      assert.ok(/response body was empty/.test(error.message), `message: ${error.message}`);
    }
  });

  await check('sse-no-content', 'SSE stream with no content fails instead of resolving empty', async () => {
    try {
      const parts = await run(base);
      assert.fail(`resolved with ${parts.length} parts instead of throwing`);
    } catch (error) {
      assert.ok(/without any message content/.test(error.message), `message: ${error.message}`);
    }
  });

  await check('midstream-reset', 'mid-stream connection reset surfaces as a failed attempt', async () => {
    let parts = [];
    try {
      parts = await run(base);
    } catch (error) {
      assert.ok(error instanceof Error && error.message, 'threw without a message');
      return;
    }
    assert.fail(`resolved with ${parts.length} parts instead of throwing`);
  });

  await check('partial-truncated', 'opt-in text-only continuation does not repeat partial text', async () => {
    CONFIG.set('retry.autoContinue', true);
    scenario.requests = 0;
    requestBodies.length = 0;
    const parts = await run(base);
    const text = parts.map((part) => (part instanceof TextPart ? part.value : '')).join('');
    assert.strictEqual(text, 'Partial answer continued safely.');
    assert.strictEqual(scenario.requests, 2, 'expected initial request plus one continuation');
    const body = JSON.parse(requestBodies[1]);
    assert.strictEqual(body.messages[1].role, 'assistant');
    assert.strictEqual(body.messages[1].content, 'Partial answer ');
    assert.strictEqual(body.messages[2].role, 'user');
    assert.match(body.messages[2].content, /Continue the previous answer/);
    CONFIG.delete('retry.autoContinue');
  });

  await check('quota-free-fallback', 'fallback is disabled by default and selected-model errors surface directly', async () => {
    scenario.requests = 0;
    requestBodies.length = 0;
    try {
      await run(base, {}, 'paid-model');
      assert.fail('expected selected model quota error');
    } catch (error) {
      assert.ok(/all eligible candidate models failed/.test(error.message), `message: ${error.message}`);
    }
    assert.strictEqual(scenario.requests, 1, 'default must not query or invoke a fallback model');
  });

  await check('quota-free-fallback', 'opt-in fallback skips quota-limited models and prefers free fallback models', async () => {
    CONFIG.set('retry.autoFallback', true);
    scenario.requests = 0;
    requestBodies.length = 0;
    const parts = await run(base, {}, 'paid-model');
    const text = parts.map((part) => (part instanceof TextPart ? part.value : '')).join('');
    assert.strictEqual(text, 'Free fallback worked.');
    assert.strictEqual(scenario.requests, 2, 'quota-limited model should be called once, then free fallback once');
    const bodies = requestBodies.map((body) => JSON.parse(body));
    assert.deepStrictEqual(bodies.map((body) => body.model), ['paid-model', 'free-model']);
    assert.ok(logs.some((line) => /quota limit detected.*paid-model.*cooling down for 2s/.test(line)), 'Retry-After cooldown should be recorded');
    CONFIG.delete('retry.autoFallback');
  });

  await check('toolcall-partial-truncated', 'partial tool-call streams never trigger text continuation', async () => {
    scenario.requests = 0;
    requestBodies.length = 0;
    try {
      await run(base);
      assert.fail('expected interrupted tool-call stream to fail');
    } catch (error) {
      assert.ok(error instanceof Error && error.message, 'should surface the interrupted stream error');
    }
    assert.strictEqual(scenario.requests, 1, 'must not issue a continuation or fallback request after tool-call generation starts');
    assert.strictEqual(requestBodies.length, 1);
    assert.strictEqual(JSON.parse(requestBodies[0]).model, 'test-model');
  });

  await check('stall', 'a stream that stalls past request.timeoutMs fails the attempt', async () => {
    let parts = [];
    try {
      parts = await run(base, { timeoutMs: 400 });
    } catch (error) {
      assert.ok(/timed out/.test(error.message), `message: ${error.message}`);
      return;
    }
    assert.fail(`resolved with ${parts.length} parts instead of throwing`);
  });

  await check('toolcall-multiple', 'multiple parallel tool calls preserve independent ids, names, and arguments', async () => {
    const parts = await run(base);
    const calls = parts.filter((part) => part instanceof ToolCallPart);
    assert.strictEqual(calls.length, 2, `expected 2 tool calls, got ${JSON.stringify(parts)}`);
    assert.deepStrictEqual(calls.map((call) => ({ id: call.callId, name: call.name, input: call.input })), [
      { id: 'call_read', name: 'read_file', input: { path: 'src/app.ts' } },
      { id: 'call_list', name: 'list_dir', input: { path: 'src' } },
    ]);
  });

  await check('toolcall-fragmented', 'fragmented tool call streams with its full arguments', async () => {
    const parts = await run(base);
    const calls = parts.filter((part) => part instanceof ToolCallPart);
    assert.strictEqual(calls.length, 1, `expected 1 tool call, got ${JSON.stringify(parts)}`);
    assert.strictEqual(calls[0].name, 'read_file');
    assert.deepStrictEqual(calls[0].input, { path: 'src/main.ts' });
  });

  await check('toolcall-nofinish', 'tool call without finish_reason is flushed at [DONE]', async () => {
    const parts = await run(base);
    const calls = parts.filter((part) => part instanceof ToolCallPart);
    assert.strictEqual(calls.length, 1, `expected 1 tool call, got ${JSON.stringify(parts)}`);
    assert.strictEqual(calls[0].name, 'ls');
    assert.deepStrictEqual(calls[0].input, { dir: 'src' });
  });

  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  server.close();

  const failed = results.filter((r) => !r.ok);
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
    if (!result.ok) {
      console.log(`      ${result.error && (result.error.stack || result.error)}`);
    }
  }
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  if (process.env.MUKTO_LOGS) {
    console.log('\n--- provider log ---');
    console.log(logs.join('\n'));
  }
  process.exit(failed.length > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
