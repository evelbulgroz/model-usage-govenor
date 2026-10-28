import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleModelAdapter } from './openai-compatible.ts';
import { XaiModelAdapter } from './xai.ts';
import { route, routeById, request, response } from '../testing/live-adapters-test-support.mjs';

test('OpenAI-compatible adapter normalizes success and pins base URL from policy', async () => {
	let captured;
	const adapter = new OpenAICompatibleModelAdapter(routeById('openai-compatible-quality'), {
		env: { OPENAI_API_KEY: 'credential' },
		fetchImpl: async (url, init) => {
			captured = { url, init };
			return response({
				body: {
					choices: [{ message: { content: '{"ok":true}' } }],
					usage: { prompt_tokens: 3, completion_tokens: 2 },
				},
			});
		},
	});
	const result = await adapter.execute(request());
	assert.deepEqual(result.output, { ok: true });
	assert.equal(captured.url, 'https://api.openai.com/v1/chat/completions');
	const sent = JSON.parse(captured.init.body);
	assert.equal(sent.model, 'gpt-6.1-sol');
	assert.equal(sent.reasoning_effort, 'low');
	assert.equal(sent.prompt_cache_options, undefined);
	assert.equal(sent.max_completion_tokens, 10);
	assert.equal(sent.response_format.type, 'json_schema');
	assert.equal(sent.response_format.json_schema.strict, true);
});

test('OpenAI quality adapter breakpoints stable blocks and splits cached and written prompt tokens', async () => {
	let captured;
	const adapter = new OpenAICompatibleModelAdapter(routeById('openai-compatible-quality'), {
		env: { OPENAI_API_KEY: 'credential' },
		fetchImpl: async (_url, init) => {
			captured = init;
			return response({
				body: {
					choices: [{ message: { content: '{"ok":true}' } }],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 7,
						prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 12 },
					},
				},
			});
		},
	});
	const blocks = ['task', 'tool result', '### Verification\nmissing'];
	const result = await adapter.execute({
		...request(),
		prompt: blocks.join('\n'),
		promptBlocks: blocks,
		promptCacheBreakpoint: 1,
	});
	const sent = JSON.parse(captured.body);
	assert.deepEqual(sent.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
	assert.deepEqual(sent.messages[0].content, [
		{ type: 'text', text: 'task', prompt_cache_breakpoint: { mode: 'explicit' } },
		{ type: 'text', text: '\ntool result', prompt_cache_breakpoint: { mode: 'explicit' } },
		{ type: 'text', text: '\n### Verification\nmissing' },
	]);
	assert.deepEqual(result.usage, {
		promptTokens: 8,
		completionTokens: 7,
		cacheReadTokens: 80,
		cacheWriteTokens: 12,
		source: 'provider',
		tokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 12, reasoningTokens: null },
	});
});

test('OpenAI quality adapter omits usage when cached tokens exceed the reported prompt', async () => {
	const adapter = new OpenAICompatibleModelAdapter(routeById('openai-compatible-quality'), {
		env: { OPENAI_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					choices: [{ message: { content: '{"ok":true}' } }],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 1,
						prompt_tokens_details: { cached_tokens: 11 },
					},
				},
			}),
	});
	const result = await adapter.execute(request());
	assert.equal(result.status, 'succeeded');
	assert.equal(result.usage, undefined);
});

test('xAI conservative chat completions subtract cached prompt tokens and ignore cache writes', async () => {
	let captured;
	const xai = new XaiModelAdapter(route('xai'), {
		env: { XAI_API_KEY: 'credential' },
		fetchImpl: async (url, init) => {
			captured = { url, headers: init.headers, body: JSON.parse(init.body) };
			return response({
				body: {
					choices: [{ message: { content: '{"ok":true}' } }],
					usage: {
						prompt_tokens: 30,
						completion_tokens: 2,
						prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
					},
				},
			});
		},
	});
	const xaiResult = await xai.execute({
		...request(),
		prompt: 'task\ntool',
		promptBlocks: ['task', 'tool'],
	});
	assert.equal(captured.url, 'https://api.x.ai/v1/chat/completions');
	assert.equal(captured.headers['x-grok-conv-id'], 'operation');
	assert.equal(captured.body.prompt_cache_options, undefined);
	assert.equal(captured.body.reasoning_effort, undefined);
	assert.equal(captured.body.messages[0].content, 'task\ntool');
	assert.deepEqual(xaiResult.usage, {
		promptTokens: 10,
		completionTokens: 2,
		cacheReadTokens: 20,
		source: 'provider',
		tokenDetails: { cacheReadTokens: 20, cacheWriteTokens: null, reasoningTokens: null },
	});
});

