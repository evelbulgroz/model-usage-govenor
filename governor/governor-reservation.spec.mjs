import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import { assessReservation } from './governor.ts';
import { reservationChargeForRoute } from './governor-reservation.ts';
import { effectiveProfile, validateOperationRequest, validatePolicy } from '../policy/policy.ts';
import { estimatePromptTokens } from '../routing/tokenizer.ts';
import { FakeModelAdapter } from '../adapters/fake.ts';
import { baseRequest, cleanupTestRoot, enabledFakePolicy } from '../testing/test-support.mjs';
import { setup, run, reservationCount, governOptions } from '../testing/governor-test-support.mjs';

test('rejects route completion and total ceilings before reservation or dispatch', async (t) => {
	await t.test('completion ceiling', async () => {
		const policy = enabledFakePolicy();
		policy.routes[0].limits.maxCompletionTokens = 16;
		const fake = new FakeModelAdapter('fake-governed');
		const context = setup('governor-route-completion', {
			policy,
			adapters: new Map([['fake-governed', fake]]),
		});
		try {
			await assert.rejects(run(context), (error) => error.code === 'ERR_TOKEN_BUDGET_EXCEEDED');
			assert.equal(fake.callCount, 0);
			assert.equal(fs.existsSync(path.join(context.stateRoot, 'runs', `${context.request.runId}.json`)), false);
		} finally {
			cleanupTestRoot(context.root);
		}
	});
	await t.test('total ceiling', async () => {
		const policy = enabledFakePolicy();
		const estimate = estimatePromptTokens({
			prompt: baseRequest().prompt,
			structuredOutputSchema: baseRequest().structuredOutputSchema,
			routeFraming: policy.routes[0].framing,
		}).promptTokens;
		policy.routes[0].limits.maxPromptTokens = estimate;
		policy.routes[0].limits.maxCompletionTokens = 32;
		policy.routes[0].limits.maxTotalTokens = estimate + 31;
		const fake = new FakeModelAdapter('fake-governed');
		const context = setup('governor-route-total', {
			policy,
			adapters: new Map([['fake-governed', fake]]),
		});
		try {
			await assert.rejects(run(context), (error) => error.code === 'ERR_TOKEN_BUDGET_EXCEEDED');
			assert.equal(fake.callCount, 0);
		} finally {
			cleanupTestRoot(context.root);
		}
	});
});

