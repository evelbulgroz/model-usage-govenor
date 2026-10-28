import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateProviderUsage } from '../adapters/adapter-contract.ts';
import { AnthropicModelAdapter } from '../adapters/anthropic.ts';
import { GoogleModelAdapter } from '../adapters/google.ts';
import { OpenAICompatibleModelAdapter } from '../adapters/openai-compatible.ts';
import { XaiModelAdapter } from '../adapters/xai.ts';
import { validatePolicy } from '../policy/policy.ts';
import { readCommittedPolicy } from '../testing/test-support.mjs';

function routeById(routeId) {
	const raw = readCommittedPolicy();
	const candidate = raw.routes.find((item) => item.id === routeId);
	candidate.enabled = true;
	return validatePolicy(raw).routes.find((item) => item.id === routeId);
}

function request() {
	return {
		operationId: 'operation',
		attemptId: 'attempt',
		prompt: 'prompt',
		structuredOutputSchema: { type: 'object' },
		maxCompletionTokens: 10,
		signal: new AbortController().signal,
	};
}

function jsonResponse(body) {
	const rawBody = JSON.stringify(body);
	return {
		ok: true,
		status: 200,
		headers: { get: () => 'request-1' },
		text: async () => rawBody,
	};
}

function priced(usage) {
	const { tokenDetails, ...rest } = usage;
	return rest;
}

async function execute(Adapter, route, body, envKey) {
	const adapter = new Adapter(route, {
		env: { [envKey]: 'credential' },
		fetchImpl: async () => jsonResponse(body),
	});
	return adapter.execute(request());
}

test('@ac AC-01 @case AC-01.1 Anthropic reports cache read, cache write, and null reasoning', async () => {
	const result = await execute(
		AnthropicModelAdapter,
		routeById('anthropic-claude-quality'),
		{
			content: [{ type: 'text', text: '{"ok":true}' }],
			usage: {
				input_tokens: 20,
				output_tokens: 3,
				cache_read_input_tokens: 80,
				cache_creation_input_tokens: 6,
			},
		},
		'ANTHROPIC_API_KEY',
	);
	assert.deepEqual(result.usage.tokenDetails, {
		cacheReadTokens: 80,
		cacheWriteTokens: 6,
		reasoningTokens: null,
	});
	assert.deepEqual(priced(result.usage), {
		promptTokens: 20,
		completionTokens: 3,
		cacheReadTokens: 80,
		cacheWriteTokens: 6,
		source: 'provider',
	});
});

test('@ac AC-01 @case AC-01.2 xAI responses reports cached input and reasoning', async () => {
	const result = await execute(
		XaiModelAdapter,
		routeById('xai-grok-quality'),
		{
			output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
			usage: {
				input_tokens: 40,
				input_tokens_details: { cached_tokens: 30 },
				output_tokens: 50,
				output_tokens_details: { reasoning_tokens: 50 },
			},
		},
		'XAI_API_KEY',
	);
	assert.deepEqual(result.usage.tokenDetails, {
		cacheReadTokens: 30,
		cacheWriteTokens: null,
		reasoningTokens: 50,
	});
	assert.deepEqual(priced(result.usage), {
		promptTokens: 10,
		cacheReadTokens: 30,
		completionTokens: 50,
		source: 'provider',
	});
});

test('@ac AC-01 @case AC-01.3 OpenAI-compatible reports cache read, cache write, and reasoning', async () => {
	const result = await execute(
		OpenAICompatibleModelAdapter,
		routeById('openai-compatible-quality'),
		{
			choices: [{ message: { content: '{"ok":true}' } }],
			usage: {
				prompt_tokens: 20,
				completion_tokens: 10,
				prompt_tokens_details: { cached_tokens: 12, cache_write_tokens: 4 },
				completion_tokens_details: { reasoning_tokens: 9 },
			},
		},
		'OPENAI_API_KEY',
	);
	assert.deepEqual(result.usage.tokenDetails, {
		cacheReadTokens: 12,
		cacheWriteTokens: 4,
		reasoningTokens: 9,
	});
	assert.deepEqual(priced(result.usage), {
		promptTokens: 4,
		cacheReadTokens: 12,
		cacheWriteTokens: 4,
		completionTokens: 10,
		source: 'provider',
	});
});