test('gpt-4o-mini keeps one user string and folds reported cache tokens into the prompt', async () => {
	const mini = new OpenAICompatibleModelAdapter(route('openai-compatible'), {
		env: { OPENAI_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					choices: [{ message: { content: '{"ok":true}' } }],
					usage: {
						prompt_tokens: 15,
						completion_tokens: 1,
						prompt_tokens_details: { cached_tokens: 4 },
					},
				},
			}),
	});
	const miniResult = await mini.execute(request());
	assert.deepEqual(miniResult.usage, {
		promptTokens: 15,
		completionTokens: 1,
		source: 'provider',
		tokenDetails: { cacheReadTokens: 4, cacheWriteTokens: null, reasoningTokens: null },
	});
});

test('xAI conservative route uses the dedicated adapter against api.x.ai chat completions', async () => {
	let captured;
	const adapter = new XaiModelAdapter(route('xai'), {
		env: { XAI_API_KEY: 'credential' },
		fetchImpl: async (url, init) => {
			captured = { url, init };
			return response({
				requestId: 'grok-1',
				body: {
					id: 'resp-body-is-not-the-request-id',
					choices: [{ message: { content: '{"ok":true}' } }],
					usage: { prompt_tokens: 4, completion_tokens: 2 },
				},
			});
		},
	});
	const result = await adapter.execute(request());
	assert.deepEqual(result.output, { ok: true });
	assert.equal(result.providerRequestId, 'grok-1');
	assert.deepEqual(result.usage, {
		promptTokens: 4,
		completionTokens: 2,
		source: 'provider',
		tokenDetails: { cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
	});
	assert.equal(captured.url, 'https://api.x.ai/v1/chat/completions');
	assert.equal(JSON.parse(captured.init.body).model, 'grok-4.20-0309-non-reasoning');
	assert.equal(captured.init.headers.authorization, 'Bearer credential');
});

test('xAI quality route posts strict Responses JSON and splits cached input from output tokens', async () => {
	let captured;
	const adapter = new XaiModelAdapter(routeById('xai-grok-quality'), {
		env: { XAI_API_KEY: 'credential' },
		fetchImpl: async (url, init) => {
			captured = { url, init };
			return {
				ok: true,
				status: 200,
				headers: {
					get: (name) => (name === 'x-grok-request-id' ? 'grok-header' : undefined),
				},
				text: async () =>
					JSON.stringify({
						id: 'resp_body',
						output: [
							{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'hidden' }] },
							{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] },
						],
						usage: {
							input_tokens: 40,
							input_tokens_details: { cached_tokens: 10 },
							output_tokens: 6,
							output_tokens_details: { reasoning_tokens: 50 },
						},
					}),
			};
		},
	});
	const result = await adapter.execute({
		...request(),
		prompt: 'task\ntool',
		promptBlocks: ['task', 'tool'],
	});
	assert.equal(result.status, 'succeeded');
	assert.deepEqual(result.output, { ok: true });
	assert.equal(result.providerRequestId, 'grok-header');
	assert.deepEqual(result.usage, {
		promptTokens: 30,
		cacheReadTokens: 10,
		completionTokens: 6,
		source: 'provider',
		tokenDetails: { cacheReadTokens: 10, cacheWriteTokens: null, reasoningTokens: 50 },
	});
	assert.equal(captured.url, 'https://api.x.ai/v1/responses');
	const sent = JSON.parse(captured.init.body);
	assert.equal(sent.model, 'grok-4.7');
	assert.equal(sent.input, 'task\ntool');
	assert.equal(sent.store, false);
	assert.equal(sent.prompt_cache_key, 'operation');
	assert.equal(sent.reasoning.effort, 'low');
	assert.equal(sent.max_output_tokens, 10);
	assert.equal(sent.text.format.type, 'json_schema');
	assert.equal(sent.text.format.name, 'governed_output');
	assert.equal(sent.text.format.strict, true);
	assert.deepEqual(sent.text.format.schema, { type: 'object' });
	assert.equal(sent.response_format, undefined);
	assert.equal(sent.messages, undefined);
	assert.equal(sent.tools, undefined);
	assert.equal(sent.temperature, undefined);
	assert.equal(sent.top_p, undefined);
	assert.equal(sent.prompt_cache_options, undefined);
	assert.equal(captured.init.headers['x-grok-conv-id'], undefined);
});

