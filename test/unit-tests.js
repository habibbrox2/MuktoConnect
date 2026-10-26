'use strict';

/**
 * Unit tests for the pure OpenAI/retry/fallback logic (src/openai.ts).
 * Run with: npm run test:unit
 */

const assert = require('node:assert');
const path = require('node:path');
const {
  SseParser,
  classifyFailure,
  backoffDelay,
  buildCandidateRefs,
  filterEligibleFallbackRefs,
  parseModelIds,
  readDelta,
  tryParseJson,
  parseNonStreamedCompletion,
  HttpError,
} = require(path.join(__dirname, '..', 'out', 'openai.js'));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

// ---------------------------------------------------------------- failure kinds

test('SSE parser joins multiple data lines in one event', () => {
  const parser = new SseParser();
  assert.deepStrictEqual(parser.push('data: {"choices":\ndata: []}\n\n'), ['{"choices":\n[]}' ]);
  assert.deepStrictEqual(parser.push(': keep-alive\n\n'), []);
});

test('SSE parser flushes a final event without a blank-line terminator', () => {
  const parser = new SseParser();
  assert.deepStrictEqual(parser.push('data: [DONE]'), []);
  assert.deepStrictEqual(parser.flush(), ['[DONE]']);
});

test('transient statuses are retried', () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504, 529]) {
    assert.strictEqual(classifyFailure(status), 'retry', `status ${status}`);
  }
});

test('network errors (no status) are retried', () => {
  assert.strictEqual(classifyFailure(undefined), 'retry');
});

test('model and auth failures switch model instead of retrying', () => {
  for (const status of [400, 401, 402, 403, 404, 413, 422]) {
    assert.strictEqual(classifyFailure(status), 'switch', `status ${status}`);
  }
});

test('cancellation is fatal', () => {
  assert.strictEqual(classifyFailure(500, true), 'fatal');
});

test('tryParseJson rejects arrays and primitives as tool inputs', () => {
  assert.deepStrictEqual(tryParseJson('{"path":"src/main.ts"}'), {
    ok: true,
    value: { path: 'src/main.ts' },
  });
  assert.deepStrictEqual(tryParseJson('["not", "an", "object"]'), { ok: false });
  assert.deepStrictEqual(tryParseJson('null'), { ok: false });
  assert.deepStrictEqual(tryParseJson('"text"'), { ok: false });
});

test('HttpError carries status and body', () => {
  const error = new HttpError('boom', 429, 'slow down');
  assert.strictEqual(error.status, 429);
  assert.strictEqual(error.body, 'slow down');
  assert.ok(error instanceof Error);
});

// --------------------------------------------------------------------- backoff

test('backoff grows exponentially and stays within the jitter band', () => {
  const first = backoffDelay(1, 500);
  const second = backoffDelay(2, 500);
  const third = backoffDelay(3, 500);
  assert.ok(first >= 500 && first <= 625, `attempt1=${first}`);
  assert.ok(second >= 1000 && second <= 1250, `attempt2=${second}`);
  assert.ok(third >= 2000 && third <= 2500, `attempt3=${third}`);
  assert.ok(backoffDelay(10, 500) <= 10000, 'capped with jitter');
});

// ------------------------------------------------------------ candidate ordering

test('candidates run selected model first when nothing was promoted', () => {
  assert.deepStrictEqual(
    buildCandidateRefs('primary', ['a', 'b'], undefined, true),
    ['primary', 'a', 'b'],
  );
});

test('promoted model jumps ahead when auto-switch is on', () => {
  assert.deepStrictEqual(
    buildCandidateRefs('primary', ['b'], 'promoted', true),
    ['promoted', 'primary', 'b'],
  );
});

test('auto-switch off ignores the promoted model', () => {
  assert.deepStrictEqual(
    buildCandidateRefs('primary', ['b'], 'promoted', false),
    ['primary', 'b'],
  );
});

test('duplicates and empty entries are dropped, selected is never repeated', () => {
  assert.deepStrictEqual(
    buildCandidateRefs('primary', ['primary', 'x', 'x', '  '], undefined, true),
    ['primary', 'x'],
  );
});