test('@ac AC-01 @case AC-01.4 Google reports cached content and thoughts', async () => {
	const result = await execute(
		GoogleModelAdapter,
		routeById('google-gemini-conservative'),
		{
			candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
			usageMetadata: {
				promptTokenCount: 100,
				cachedContentTokenCount: 20,
				candidatesTokenCount: 5,
				thoughtsTokenCount: 15,
			},
		},
		'GOOGLE_API_KEY',
	);
	assert.deepEqual(result.usage.tokenDetails, {
		cacheReadTokens: 20,
		cacheWriteTokens: null,
		reasoningTokens: 15,
	});
	assert.deepEqual(priced(result.usage), {
		promptTokens: 80,
		cacheReadTokens: 20,
		completionTokens: 20,
		source: 'provider',
	});
});

test('@ac AC-01 @case AC-01.5 xAI chat keeps an unpriced cache count out of priced usage', async () => {
	const route = structuredClone(routeById('xai-grok-conservative'));
	delete route.pricing.cacheReadMicrousdPerMillionTokens;
	const result = await execute(
		XaiModelAdapter,
		route,
		{
			choices: [{ message: { content: '{"ok":true}' } }],
			usage: {
				prompt_tokens: 40,
				completion_tokens: 2,
				prompt_tokens_details: { cached_tokens: 30 },
			},
		},
		'XAI_API_KEY',
	);
	assert.equal(result.usage.tokenDetails.cacheReadTokens, 30);
	assert.equal(Object.hasOwn(priced(result.usage), 'cacheReadTokens'), false);
	assert.deepEqual(priced(result.usage), {
		promptTokens: 40,
		completionTokens: 2,
		source: 'provider',
	});
});

test('@ac AC-01 @case AC-01.6 omitted detail fields stay null while priced usage treats them as zero', async () => {
	const openai = await execute(
		OpenAICompatibleModelAdapter,
		routeById('openai-compatible-quality'),
		{
			choices: [{ message: { content: '{"ok":true}' } }],
			usage: {
				prompt_tokens: 11,
				completion_tokens: 2,
				prompt_tokens_details: {},
			},
		},
		'OPENAI_API_KEY',
	);
	assert.equal(openai.usage.tokenDetails.cacheReadTokens, null);
	assert.equal(openai.usage.tokenDetails.reasoningTokens, null);
	assert.deepEqual(priced(openai.usage), {
		promptTokens: 11,
		completionTokens: 2,
		source: 'provider',
	});

	const anthropic = await execute(
		AnthropicModelAdapter,
		routeById('anthropic-claude-quality'),
		{
			content: [{ type: 'text', text: '{"ok":true}' }],
			usage: { input_tokens: 7, output_tokens: 2 },
		},
		'ANTHROPIC_API_KEY',
	);
	assert.equal(anthropic.usage.tokenDetails.cacheReadTokens, null);
	assert.deepEqual(priced(anthropic.usage), {
		promptTokens: 7,
		completionTokens: 2,
		source: 'provider',
	});
});