test('AC-06: initial run operation resolves full profile limits and second logical operation derives remaining runway without crashing', async () => {
	const rawPolicy = enabledFakePolicy();
	const fakeRoute = rawPolicy.routes.find((r) => r.id === 'fake-governed');
	fakeRoute.metered = true;
	fakeRoute.pricing = {
		status: 'known',
		inputMicrousdPerMillionTokens: 1_000_000,
		outputMicrousdPerMillionTokens: 2_000_000,
		fixedRequestMicrousd: 0,
		effectiveDate: '2026-09-11',
		citationUrl: 'https://platform.openai.com/docs/pricing',
	};
	const context = setup('governor-ac06-multitask', {
		policy: rawPolicy,
		request: baseRequest({ runId: 'run-ac06', operationId: 'op-1' }),
		adapters: new Map([
			[
				'fake-governed',
				new FakeModelAdapter('fake-governed', [
					{
						status: 'succeeded',
						output: { ok: true },
						usage: { promptTokens: 2, completionTokens: 1, source: 'provider' },
					},
					{
						status: 'succeeded',
						output: { ok: true },
						usage: { promptTokens: 2, completionTokens: 1, source: 'provider' },
					},
				]),
			],
		]),
	});
	try {
		// Operation 1 executes under full initial runway
		const res1 = await run(context, baseRequest({ runId: 'run-ac06', operationId: 'op-1' }));
		assert.equal(res1.status, 'succeeded');
		assert.equal(res1.replayed, false);

		// Operation 2 in same run executes and derives reduced remaining runway without crashing
		const res2 = await run(context, baseRequest({ runId: 'run-ac06', operationId: 'op-2' }));
		assert.equal(res2.status, 'succeeded');
		assert.equal(res2.replayed, false);
		assert.equal(context.adapters.get('fake-governed').callCount, 2);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('@ac AC-08 schema and route framing count toward the reservation', async () => {
	const completion = 100;
	const policy = enabledFakePolicy();
	const route = policy.routes.find((item) => item.id === 'fake-governed');
	const prompt = 'Return a small JSON object.';
	const tinySchema = { type: 'object', additionalProperties: false };
	const schema = {
		type: 'object',
		required: ['ok'],
		properties: {
			ok: { type: 'boolean' },
			note: { type: 'string', description: 'n'.repeat(1200) },
		},
		additionalProperties: false,
	};
	route.framing = 'FRAME '.repeat(120);
	policy.profiles['agent-sdlc-default'].limits.maxCompletionTokens = completion;
	policy.profiles['agent-sdlc-default'].limits.maxPromptTokens = 20000;
	route.limits.maxPromptTokens = 20000;
	const promptTextTokens = estimatePromptTokens({
		prompt,
		structuredOutputSchema: tinySchema,
		routeFraming: '',
	}).promptTokens;
	route.limits.maxTotalTokens = promptTextTokens + completion;
	const sharedTokens =
		estimatePromptTokens({
			prompt,
			structuredOutputSchema: schema,
			routeFraming: route.framing,
		}).promptTokens + completion;
	assert.ok(promptTextTokens + completion <= route.limits.maxTotalTokens);
	assert.ok(sharedTokens > route.limits.maxTotalTokens);
	const request = baseRequest({
		prompt,
		structuredOutputSchema: schema,
		requestedLimits: { maxCompletionTokens: completion },
	});
	const fake = new FakeModelAdapter('fake-governed');
	const context = setup('governor-ac08', {
		policy,
		request,
		adapters: new Map([['fake-governed', fake]]),
	});
	try {
		const before = reservationCount(context.stateRoot, request.runId);
		await assert.rejects(assessReservation(request, governOptions(context)), (error) => {
			assert.equal(error instanceof ModelUsageError, true);
			assert.equal(error.code, 'ERR_TOKEN_BUDGET_EXCEEDED');
			assert.equal(error.metadata.dimension, 'maxTotalTokens');
			return true;
		});
		assert.equal(fake.callCount, 0);
		assert.equal(reservationCount(context.stateRoot, request.runId), before);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('@ac AC-09 remaining run tokens use that same charge', async () => {
	const policy = enabledFakePolicy();
	const route = policy.routes.find((item) => item.id === 'fake-governed');
	const seedPrompt = 's'.repeat(4000);
	const seedEstimate = estimatePromptTokens({
		prompt: seedPrompt,
		structuredOutputSchema: baseRequest().structuredOutputSchema,
		routeFraming: route.framing,
	}).promptTokens;
	assert.ok(seedEstimate >= 800);
	const seedRequest = baseRequest({
		prompt: seedPrompt,
		requestedLimits: { maxCompletionTokens: 32 },
	});
	const fake = new FakeModelAdapter('fake-governed', [
		{
			status: 'succeeded',
			output: { ok: true },
			usage: { promptTokens: 800, completionTokens: 0, source: 'provider' },
		},
	]);
	const context = setup('governor-ac09', {
		policy,
		request: seedRequest,
		adapters: new Map([['fake-governed', fake]]),
	});
	try {
		await run(context);
		const envelope = JSON.parse(
			fs.readFileSync(path.join(context.stateRoot, 'runs', `${seedRequest.runId}.json`), 'utf8'),
		);
		const charged = envelope.attempts[0].charge.totalTokens;
		const completion = 32;
		const maxPrompt = 400;
		const operationCeiling = maxPrompt + completion;
		const limits = policy.profiles['agent-sdlc-default'].limits;
		limits.maxPhysicalAttempts = 1;
		limits.maxRetriesPerRoute = 0;
		limits.maxPromptTokens = maxPrompt;
		limits.maxCompletionTokens = completion;
		limits.maxTotalTokens = operationCeiling;
		limits.runMaxTotalTokens = charged + 200;
		assert.ok(limits.runMaxTotalTokens >= limits.maxTotalTokens);
		fs.writeFileSync(context.policyPath, `${JSON.stringify(policy, null, 2)}\n`);
		const nextPrompt = 'n'.repeat(80);
		const nextRequest = baseRequest({
			operationId: `operation-${seedRequest.runId}`,
			runId: seedRequest.runId,
			prompt: nextPrompt,
			requestedLimits: { maxCompletionTokens: completion },
		});
		const sharedTokens =
			estimatePromptTokens({
				prompt: nextPrompt,
				structuredOutputSchema: nextRequest.structuredOutputSchema,
				routeFraming: route.framing,
			}).promptTokens + completion;
		assert.ok(sharedTokens > 200);
		assert.ok(sharedTokens <= operationCeiling);
		const before = reservationCount(context.stateRoot, seedRequest.runId);
		const callsBefore = fake.callCount;
		await assert.rejects(assessReservation(nextRequest, governOptions(context)), (error) => {
			assert.equal(error instanceof ModelUsageError, true);
			assert.equal(error.code, 'ERR_TOKEN_BUDGET_EXCEEDED');
			assert.equal(error.metadata.dimension, 'totalTokens');
			return true;
		});
		assert.equal(fake.callCount, callsBefore);
		assert.equal(reservationCount(context.stateRoot, seedRequest.runId), before);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('reservationChargeForRoute sizes the attempt from the profile completion ceiling', () => {
	const policy = validatePolicy(enabledFakePolicy());
	const request = validateOperationRequest(baseRequest());
	const profile = effectiveProfile(policy, request);
	const route = policy.routes.find((item) => item.id === 'fake-governed');
	const charged = reservationChargeForRoute(request, profile, route);
	assert.equal(charged.completionTokens, profile.limits.maxCompletionTokens);
	assert.equal(charged.reservationCharge.physicalCalls, 1);
	assert.equal(
		charged.reservationCharge.totalTokens,
		charged.estimate.promptTokens + charged.completionTokens,
	);
});