test('configured fallbacks exclude providers without eligible credentials/models', () => {
  const eligible = new Set(['opencode:free-model', 'kilo:paid-model', 'local-model']);
  assert.deepStrictEqual(
    filterEligibleFallbackRefs(
      ['muktodwar:mukto-auto/free', 'opencode:free-model', 'kilo:paid-model', 'missing', 'local-model'],
      eligible,
    ),
    ['opencode:free-model', 'kilo:paid-model', 'local-model'],
  );
});

test('fallback eligibility filtering preserves order and removes duplicates/whitespace', () => {
  const eligible = new Set(['opencode:model-a', 'kilo:model-b']);
  assert.deepStrictEqual(
    filterEligibleFallbackRefs(
      [' opencode:model-a ', 'kilo:model-b', 'opencode:model-a', '', 'not-configured'],
      eligible,
    ),
    ['opencode:model-a', 'kilo:model-b'],
  );
});

test('provider-qualified and local fallback references are distinct', () => {
  const eligible = new Set(['model-a', 'opencode:model-a']);
  assert.deepStrictEqual(
    filterEligibleFallbackRefs(['model-a', 'opencode:model-a', 'kilo:model-a'], eligible),
    ['model-a', 'opencode:model-a'],
  );
});

// ------------------------------------------------------------------- SSE parsing

test('SSE parser handles event boundaries split across chunks', () => {
  const parser = new SseParser();
  assert.deepStrictEqual(parser.push('data: {"a":1}\n'), []);
  assert.deepStrictEqual(parser.push('\n' + 'data: {"b":2}\n'), ['{"a":1}']);
  assert.deepStrictEqual(parser.push('\ndata: [DONE]\n\n'), ['{"b":2}', '[DONE]']);
  assert.deepStrictEqual(parser.push(''), []);
});

test('SSE parser ignores event/comment lines and CRLF', () => {
  const parser = new SseParser();
  assert.deepStrictEqual(parser.push(': keep-alive\r\ndata: {"a":1}\r\n\r\n'), ['{"a":1}']);
});

test('SSE parser flushes a trailing payload without a newline', () => {
  const parser = new SseParser();
  assert.deepStrictEqual(parser.push('data: {"tail":true}'), []);
  assert.deepStrictEqual(parser.flush(), ['{"tail":true}']);
});

test('SSE parser tolerates a payload split mid-line', () => {
  const parser = new SseParser();
  assert.deepStrictEqual(parser.push('data: {"par'), []);
  assert.deepStrictEqual(parser.push('tial":true}\n\n'), ['{"partial":true}']);
});

// ------------------------------------------------------------------- delta reads

test('readDelta extracts text deltas', () => {
  const delta = readDelta({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] });
  assert.strictEqual(delta.text, 'Hello');
  assert.strictEqual(delta.finishReason, undefined);
});

