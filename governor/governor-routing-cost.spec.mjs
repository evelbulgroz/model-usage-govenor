import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import { estimatePromptTokens } from '../routing/tokenizer.ts';
import { FakeModelAdapter } from '../adapters/fake.ts';
import { addSecondFakeRoute, baseRequest, cleanupTestRoot, enabledFakePolicy, readCommittedPolicy } from '../testing/test-support.mjs';
import { setup, run } from '../testing/governor-test-support.mjs';

test('reserves operation time for an alternate vendor attempt', async () => {
	const policy = addSecondFakeRoute(enabledFakePolicy());
	const secondaryRoute = policy.routes.find((route) => route.id === 'fake-secondary');
	secondaryRoute.provider = 'google';
	secondaryRoute.canonicalVendor = 'google';
	for (const route of policy.routes.filter((candidate) =>
		['fake-governed', 'fake-secondary'].includes(candidate.id),
	)) {
		route.limits.attemptTimeoutMs = 1000;
	}
	const first = new FakeModelAdapter('fake-governed', [{ delayMs: 750 }]);
	const second = new FakeModelAdapter('fake-secondary', [
		{ status: 'succeeded', output: { ok: true } },
	]);
	const context = setup('governor-failover-time-reserve', {
		policy,
		request: baseRequest({
			requestedLimits: {
				maxCompletionTokens: 32,
				timeoutMs: 1000,
				maxPhysicalAttempts: 2,
				maxRetriesPerRoute: 1,
				maxFailovers: 1,
			},
		}),
		adapters: new Map([
			['fake-governed', first],
			['fake-secondary', second],
		]),
	});
	try {
		const result = await run(context);
		assert.equal(result.route.routeId, 'fake-secondary');
		assert.equal(first.callCount, 1);
		assert.equal(second.callCount, 1);
		assert.equal(result.attempts, 2);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('enforces retry depth and stops when conservative first charge exhausts budget', async () => {
	const request = baseRequest({
		requestedLimits: { maxCompletionTokens: 10, maxPhysicalAttempts: 2 },
	});
	const policy = enabledFakePolicy();
	const estimate = estimatePromptTokens({
		prompt: request.prompt,
		structuredOutputSchema: request.structuredOutputSchema,
		routeFraming: policy.routes[0].framing,
	}).promptTokens;
	Object.assign(policy.profiles['agent-sdlc-default'].limits, {
		maxPromptTokens: estimate,
		maxCompletionTokens: 10,
		maxTotalTokens: 2 * (estimate + 10),
		runMaxTotalTokens: 2 * (estimate + 10),
		maxPhysicalAttempts: 2,
		maxRetriesPerRoute: 1,
	});
	Object.assign(policy.routes[0].limits, {
		maxPromptTokens: estimate,
		maxCompletionTokens: 10,
		maxTotalTokens: 2 * (estimate + 10),
	});
	policy.instance.maxTotalTokens = 2 * (estimate + 10);
	const fake = new FakeModelAdapter('fake-governed', [
		{ status: 'failed', outcome: 'transport' },
		{ status: 'succeeded', output: { ok: true } },
	]);
	const context = setup('governor-budget-before-retry', {
		policy,
		request,
		adapters: new Map([['fake-governed', fake]]),
	});
	try {
		await run(
			context,
			baseRequest({
				runId: request.runId,
				operationId: 'prior-spend-operation',
				requestedLimits: { maxCompletionTokens: 10 },
			}),
			{
				adapters: new Map([
					[
						'fake-governed',
						new FakeModelAdapter('fake-governed', [
							{
								status: 'succeeded',
								output: { ok: true },
								usage: { promptTokens: estimate, completionTokens: 10, source: 'provider' },
							},
						]),
					],
				]),
			},
		);
		await assert.rejects(run(context), (error) => error.code === 'ERR_TOKEN_BUDGET_EXCEEDED');
		await assert.rejects(run(context), (error) => error.code === 'ERR_TOKEN_BUDGET_EXCEEDED');
		assert.equal(fake.callCount, 1);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('AC-05: budget failures expose actionable diagnostics including dimension, limit, requested, remaining, taskId, and operationId', async () => {
	const policy = enabledFakePolicy();
	const estimate = estimatePromptTokens({
		prompt: 'Return a small JSON object.',
		structuredOutputSchema: {
			type: 'object',
			required: ['ok'],
			properties: { ok: { type: 'boolean' } },
			additionalProperties: false,
		},
		routeFraming: policy.routes[0].framing,
	}).promptTokens;
	const requiredTokens = estimate + 32;
	Object.assign(policy.profiles['agent-sdlc-default'].limits, {
		maxPromptTokens: estimate,
		maxCompletionTokens: 32,
		maxTotalTokens: requiredTokens,
		runMaxTotalTokens: requiredTokens + 5,
		maxPhysicalAttempts: 1,
		maxRetriesPerRoute: 0,
		maxFailovers: 0,
	});
	Object.assign(policy.routes[0].limits, {
		maxPromptTokens: estimate,
		maxCompletionTokens: 32,
		maxTotalTokens: requiredTokens,
	});
	policy.instance.maxTotalTokens = requiredTokens + 5;
	const request = baseRequest({
		operationId: 'op-ac-05-diag',
		attribution: { taskId: 'task-ac-05', nodeId: 'impl', generation: 1, nodeAttempt: 1 },
		requestedLimits: { maxCompletionTokens: 32 },
	});
	const fake = new FakeModelAdapter('fake-governed', [
		{ status: 'succeeded', output: { ok: true } },
	]);
	const context = setup('governor-ac-05', {
		policy,
		request,
		adapters: new Map([['fake-governed', fake]]),
	});
	try {
		// Run a prior operation that consumes 10 tokens
		await run(
			context,
			baseRequest({
				runId: request.runId,
				operationId: 'prior-spend',
				attribution: { taskId: 'task-ac-05', nodeId: 'impl', generation: 1, nodeAttempt: 1 },
				requestedLimits: { maxCompletionTokens: 5 },
			}),
			{
				adapters: new Map([
					[
						'fake-governed',
						new FakeModelAdapter('fake-governed', [
							{
								status: 'succeeded',
								output: { ok: true },
								usage: { promptTokens: 5, completionTokens: 5, source: 'provider' },
							},
						]),
					],
				]),
			},
		);
		// Now second request requires requiredTokens but run only has requiredTokens - 5 left (budget exceeded)
		await assert.rejects(
			run(context),
			(err) => {
				assert.equal(err instanceof ModelUsageError, true);
				assert.equal(err.code, 'ERR_TOKEN_BUDGET_EXCEEDED');
				assert.equal(err.metadata.dimension, 'totalTokens');
				assert.equal(err.metadata.limit, requiredTokens + 5);
				assert.equal(err.metadata.requested, requiredTokens + 10);
				assert.equal(err.metadata.operationId, 'op-ac-05-diag');
				assert.equal(err.metadata.taskId, 'task-ac-05');
				assert.equal(err.metadata.remaining, requiredTokens - 5);
				return true;
			},
		);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('AC-06: proven non-executed provider failure reconciles to zero usage and fails over to secondary route', async () => {
	const policy = addSecondFakeRoute(enabledFakePolicy());
	const request = baseRequest({
		requestedLimits: { maxCompletionTokens: 32 },
	});
	const first = new FakeModelAdapter('fake-governed', [
		{ status: 'failed', outcome: 'quota', executionProvenFalse: true },
	]);
	const second = new FakeModelAdapter('fake-secondary', [
		{ status: 'succeeded', output: { ok: true }, usage: { promptTokens: 2, completionTokens: 1, source: 'provider' } },
	]);
	const context = setup('governor-ac-06', {
		policy,
		request,
		adapters: new Map([
			['fake-governed', first],
			['fake-secondary', second],
		]),
	});
	try {
		const res = await run(context);
		assert.equal(res.status, 'succeeded');
		assert.equal(res.route.routeId, 'fake-secondary');
		assert.equal(first.callCount, 1);
		assert.equal(second.callCount, 1);
		const envelope = JSON.parse(
			fs.readFileSync(path.join(context.stateRoot, 'runs', `${request.runId}.json`), 'utf8'),
		);
		assert.equal(envelope.attempts[0].executionProvenFalse, true);
		assert.equal(envelope.attempts[0].charge.totalTokens, 0);
		assert.equal(envelope.attempts[0].charge.costMicrousd, 0);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('AC-06: proven non-executed transport failure reconciles to zero usage and immediately fails over to secondary route', async () => {
	const policy = addSecondFakeRoute(enabledFakePolicy());
	const request = baseRequest({
		requestedLimits: { maxCompletionTokens: 32 },
	});
	const first = new FakeModelAdapter('fake-governed', [
		{ status: 'failed', outcome: 'transport', executionProvenFalse: true },
	]);
	const second = new FakeModelAdapter('fake-secondary', [
		{ status: 'succeeded', output: { ok: true }, usage: { promptTokens: 2, completionTokens: 1, source: 'provider' } },
	]);
	const context = setup('governor-ac-06-transport', {
		policy,
		request,
		adapters: new Map([
			['fake-governed', first],
			['fake-secondary', second],
		]),
	});
	try {
		const res = await run(context);
		assert.equal(res.status, 'succeeded');
		assert.equal(res.route.routeId, 'fake-secondary');
		assert.equal(first.callCount, 1);
		assert.equal(second.callCount, 1);
		const envelope = JSON.parse(
			fs.readFileSync(path.join(context.stateRoot, 'runs', `${request.runId}.json`), 'utf8'),
		);
		assert.equal(envelope.attempts[0].executionProvenFalse, true);
		assert.equal(envelope.attempts[0].charge.totalTokens, 0);
		assert.equal(envelope.attempts[0].charge.costMicrousd, 0);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('critic-review profile fails over to alternative route when primary route suffers transport failure', async () => {
	const policy = readCommittedPolicy();
	const first = new FakeModelAdapter('openai-compatible-quality', [
		{ status: 'failed', outcome: 'transport', executionProvenFalse: true },
	]);
	const second = new FakeModelAdapter('xai-grok-quality', [
		{
			status: 'succeeded',
			output: { reviewId: 'rev-critic', hasP1: false, findings: [] },
			usage: { promptTokens: 10, completionTokens: 5, source: 'provider' },
		},
	]);
	const request = {
		schemaVersion: '1.0.0',
		operationId: 'op-critic-failover',
		runId: 'run-critic-failover',
		consumer: 'agent-sdlc',
		profile: 'critic-review',
		prompt: 'Critic review prompt',
		structuredOutputSchema: {
			type: 'object',
			properties: {
				reviewId: { type: 'string' },
				hasP1: { type: 'boolean' },
				findings: { type: 'array', items: { type: 'string' } },
			},
			required: ['reviewId', 'hasP1', 'findings'],
			additionalProperties: false,
		},
		routingConstraints: {
			requiredCapabilities: ['structured-output'],
			strategy: 'quality-first',
			minQualityTier: 2,
			excludedVendors: ['google'],
			preferredRouteIds: ['openai-compatible-quality'],
		},
	};
	const context = setup('governor-critic-failover', {
		policy,
		request,
		adapters: new Map([
			['openai-compatible-quality', first],
			['xai-grok-quality', second],
		]),
	});
	try {
		const res = await run(context);
		assert.equal(res.status, 'succeeded');
		assert.equal(res.route.routeId, 'xai-grok-quality');
		assert.equal(first.callCount, 1);
		assert.equal(second.callCount, 1);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('AC-07: ambiguous provider failure retains conservative reservation charge', async () => {
	const policy = addSecondFakeRoute(enabledFakePolicy());
	const request = baseRequest({
		requestedLimits: { maxCompletionTokens: 32 },
	});
	const first = new FakeModelAdapter('fake-governed', [
		{ status: 'failed', outcome: 'quota', executionProvenFalse: false },
	]);
	const second = new FakeModelAdapter('fake-secondary', [
		{ status: 'succeeded', output: { ok: true }, usage: { promptTokens: 2, completionTokens: 1, source: 'provider' } },
	]);
	const context = setup('governor-ac-07', {
		policy,
		request,
		adapters: new Map([
			['fake-governed', first],
			['fake-secondary', second],
		]),
	});
	try {
		const res = await run(context);
		assert.equal(res.status, 'succeeded');
		assert.equal(res.route.routeId, 'fake-secondary');
		const envelope = JSON.parse(
			fs.readFileSync(path.join(context.stateRoot, 'runs', `${request.runId}.json`), 'utf8'),
		);
		assert.equal(envelope.attempts[0].executionProvenFalse, false);
		assert.ok(envelope.attempts[0].charge.totalTokens > 0);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('AC-15: provider circuit breaker records failure and skips unavailable provider during cooldown', async () => {
	const policy = addSecondFakeRoute(enabledFakePolicy());
	const secondRoute = policy.routes.find((r) => r.id === 'fake-secondary');
	secondRoute.provider = 'google';
	secondRoute.canonicalVendor = 'google';
	const request = baseRequest({
		requestedLimits: { maxCompletionTokens: 32 },
	});
	const first = new FakeModelAdapter('fake-governed', [
		{ status: 'failed', outcome: 'quota' },
	]);
	const second = new FakeModelAdapter('fake-secondary', [
		{ status: 'succeeded', output: { ok: true } },
		{ status: 'succeeded', output: { ok: true } },
	]);
	const context = setup('governor-ac-15', {
		policy,
		request,
		adapters: new Map([
			['fake-governed', first],
			['fake-secondary', second],
		]),
	});
	try {
		const res1 = await run(context);
		assert.equal(res1.route.routeId, 'fake-secondary');
		const secondRequest = baseRequest({
			operationId: 'op-ac-15-second',
			runId: request.runId,
			requestedLimits: { maxCompletionTokens: 32 },
		});
		const res2 = await run(context, secondRequest);
		assert.equal(res2.route.routeId, 'fake-secondary');
		assert.equal(first.callCount, 1);
		assert.equal(second.callCount, 2);
	} finally {
		cleanupTestRoot(context.root);
	}
});