test('@ac AC-02 @case AC-02.1 priced usage matches the pre-change field values', async () => {
	const cases = [
		{
			adapter: AnthropicModelAdapter,
			routeId: 'anthropic-claude-quality',
			envKey: 'ANTHROPIC_API_KEY',
			body: {
				content: [{ type: 'text', text: '{"ok":true}' }],
				usage: {
					input_tokens: 20,
					output_tokens: 3,
					cache_read_input_tokens: 80,
					cache_creation_input_tokens: 6,
				},
			},
			priced: {
				promptTokens: 20,
				completionTokens: 3,
				cacheReadTokens: 80,
				cacheWriteTokens: 6,
				source: 'provider',
			},
		},
		{
			adapter: XaiModelAdapter,
			routeId: 'xai-grok-quality',
			envKey: 'XAI_API_KEY',
			body: {
				output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
				usage: {
					input_tokens: 40,
					input_tokens_details: { cached_tokens: 30 },
					output_tokens: 50,
					output_tokens_details: { reasoning_tokens: 50 },
				},
			},
			priced: {
				promptTokens: 10,
				cacheReadTokens: 30,
				completionTokens: 50,
				source: 'provider',
			},
		},
		{
			adapter: OpenAICompatibleModelAdapter,
			routeId: 'openai-compatible-quality',
			envKey: 'OPENAI_API_KEY',
			body: {
				choices: [{ message: { content: '{"ok":true}' } }],
				usage: {
					prompt_tokens: 20,
					completion_tokens: 10,
					prompt_tokens_details: { cached_tokens: 12, cache_write_tokens: 4 },
					completion_tokens_details: { reasoning_tokens: 9 },
				},
			},
			priced: {
				promptTokens: 4,
				cacheReadTokens: 12,
				cacheWriteTokens: 4,
				completionTokens: 10,
				source: 'provider',
			},
		},
		{
			adapter: GoogleModelAdapter,
			routeId: 'google-gemini-conservative',
			envKey: 'GOOGLE_API_KEY',
			body: {
				candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
				usageMetadata: {
					promptTokenCount: 100,
					cachedContentTokenCount: 20,
					candidatesTokenCount: 5,
					thoughtsTokenCount: 15,
				},
			},
			priced: {
				promptTokens: 80,
				cacheReadTokens: 20,
				completionTokens: 20,
				source: 'provider',
			},
		},
	];
	for (const item of cases) {
		const result = await execute(item.adapter, routeById(item.routeId), item.body, item.envKey);
		assert.deepEqual(priced(result.usage), item.priced);
	}
});

test('@ac AC-02 @case AC-02.2 a negative reasoning count is null and usage stays accepted', async () => {
	const result = await execute(
		XaiModelAdapter,
		routeById('xai-grok-quality'),
		{
			output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
			usage: {
				input_tokens: 20,
				output_tokens: 8,
				output_tokens_details: { reasoning_tokens: -4 },
			},
		},
		'XAI_API_KEY',
	);
	assert.equal(result.status, 'succeeded');
	assert.equal(result.usage.tokenDetails.reasoningTokens, null);
	assert.deepEqual(priced(result.usage), {
		promptTokens: 20,
		completionTokens: 8,
		source: 'provider',
	});
});

test('usage without tokenDetails stays valid and a bad detail object is rejected', () => {
	const plain = validateProviderUsage({ promptTokens: 1, completionTokens: 1, source: 'provider' });
	assert.equal(plain.tokenDetails, undefined);
	assert.throws(
		() =>
			validateProviderUsage({
				promptTokens: 1,
				completionTokens: 1,
				source: 'provider',
				tokenDetails: { cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: null, extra: 1 },
			}),
		(error) => error instanceof TypeError && /unknown key/.test(error.message),
	);
	assert.throws(
		() =>
			validateProviderUsage({
				promptTokens: 1,
				completionTokens: 1,
				source: 'provider',
				tokenDetails: { cacheReadTokens: -1, cacheWriteTokens: null, reasoningTokens: null },
			}),
		(error) => error instanceof TypeError,
	);
});

test('@ac AC-06 @case AC-06.1 @case AC-06.2 the README documents token details and not ledger.sqlite', () => {
	const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
	for (const name of ['tokenDetails', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', '1.2.0']) {
		assert.equal(readme.includes(name), true, name);
	}
	assert.equal(readme.includes('null'), true);
	assert.equal(readme.includes('ledger.sqlite'), false);
});