test('readDelta extracts and reports finish reason', () => {
  const delta = readDelta({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  assert.strictEqual(delta.finishReason, 'tool_calls');
});

test('readDelta extracts streamed tool calls with index/id/name/args', () => {
  const delta = readDelta({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } },
            { index: 0, function: { arguments: '"a.ts"}' } },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  assert.strictEqual(delta.toolCalls.length, 2);
  assert.strictEqual(delta.toolCalls[0].id, 'call_1');
  assert.strictEqual(delta.toolCalls[0].name, 'read_file');
  assert.strictEqual(delta.toolCalls[1].index, 0);
  assert.strictEqual(delta.toolCalls[0].args + delta.toolCalls[1].args, '{"path":"a.ts"}');
});

test('readDelta ignores usage-only and malformed chunks', () => {
  assert.strictEqual(readDelta({ usage: { total_tokens: 3 } }), undefined);
  assert.strictEqual(readDelta('not an object'), undefined);
  assert.strictEqual(readDelta({ choices: [] }), undefined);
});

test('incremental stream simulation assembles text and tool arguments', () => {
  const payloads = [
    '{"choices":[{"delta":{"content":"Running "}}]}',
    '{"choices":[{"delta":{"content":"now."}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ls","arguments":"{"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"dir\\":"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" true}"}}]},"finish_reason":"tool_calls"}]}',
    '[DONE]',
  ];

  const parser = new SseParser();
  const text = [];
  const toolArgs = new Map();
  let toolName;
  let finishReason = null;
  let sawDone = false;

  // split the payloads randomly across chunks to exercise reassembly
  const wire = payloads.map((p) => `data: ${p}\n\n`).join('');
  const chunks = [];
  for (let i = 0; i < wire.length; i += 17) {
    chunks.push(wire.slice(i, i + 17));
  }

  for (const chunk of chunks) {
    for (const payload of parser.push(chunk)) {
      if (payload.trim() === '[DONE]') {
        sawDone = true;
        continue;
      }
      const json = tryParseJson(payload);
      assert.ok(json.ok, `payload should parse: ${payload}`);
      const delta = readDelta(json.value);
      if (!delta) {
        continue;
      }
      if (delta.text) {
        text.push(delta.text);
      }
      for (const call of delta.toolCalls || []) {
        if (call.name) {
          toolName = call.name;
        }
        toolArgs.set(call.index, (toolArgs.get(call.index) || '') + (call.args || ''));
      }
      if (delta.finishReason) {
        finishReason = delta.finishReason;
      }
    }
  }

  assert.strictEqual(text.join(''), 'Running now.');
  assert.strictEqual(toolName, 'ls');
  const parsed = tryParseJson(toolArgs.get(0));
  assert.ok(parsed.ok, 'tool arguments should reassemble into valid JSON');
  assert.deepStrictEqual(parsed.value, { dir: true });
  assert.strictEqual(finishReason, 'tool_calls');
  assert.strictEqual(sawDone, true);
});

// ------------------------------------------------- non-streamed completions

test('parseNonStreamedCompletion reads a buffered text completion', () => {
  const body = JSON.stringify({
    id: 'c1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
  });
  const parsed = parseNonStreamedCompletion(body);
  assert.strictEqual(parsed.text, 'Hello there');
  assert.strictEqual(parsed.toolCalls, undefined);
});

test('parseNonStreamedCompletion reads buffered tool calls with valid JSON arguments', () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
            { type: 'function', function: { name: 'ls', arguments: 'not json' } },
          ],
        },
      },
    ],
  });
  const parsed = parseNonStreamedCompletion(body);
  assert.strictEqual(parsed.toolCalls.length, 2);
  assert.strictEqual(parsed.toolCalls[0].id, 'call_9');
  assert.ok(parsed.toolCalls[1].id.startsWith('call_'), 'missing ids are synthesized');
  const args = tryParseJson(parsed.toolCalls[0].function.arguments);
  assert.ok(args.ok);
  assert.deepStrictEqual(args.value, { path: 'a.ts' });
});

test('parseNonStreamedCompletion rejects error bodies, HTML and empty completions', () => {
  assert.strictEqual(parseNonStreamedCompletion('{"error":{"message":"quota"}}'), undefined);
  assert.strictEqual(parseNonStreamedCompletion('<html><body>502</body></html>'), undefined);
  assert.strictEqual(parseNonStreamedCompletion('not json at all'), undefined);
  assert.strictEqual(
    parseNonStreamedCompletion(JSON.stringify({ choices: [{ message: { content: '' } }] })),
    undefined,
  );
  assert.strictEqual(parseNonStreamedCompletion(''), undefined);
});

test('a streamed body is not mistaken for a buffered completion', () => {
  // SSE payloads arrive one line at a time; a partial line must not parse
  assert.strictEqual(parseNonStreamedCompletion('data: {"choices":['), undefined);
});

// ------------------------------------------------------------------ model lists

test('parseModelIds reads OpenAI-style data arrays', () => {
  const ids = parseModelIds({ object: 'list', data: [{ id: 'a' }, { id: 'b' }] });
  assert.deepStrictEqual(ids, ['a', 'b']);
});

test('parseModelIds reads MuktoDwar/alternative shapes', () => {
  assert.deepStrictEqual(parseModelIds({ models: [{ id: 'mukto-auto/free' }] }), ['mukto-auto/free']);
  assert.deepStrictEqual(parseModelIds({ results: [{ model: 'x' }] }), ['x']);
  assert.deepStrictEqual(parseModelIds(['one', 'two ']), ['one', 'two']);
  assert.deepStrictEqual(parseModelIds({ data: [{ name: 'n' }, null, 42] }), ['n']);
  assert.deepStrictEqual(parseModelIds(undefined), []);
});

// ---------------------------------------------------------------------- reporting

const total = passed + failures.length;
for (const failure of failures) {
  console.error(`✗ ${failure.name}\n  ${failure.error && failure.error.stack}`);
}
console.log(`\n${passed}/${total} tests passed`);
if (failures.length > 0) {
  process.exit(1);
}
