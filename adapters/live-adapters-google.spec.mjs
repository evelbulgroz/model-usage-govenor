import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleModelAdapter } from './google.ts';
import { readCommittedPolicy } from '../testing/test-support.mjs';
import { route, request, response } from '../testing/live-adapters-test-support.mjs';

test('Google adapter normalizes JSON output, usage, request ID and fixed request shape', async () => {
	let captured;
	const adapter = new GoogleModelAdapter(route('google'), {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async (url, init) => {
			captured = { url, init };
			return response({
				body: {
					candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
					usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
				},
			});
		},
	});
	const result = await adapter.execute(request());
	assert.deepEqual(result.output, { ok: true });
	assert.equal(result.usage.promptTokens, 4);
	assert.equal(result.providerRequestId, 'request-1');
	const sent = JSON.parse(captured.init.body);
	assert.equal(sent.generationConfig.responseMimeType, 'application/json');
	assert.equal(sent.generationConfig.maxOutputTokens, 10);
	assert.equal(sent.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
	assert.match(captured.url, /generateContent/);
	assert.match(captured.url, /gemini-3\.6-flash/);
	assert.doesNotMatch(captured.url, /credential/);
	assert.equal(captured.init.headers['x-goog-api-key'], 'credential');
});

test('Google adapter configures thinkingLevel medium for Pro quality models and minimal for Flash', async () => {
	let captured;
	const qualityRoute = readCommittedPolicy().routes.find((r) => r.id === 'google-gemini-quality');
	const adapter = new GoogleModelAdapter(qualityRoute, {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async (url, init) => {
			captured = { url, init };
			return response({
				body: {
					candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
					usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
				},
			});
		},
	});
	const result = await adapter.execute(request());
	assert.deepEqual(result.output, { ok: true });
	const sent = JSON.parse(captured.init.body);
	assert.equal(sent.generationConfig.thinkingConfig.thinkingLevel, 'medium');
	assert.match(captured.url, /gemini-3\.1-pro-preview/);
});

test('Google adapter reads JSON from the first text part when thought signatures precede it', async () => {
	const adapter = new GoogleModelAdapter(route('google'), {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					candidates: [
						{
							content: {
								parts: [{ thoughtSignature: 'sig' }, { text: '{"ok":true}' }],
							},
						},
					],
					usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
				},
			}),
	});
	const result = await adapter.execute(request());
	assert.deepEqual(result.output, { ok: true });
	assert.equal(result.usage.promptTokens, 4);
});

test('Google adapter accounts for Gemini thinking tokens via totalTokenCount and thoughtsTokenCount', async () => {
	// Case 1: totalTokenCount >= prompt + candidates
	const adapterWithTotal = new GoogleModelAdapter(route('google'), {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 5,
						thoughtsTokenCount: 15,
						totalTokenCount: 30,
					},
				},
			}),
	});
	const resultWithTotal = await adapterWithTotal.execute(request());
	assert.equal(resultWithTotal.usage.promptTokens, 10);
	assert.equal(resultWithTotal.usage.completionTokens, 20); // 30 - 10 = 20
	assert.equal(resultWithTotal.usage.source, 'provider');

	// Case 2: thoughtsTokenCount folded in when totalTokenCount is absent
	const adapterWithThoughts = new GoogleModelAdapter(route('google'), {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 5,
						thoughtsTokenCount: 15,
					},
				},
			}),
	});
	const resultWithThoughts = await adapterWithThoughts.execute(request());
	assert.equal(resultWithThoughts.usage.promptTokens, 10);
	assert.equal(resultWithThoughts.usage.completionTokens, 20); // 5 + 15 = 20
	assert.equal(resultWithThoughts.usage.source, 'provider');

	// Case 3: totalTokenCount === prompt + candidates but thoughtsTokenCount present folds thoughts
	const adapterTotalWithoutThoughts = new GoogleModelAdapter(route('google'), {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 5,
						thoughtsTokenCount: 15,
						totalTokenCount: 15,
					},
				},
			}),
	});
	const resultTotalWithoutThoughts = await adapterTotalWithoutThoughts.execute(request());
	assert.equal(resultTotalWithoutThoughts.usage.promptTokens, 10);
	assert.equal(resultTotalWithoutThoughts.usage.completionTokens, 20); // Math.max(15-10, 5+15) = 20
	assert.equal(resultTotalWithoutThoughts.usage.source, 'provider');

	// Case 4: Missing/non-integer tokens leaves usage undefined so reservation is retained
	const adapterIncomplete = new GoogleModelAdapter(route('google'), {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
					usageMetadata: { promptTokenCount: 'not-an-integer', candidatesTokenCount: 5 },
				},
			}),
	});
	const resultIncomplete = await adapterIncomplete.execute(request());
	assert.equal(resultIncomplete.usage, undefined);
});

test('Google adapter splits cachedContentTokenCount out of promptTokenCount and records modelVersion', async () => {
	const adapter = new GoogleModelAdapter(route('google'), {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
					modelVersion: 'gemini-3.6-flash',
					usageMetadata: {
						promptTokenCount: 100,
						cachedContentTokenCount: 80,
						candidatesTokenCount: 5,
						thoughtsTokenCount: 15,
						totalTokenCount: 120,
					},
				},
			}),
	});
	const result = await adapter.execute(request());
	assert.equal(result.providerModelVersion, 'gemini-3.6-flash');
	assert.equal(result.usage.promptTokens, 20);
	assert.equal(result.usage.cacheReadTokens, 80);
	assert.equal(result.usage.completionTokens, 20);

	const invalid = new GoogleModelAdapter(route('google'), {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
					usageMetadata: {
						promptTokenCount: 10,
						cachedContentTokenCount: 11,
						candidatesTokenCount: 1,
					},
				},
			}),
	});
	const omitted = await invalid.execute(request());
	assert.equal(omitted.usage, undefined);
});
