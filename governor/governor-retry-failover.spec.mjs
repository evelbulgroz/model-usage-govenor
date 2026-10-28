import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FakeModelAdapter } from '../adapters/fake.ts';
import { addSecondFakeRoute, addThirdFakeRoute, baseRequest, cleanupTestRoot, enabledFakePolicy } from '../testing/test-support.mjs';
import { setup, run } from '../testing/governor-test-support.mjs';

test('retries explicit transport once, then deterministically fails over with fresh reservations', async () => {
	const policy = addSecondFakeRoute(enabledFakePolicy());
	const request = baseRequest({
		requestedLimits: { maxCompletionTokens: 32, maxRetriesPerRoute: 1 },
	});
	const first = new FakeModelAdapter('fake-governed', [
		{ status: 'failed', outcome: 'transport' },
		{ status: 'failed', outcome: 'transport' },
	]);
	const second = new FakeModelAdapter('fake-secondary', [
		{
			status: 'succeeded',
			output: { ok: true },
			usage: { promptTokens: 1, completionTokens: 1, source: 'provider' },
		},
	]);
	const context = setup('governor-failover', {
		policy,
		request,
		adapters: new Map([
			['fake-governed', first],
			['fake-secondary', second],
		]),
	});

	try {
		const result = await run(context);
		assert.equal(result.route.routeId, 'fake-secondary');
		assert.equal(result.attempts, 3);
		assert.equal(first.callCount, 2);
		assert.equal(second.callCount, 1);
		assert.equal(result.usageRecordIds.length, 3);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('fails over when secondary route has tighter pre-reserve ceiling and finalizes terminal failure', async () => {
	const policy = addSecondFakeRoute(enabledFakePolicy());
	policy.routes[1].limits.maxPromptTokens = 5;
	const request = baseRequest({
		requestedLimits: { maxCompletionTokens: 32, maxRetriesPerRoute: 0, maxFailovers: 1 },
	});
	const first = new FakeModelAdapter('fake-governed', [
		{ status: 'failed', outcome: 'transport' },
	]);
	const second = new FakeModelAdapter('fake-secondary');
	const context = setup('governor-failover-pre-reserve-denial', {
		policy,
		request,
		adapters: new Map([
			['fake-governed', first],
			['fake-secondary', second],
		]),
	});

	try {
		await assert.rejects(run(context), (error) => error.code === 'ERR_TOKEN_BUDGET_EXCEEDED');
		assert.equal(first.callCount, 1);
		assert.equal(second.callCount, 0);

		// Issue 2 verification: replaying the same request immediately rethrows the persisted terminal failure
		// without throwing ERR_OPERATION_IN_PROGRESS!
		await assert.rejects(run(context), (error) => error.code === 'ERR_TOKEN_BUDGET_EXCEEDED');
		assert.equal(first.callCount, 1);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('skips route with tighter pre-reserve ceiling during failover to reach capable route', async () => {
	const policy = addSecondFakeRoute(enabledFakePolicy());
	const third = structuredClone(policy.routes[1]);
	third.id = 'fake-tertiary';
	third.model = 'deterministic-json-tertiary';
	policy.routes.push(third);
	policy.profiles['agent-sdlc-default'].routeIds.push(third.id);
	policy.profiles['agent-sdlc-default'].limits.maxFailovers = 2;
	policy.routes[1].limits.maxPromptTokens = 5;

	const request = baseRequest({
		requestedLimits: { maxCompletionTokens: 32, maxRetriesPerRoute: 0, maxFailovers: 2 },
	});
	const first = new FakeModelAdapter('fake-governed', [
		{ status: 'failed', outcome: 'transport' },
	]);
	const second = new FakeModelAdapter('fake-secondary');
	const tertiary = new FakeModelAdapter('fake-tertiary', [
		{ status: 'succeeded', output: { ok: true } },
	]);
	const context = setup('governor-failover-skip-tighter', {
		policy,
		request,
		adapters: new Map([
			['fake-governed', first],
			['fake-secondary', second],
			['fake-tertiary', tertiary],
		]),
	});

	try {
		const result = await run(context);
		assert.equal(result.status, 'succeeded');
		assert.equal(result.route.routeId, 'fake-tertiary');
		assert.equal(first.callCount, 1);
		assert.equal(second.callCount, 0);
		assert.equal(tertiary.callCount, 1);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('uses the configured per-route retry depth instead of a hard-coded retry count', async () => {
	const fake = new FakeModelAdapter('fake-governed', [
		{ status: 'failed', outcome: 'transport' },
		{ status: 'failed', outcome: 'transport' },
		{ status: 'succeeded', output: { ok: true } },
	]);
	const context = setup('governor-retry-depth', {
		request: baseRequest({
			requestedLimits: {
				maxCompletionTokens: 32,
				maxPhysicalAttempts: 3,
				maxRetriesPerRoute: 2,
			},
		}),
		adapters: new Map([['fake-governed', fake]]),
	});
	try {
		const result = await run(context);
		assert.equal(result.attempts, 3);
		assert.equal(fake.callCount, 3);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('retries an explicit HTTP 5xx outcome with a fresh reservation', async () => {
	const fake = new FakeModelAdapter('fake-governed', [
		{ status: 'failed', outcome: 'http_5xx' },
		{ status: 'succeeded', output: { ok: true } },
	]);
	const context = setup('governor-5xx-retry', {
		adapters: new Map([['fake-governed', fake]]),
	});
	try {
		const result = await run(context);
		assert.equal(result.attempts, 2);
		assert.equal(fake.callCount, 2);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test("quota failover and provider Retry-After", async (t) => {
await t.test('quota failover', async () => {
		const policy = addSecondFakeRoute(enabledFakePolicy());
		const first = new FakeModelAdapter('fake-governed', [
			{ status: 'failed', outcome: 'quota' },
		]);
		const second = new FakeModelAdapter('fake-secondary', [
			{ status: 'succeeded', output: { ok: true } },
		]);
		const context = setup('governor-quota', {
			policy,
			adapters: new Map([
				['fake-governed', first],
				['fake-secondary', second],
			]),
		});
		try {
			assert.equal((await run(context)).route.routeId, 'fake-secondary');
			assert.equal(first.callCount, 1);
		} finally {
			cleanupTestRoot(context.root);
		}
	});

await t.test('quota honors a provider-specified Retry-After over the default cooldown', async () => {
		const fake = new FakeModelAdapter('fake-governed', [
			{ status: 'failed', outcome: 'quota', retryAfterMs: 120_000 },
		]);
		const context = setup('governor-quota-retry-after', {
			adapters: new Map([['fake-governed', fake]]),
		});
		try {
			await assert.rejects(
				run(context),
				(error) => error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
			);
			const circuitFile = path.join(context.stateRoot, 'provider-circuit.json');
			const circuitState = JSON.parse(fs.readFileSync(circuitFile, 'utf8'));
			const record = circuitState.providers.fake;
			assert.ok(record, 'expected a circuit-breaker record for the fake provider');
			const cooldownMs = Date.parse(record.unavailableUntil) - Date.parse(record.lastFailureAt);
			assert.equal(cooldownMs, 120_000);
		} finally {
			cleanupTestRoot(context.root);
		}
	});
});

test("http 4xx terminates with a diagnostic and a short cooldown", async (t) => {
await t.test('http-4xx', async () => {
		const fake = new FakeModelAdapter('fake-governed', [
			{ status: 'failed', outcome: 'http_4xx' },
		]);
		const context = setup('governor-http-4xx', {
			adapters: new Map([['fake-governed', fake]]),
		});
		try {
			await assert.rejects(
				run(context),
				(error) => error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
			);
			assert.equal(fake.callCount, 1);
		} finally {
			cleanupTestRoot(context.root);
		}
	});

await t.test('http-4xx persists a redacted provider-error-response diagnostic', async () => {
		const fake = new FakeModelAdapter('fake-governed', [
			{
				status: 'failed',
				outcome: 'http_4xx',
				diagnostic: {
					stage: 'provider-error-response',
					content: 'api_key=super-secret-value {"error":"invalid schema"}',
				},
			},
		]);
		const context = setup('governor-http-4xx-diagnostic', {
			adapters: new Map([['fake-governed', fake]]),
		});
		try {
			await assert.rejects(
				run(context),
				(error) => error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
			);
			const diagnosticRoot = path.join(
				context.stateRoot,
				'diagnostics',
				encodeURIComponent(context.request.runId),
			);
			const diagnosticFiles = fs.readdirSync(diagnosticRoot);
			assert.equal(diagnosticFiles.length, 1);
			const diagnostic = fs.readFileSync(
				path.join(diagnosticRoot, diagnosticFiles[0]),
				'utf8',
			);
			assert.match(diagnostic, /"stage": "provider-error-response"/);
			assert.match(diagnostic, /\[REDACTED\]/);
			assert.doesNotMatch(diagnostic, /super-secret-value/);
		} finally {
			cleanupTestRoot(context.root);
		}
	});

await t.test('http-4xx records a short circuit-breaker cooldown for the provider', async () => {
		const fake = new FakeModelAdapter('fake-governed', [
			{ status: 'failed', outcome: 'http_4xx' },
		]);
		const context = setup('governor-http-4xx-cooldown', {
			adapters: new Map([['fake-governed', fake]]),
		});
		try {
			await assert.rejects(
				run(context),
				(error) => error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
			);
			const circuitFile = path.join(context.stateRoot, 'provider-circuit.json');
			const circuitState = JSON.parse(fs.readFileSync(circuitFile, 'utf8'));
			const record = circuitState.providers.fake;
			assert.ok(record, 'expected a circuit-breaker record for the fake provider');
			assert.equal(record.reason, 'http_4xx');
			const cooldownMs = Date.parse(record.unavailableUntil) - Date.parse(record.lastFailureAt);
			assert.ok(
				cooldownMs > 0 && cooldownMs <= 10_000,
				`expected a short (<=10s) cooldown, got ${cooldownMs}ms`,
			);
		} finally {
			cleanupTestRoot(context.root);
		}
	});
});

test("exhausted routes keep an elimination trail including a route never reached", async (t) => {
await t.test('exhausted routes record an elimination reason per configured route', async () => {
		const policy = addSecondFakeRoute(enabledFakePolicy());
		const first = new FakeModelAdapter('fake-governed', [
			{ status: 'failed', outcome: 'quota' },
		]);
		const second = new FakeModelAdapter('fake-secondary', [
			{ status: 'failed', outcome: 'http_4xx' },
		]);
		const context = setup('governor-routes-eliminated', {
			policy,
			adapters: new Map([
				['fake-governed', first],
				['fake-secondary', second],
			]),
		});
		try {
			await assert.rejects(run(context), (error) => {
				assert.equal(error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED', true);
				assert.deepEqual(
					error.metadata.routesEliminated.map((entry) => ({
						routeId: entry.routeId,
						outcome: entry.outcome,
					})),
					[
						{ routeId: 'fake-governed', outcome: 'quota' },
						{ routeId: 'fake-secondary', outcome: 'http_4xx' },
					],
				);
				return true;
			});
		} finally {
			cleanupTestRoot(context.root);
		}
	});

await t.test(
		'a route never reached due to an earlier terminal outcome is still recorded as not-attempted',
		async () => {
			const policy = addThirdFakeRoute(addSecondFakeRoute(enabledFakePolicy()));
			const secondRoute = policy.routes.find((r) => r.id === 'fake-secondary');
			secondRoute.provider = 'xai';
			secondRoute.canonicalVendor = 'xai';
			const thirdRoute = policy.routes.find((r) => r.id === 'fake-tertiary');
			thirdRoute.provider = 'anthropic';
			thirdRoute.canonicalVendor = 'anthropic';
			const first = new FakeModelAdapter('fake-governed', [
				{ status: 'failed', outcome: 'malformed_output' },
			]);
			const second = new FakeModelAdapter('fake-secondary', [
				{ status: 'failed', outcome: 'http_4xx' },
			]);
			const third = new FakeModelAdapter('fake-tertiary', [
				{ status: 'succeeded', output: { ok: true } },
			]);
			const context = setup('governor-unreached-route', {
				policy,
				adapters: new Map([
					['fake-governed', first],
					['fake-secondary', second],
					['fake-tertiary', third],
				]),
			});
			try {
				await assert.rejects(run(context), (error) => {
					assert.equal(error.code, 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED');
					assert.deepEqual(
						error.metadata.routesEliminated.map((entry) => ({
							routeId: entry.routeId,
							outcome: entry.outcome ?? null,
							reason: entry.reason,
						})),
						[
							{ routeId: 'fake-governed', outcome: 'malformed_output', reason: 'attempt-failed' },
							{ routeId: 'fake-secondary', outcome: 'http_4xx', reason: 'attempt-failed' },
							{ routeId: 'fake-tertiary', outcome: null, reason: 'not-attempted-terminal-outcome' },
						],
					);
					return true;
				});
				assert.equal(third.callCount, 0);
			} finally {
				cleanupTestRoot(context.root);
			}
		},
	);
});