test('xAI quality omits usage when cached tokens exceed input and rejects empty or non-message output', async () => {
	const overCached = new XaiModelAdapter(routeById('xai-grok-quality'), {
		env: { XAI_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
					usage: {
						input_tokens: 10,
						input_tokens_details: { cached_tokens: 11 },
						output_tokens: 1,
						output_tokens_details: { reasoning_tokens: 0 },
					},
				},
			}),
	});
	const overResult = await overCached.execute(request());
	assert.equal(overResult.status, 'succeeded');
	assert.equal(overResult.usage, undefined);

	const invalidCache = new XaiModelAdapter(routeById('xai-grok-quality'), {
		env: { XAI_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
					usage: {
						input_tokens: 10,
						input_tokens_details: { cached_tokens: 1.5 },
						output_tokens: 1,
					},
				},
			}),
	});
	assert.equal((await invalidCache.execute(request())).usage, undefined);

	for (const body of [
		{ output: [] },
		{ output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'only' }] }] },
		{ output: [{ type: 'message', content: [{ type: 'output_text', text: '' }] }] },
	]) {
		const adapter = new XaiModelAdapter(routeById('xai-grok-quality'), {
			env: { XAI_API_KEY: 'credential' },
			fetchImpl: async () => response({ body }),
		});
		const result = await adapter.execute(request());
		assert.equal(result.outcome, 'malformed_output');
		assert.equal(result.diagnostic.stage, 'model-content-json');
	}

	const capped = new XaiModelAdapter(routeById('xai-grok-quality'), {
		env: { XAI_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					status: 'incomplete',
					incomplete_details: { reason: 'max_output_tokens' },
					output: [{ type: 'message', content: [{ type: 'output_text', text: '{"action":' }] }],
				},
			}),
	});
	const cappedResult = await capped.execute(request());
	assert.equal(cappedResult.outcome, 'malformed_output');
	assert.equal(cappedResult.diagnostic.truncated, true);
});

test('xAI quality maps missing credentials and HTTP status classes on the Responses URL', async () => {
	let url;
	const missing = new XaiModelAdapter(routeById('xai-grok-quality'), {
		env: {},
		fetchImpl: async () => assert.fail('missing credential must not call the network'),
	});
	assert.deepEqual(await missing.execute(request()), {
		status: 'failed',
		outcome: 'transport',
		executionProvenFalse: true,
		usage: undefined,
	});
	for (const [status, outcome] of [
		[400, 'http_4xx'],
		[429, 'quota'],
		[500, 'http_5xx'],
	]) {
		const adapter = new XaiModelAdapter(routeById('xai-grok-quality'), {
			env: { XAI_API_KEY: 'credential' },
			fetchImpl: async (called) => {
				url = called;
				return response({ status, body: '{"error":"rejected"}' });
			},
		});
		const result = await adapter.execute(request());
		assert.equal(result.outcome, outcome);
		assert.equal(result.executionProvenFalse, true);
		assert.equal(url, 'https://api.x.ai/v1/responses');
	}
});
