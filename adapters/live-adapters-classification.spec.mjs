import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import { AnthropicModelAdapter } from './anthropic.ts';
import { CopilotModelAdapter } from './copilot.ts';
import { GoogleModelAdapter } from './google.ts';
import { OpenAICompatibleModelAdapter } from './openai-compatible.ts';
import { XaiModelAdapter } from './xai.ts';
import { isCreditBalanceBody, outcomeForStatus, parseModelJson } from './adapter-contract.ts';
import { readCommittedPolicy } from '../testing/test-support.mjs';
import { route, request, response } from '../testing/live-adapters-test-support.mjs';

test('live adapters preserve usage-less success for conservative governor charging', async () => {
	const google = new GoogleModelAdapter(route('google'), {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({ body: { candidates: [{ content: { parts: [{ text: '{}' }] } }] } }),
	});
	const openai = new OpenAICompatibleModelAdapter(route('openai-compatible'), {
		env: { OPENAI_API_KEY: 'credential' },
		fetchImpl: async () => response({ body: { choices: [{ message: { content: '{}' } }] } }),
	});
	const xai = new XaiModelAdapter(route('xai'), {
		env: { XAI_API_KEY: 'credential' },
		fetchImpl: async () => response({ body: { choices: [{ message: { content: '{}' } }] } }),
	});
	const anthropic = new AnthropicModelAdapter(route('anthropic'), {
		env: { ANTHROPIC_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({ body: { content: [{ type: 'text', text: '{}' }] } }),
	});
	assert.equal((await google.execute(request())).usage, undefined);
	assert.equal((await openai.execute(request())).usage, undefined);
	assert.equal((await xai.execute(request())).usage, undefined);
	assert.equal((await anthropic.execute(request())).usage, undefined);
});

test('live adapters classify missing credential, quota, 4xx, 5xx and malformed output', async () => {
	for (const [Adapter, provider, envName] of [
		[GoogleModelAdapter, 'google', 'GOOGLE_API_KEY'],
		[OpenAICompatibleModelAdapter, 'openai-compatible', 'OPENAI_API_KEY'],
		[XaiModelAdapter, 'xai', 'XAI_API_KEY'],
		[AnthropicModelAdapter, 'anthropic', 'ANTHROPIC_API_KEY'],
	]) {
		const missing = new Adapter(route(provider), { env: {}, fetchImpl: async () => assert.fail() });
		assert.deepEqual(await missing.execute(request()), {
			status: 'failed',
			outcome: 'transport',
			executionProvenFalse: true,
			usage: undefined,
		});
		for (const [status, outcome] of [
			[429, 'quota'],
			[400, 'http_4xx'],
			[503, 'http_5xx'],
		]) {
			const adapter = new Adapter(route(provider), {
				env: { [envName]: 'credential' },
				fetchImpl: async () => response({ status }),
			});
			assert.equal((await adapter.execute(request())).outcome, outcome);
		}
		// Real 429 responses almost always carry a non-empty body (unlike the bare
		// `response({ status })` fixture above, whose body serializes to `undefined`
		// and is therefore falsy). This must not throw inside validateAdapterResult.
		const quotaWithBody = new Adapter(route(provider), {
			env: { [envName]: 'credential' },
			fetchImpl: async () => response({ status: 429, body: '{"error":"rate limit exceeded"}' }),
		});
		const quotaResult = await quotaWithBody.execute(request());
		assert.equal(quotaResult.outcome, 'quota');
		assert.equal(quotaResult.diagnostic.stage, 'provider-error-response');
		assert.match(quotaResult.diagnostic.content, /rate limit exceeded/);
		const malformed = new Adapter(route(provider), {
			env: { [envName]: 'credential' },
			fetchImpl: async () => response({ body: {} }),
		});
		const malformedResult = await malformed.execute(request());
		assert.equal(malformedResult.outcome, 'malformed_output');
		assert.equal(malformedResult.diagnostic.stage, 'model-content-json');
		assert.equal(malformedResult.diagnostic.truncated, undefined);
	}
});

test('outcomeForStatus maps only credit-balance 4xx bodies to quota', () => {
	for (const body of [undefined, null, '', '{"error":"rejected"}', 'credit', 'Your credit balance is sufficient']) {
		assert.equal(isCreditBalanceBody(body), false);
		assert.equal(outcomeForStatus(400, body), 'http_4xx');
	}
	assert.equal(
		outcomeForStatus(400, '{"error":{"message":"credit is not a valid parameter"}}'),
		'http_4xx',
	);
	const markers = [
		'Your credit balance is too low to access the Anthropic API.',
		'Your Prepay credit balance is depleted.',
		'Your prepayment credits are depleted.',
		'{"error":{"code":"insufficient_quota"}}',
		'{"error":{"code":"billing_hard_limit_reached"}}',
		'You have run out of credits or need a Grok subscription.',
		'{"code":"personal-team-blocked:spending-limit"}',
		'CREDIT BALANCE IS TOO LOW',
	];
	for (const body of markers) {
		assert.equal(isCreditBalanceBody(body), true, body);
		assert.equal(outcomeForStatus(400, body), 'quota', body);
		assert.equal(outcomeForStatus(402, body), 'quota', body);
		assert.equal(outcomeForStatus(403, body), 'quota', body);
		assert.equal(outcomeForStatus(429, body), 'quota', body);
		assert.equal(outcomeForStatus(503, body), 'http_5xx', body);
	}
});

test('live adapters classify a credit-balance 4xx as quota and keep other 4xx terminal', async () => {
	const cases = [
		[
			GoogleModelAdapter,
			'google',
			'GOOGLE_API_KEY',
			402,
			'{"error":{"message":"Your Prepay credit balance is depleted."}}',
		],
		[
			OpenAICompatibleModelAdapter,
			'openai-compatible',
			'OPENAI_API_KEY',
			400,
			'{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
		],
		[
			XaiModelAdapter,
			'xai',
			'XAI_API_KEY',
			403,
			'{"code":"personal-team-blocked:spending-limit","error":"You have run out of credits or need a Grok subscription."}',
		],
		[
			AnthropicModelAdapter,
			'anthropic',
			'ANTHROPIC_API_KEY',
			400,
			'{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
		],
	];
	for (const [Adapter, provider, envName, status, body] of cases) {
		const credit = new Adapter(route(provider), {
			env: { [envName]: 'credential' },
			fetchImpl: async () => response({ status, body }),
		});
		const creditResult = await credit.execute(request());
		assert.equal(creditResult.outcome, 'quota');
		assert.equal(creditResult.diagnostic.stage, 'provider-error-response');
		assert.equal(creditResult.diagnostic.content, body);
		assert.equal(creditResult.executionProvenFalse, true);

		const schema = new Adapter(route(provider), {
			env: { [envName]: 'credential' },
			fetchImpl: async () =>
				response({ status: 400, body: '{"error":{"message":"credit is not a valid parameter"}}' }),
		});
		assert.equal((await schema.execute(request())).outcome, 'http_4xx');

		const server = new Adapter(route(provider), {
			env: { [envName]: 'credential' },
			fetchImpl: async () => response({ status: 503, body }),
		});
		assert.equal((await server.execute(request())).outcome, 'http_5xx');
	}
});

test('live adapters mark a length-capped unparsed reply as truncated', async () => {
	const anthropic = (body) =>
		new AnthropicModelAdapter(route('anthropic'), {
			env: { ANTHROPIC_API_KEY: 'credential' },
			fetchImpl: async () => response({ body }),
		});
	const openai = (body) =>
		new OpenAICompatibleModelAdapter(route('openai-compatible'), {
			env: { OPENAI_API_KEY: 'credential' },
			fetchImpl: async () => response({ body }),
		});

	const capped = await anthropic({
		stop_reason: 'max_tokens',
		content: [{ type: 'text', text: '{"action":' }],
	}).execute(request());
	assert.equal(capped.outcome, 'malformed_output');
	assert.equal(capped.diagnostic.stage, 'model-content-json');
	assert.equal(capped.diagnostic.truncated, true);

	const emptyCap = await anthropic({
		stop_reason: 'max_tokens',
		content: [],
	}).execute(request());
	assert.equal(emptyCap.outcome, 'malformed_output');
	assert.equal(emptyCap.diagnostic.truncated, true);

	const ended = await anthropic({
		stop_reason: 'end_turn',
		content: [{ type: 'text', text: '{"action":' }],
	}).execute(request());
	assert.equal(ended.outcome, 'malformed_output');
	assert.equal(ended.diagnostic.stage, 'model-content-json');
	assert.equal(ended.diagnostic.truncated, undefined);

	const parsedCap = await anthropic({
		stop_reason: 'max_tokens',
		content: [{ type: 'text', text: '{"ok":true}' }],
	}).execute(request());
	assert.equal(parsedCap.status, 'succeeded');
	assert.deepEqual(parsedCap.output, { ok: true });
	assert.equal(parsedCap.diagnostic, undefined);

	const length = await openai({
		choices: [{ finish_reason: 'length', message: { content: '{"action":' } }],
	}).execute(request());
	assert.equal(length.outcome, 'malformed_output');
	assert.equal(length.diagnostic.stage, 'model-content-json');
	assert.equal(length.diagnostic.truncated, true);

	const emptyLength = await openai({
		choices: [{ finish_reason: 'length', message: { content: '' } }],
	}).execute(request());
	assert.equal(emptyLength.outcome, 'malformed_output');
	assert.equal(emptyLength.diagnostic.truncated, true);

	const stopped = await openai({
		choices: [{ finish_reason: 'stop', message: { content: '' } }],
	}).execute(request());
	assert.equal(stopped.outcome, 'malformed_output');
	assert.equal(stopped.diagnostic.truncated, undefined);
});

test('live adapters honor Retry-After on quota/5xx, bounded and outcome-gated', async () => {
	for (const [Adapter, provider, envName] of [
		[GoogleModelAdapter, 'google', 'GOOGLE_API_KEY'],
		[OpenAICompatibleModelAdapter, 'openai-compatible', 'OPENAI_API_KEY'],
		[XaiModelAdapter, 'xai', 'XAI_API_KEY'],
		[AnthropicModelAdapter, 'anthropic', 'ANTHROPIC_API_KEY'],
	]) {
		const delta = new Adapter(route(provider), {
			env: { [envName]: 'credential' },
			fetchImpl: async () =>
				response({ status: 429, extraHeaders: { 'retry-after': '30' } }),
		});
		const deltaResult = await delta.execute(request());
		assert.equal(deltaResult.outcome, 'quota');
		assert.equal(deltaResult.retryAfterMs, 30_000);

		const httpDate = new Date(Date.now() + 45_000).toUTCString();
		const dateForm = new Adapter(route(provider), {
			env: { [envName]: 'credential' },
			fetchImpl: async () =>
				response({ status: 503, extraHeaders: { 'retry-after': httpDate } }),
		});
		const dateResult = await dateForm.execute(request());
		assert.equal(dateResult.outcome, 'http_5xx');
		assert.ok(
			dateResult.retryAfterMs > 40_000 && dateResult.retryAfterMs <= 45_000,
			`expected ~45s, got ${dateResult.retryAfterMs}`,
		);

		// A non-credit http_4xx is not Retry-After eligible and stays terminal.
		const ineligibleOutcome = new Adapter(route(provider), {
			env: { [envName]: 'credential' },
			fetchImpl: async () =>
				response({ status: 400, extraHeaders: { 'retry-after': '30' } }),
		});
		const ineligibleResult = await ineligibleOutcome.execute(request());
		assert.equal(ineligibleResult.outcome, 'http_4xx');
		assert.equal(ineligibleResult.retryAfterMs, undefined);

		// An absurd provider-specified delay is clamped, never trusted unbounded.
		const absurd = new Adapter(route(provider), {
			env: { [envName]: 'credential' },
			fetchImpl: async () =>
				response({ status: 429, extraHeaders: { 'retry-after': '999999' } }),
		});
		const absurdResult = await absurd.execute(request());
		assert.equal(absurdResult.retryAfterMs, 600_000);
	}
});

test('live adapters classify timeout, cancellation and transport without retries', async () => {
	for (const [Adapter, provider, envName] of [
		[GoogleModelAdapter, 'google', 'GOOGLE_API_KEY'],
		[OpenAICompatibleModelAdapter, 'openai-compatible', 'OPENAI_API_KEY'],
		[XaiModelAdapter, 'xai', 'XAI_API_KEY'],
		[AnthropicModelAdapter, 'anthropic', 'ANTHROPIC_API_KEY'],
	]) {
		let calls = 0;
		const adapter = new Adapter(route(provider), {
			env: { [envName]: 'credential' },
			fetchImpl: async (_url, init) => {
				calls += 1;
				if (init.signal.aborted) throw init.signal.reason;
				throw new Error('network');
			},
		});
		assert.equal((await adapter.execute(request())).outcome, 'transport');
		const timeout = new AbortController();
		timeout.abort(new DOMException('timeout', 'TimeoutError'));
		assert.equal((await adapter.execute(request(timeout.signal))).outcome, 'timeout');
		const cancelled = new AbortController();
		cancelled.abort(new DOMException('cancel', 'AbortError'));
		assert.equal((await adapter.execute(request(cancelled.signal))).outcome, 'cancelled');
		assert.equal(calls, 3);
	}
});

test('live adapters preserve timeout and cancellation while reading response bodies', async () => {
	for (const [Adapter, provider, envName] of [
		[GoogleModelAdapter, 'google', 'GOOGLE_API_KEY'],
		[OpenAICompatibleModelAdapter, 'openai-compatible', 'OPENAI_API_KEY'],
		[XaiModelAdapter, 'xai', 'XAI_API_KEY'],
		[AnthropicModelAdapter, 'anthropic', 'ANTHROPIC_API_KEY'],
	]) {
		for (const [reason, outcome] of [
			[new DOMException('timeout', 'TimeoutError'), 'timeout'],
			[new DOMException('cancel', 'AbortError'), 'cancelled'],
		]) {
			const controller = new AbortController();
			const adapter = new Adapter(route(provider), {
				env: { [envName]: 'credential' },
				fetchImpl: async () => ({
					ok: true,
					status: 200,
					headers: { get: () => undefined },
					text: async () => {
						controller.abort(reason);
						throw reason;
					},
				}),
			});
			assert.equal((await adapter.execute(request(controller.signal))).outcome, outcome);
		}
	}
});

test('live adapter construction and Copilot fail closed when capability evidence is absent', () => {
	const disabled = structuredClone(readCommittedPolicy().routes.find((item) => item.provider === 'google'));
	disabled.enabled = false;
	assert.throws(
		() => new GoogleModelAdapter(disabled),
		(error) => error instanceof ModelUsageError && error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
	);
	assert.equal(new GoogleModelAdapter(route('google')).routeId, 'google-gemini-conservative');
	assert.equal(new AnthropicModelAdapter(route('anthropic')).routeId, 'anthropic-claude-quality');
	assert.throws(
		() => new CopilotModelAdapter(),
		(error) => error instanceof ModelUsageError && error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
	);
});

test('parseModelJson robustly handles bare JSON, markdown code fences, and conversational preambles', () => {
	assert.deepEqual(parseModelJson('{"action": "test"}'), { action: 'test' });
	assert.deepEqual(parseModelJson('```json\n{"action": "fenced"}\n```'), { action: 'fenced' });
	assert.deepEqual(parseModelJson('```\n{"action": "bare-fence"}\n```'), { action: 'bare-fence' });
	assert.deepEqual(
		parseModelJson('Here is the requested output:\n```json\n{"action": "preamble"}\n```\nHope this helps!'),
		{ action: 'preamble' },
	);
	assert.deepEqual(
		parseModelJson('I will inspect the file:\n{"action": "bare-with-text"}'),
		{ action: 'bare-with-text' },
	);
	assert.deepEqual(parseModelJson('  \n [1, 2, 3] \n '), [1, 2, 3]);
	assert.throws(() => parseModelJson(null), TypeError);
	assert.throws(() => parseModelJson('Not a JSON string at all'), SyntaxError);
});

test('live adapters parse model JSON wrapped in markdown code fences without malformed_output', async () => {
	const googleAdapter = new GoogleModelAdapter(route('google'), {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					candidates: [{ content: { parts: [{ text: '```json\n{"ok":true}\n```' }] } }],
					usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
				},
			}),
	});
	const googleResult = await googleAdapter.execute(request());
	assert.equal(googleResult.status, 'succeeded');
	assert.deepEqual(googleResult.output, { ok: true });

	const openaiAdapter = new OpenAICompatibleModelAdapter(route('openai-compatible'), {
		env: { OPENAI_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					choices: [{ message: { content: '```json\n{"status":"repaired"}\n```' } }],
					usage: { prompt_tokens: 10, completion_tokens: 5 },
				},
			}),
	});
	const openaiResult = await openaiAdapter.execute(request());
	assert.equal(openaiResult.status, 'succeeded');
	assert.deepEqual(openaiResult.output, { status: 'repaired' });
});
