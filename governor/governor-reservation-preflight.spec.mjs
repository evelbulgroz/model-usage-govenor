import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assessReservation } from './governor.ts';
import { calculateReservationPrice } from '../routing/pricing.ts';
import { estimatePromptTokens } from '../routing/tokenizer.ts';
import { FakeModelAdapter } from '../adapters/fake.ts';
import { addSecondFakeRoute, baseRequest, cleanupTestRoot, enabledFakePolicy } from '../testing/test-support.mjs';
import { setup, run, governOptions } from '../testing/governor-test-support.mjs';

test('assessReservation on a run with no ledger writes no reservation', async () => {
	const context = setup('governor-assess-empty-ledger');
	try {
		const decision = await assessReservation(context.request, governOptions(context));
		assert.equal(decision.fits, true);
		assert.equal(context.adapters.get('fake-governed').callCount, 0);
		assert.equal(
			fs.existsSync(path.join(context.stateRoot, 'runs', `${context.request.runId}.json`)),
			false,
		);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('a route selectRoutes drops is not a ceiling the preflight requires', async () => {
	const policy = addSecondFakeRoute(enabledFakePolicy());
	const tight = policy.routes.find((route) => route.id === 'fake-governed');
	const kept = policy.routes.find((route) => route.id === 'fake-secondary');
	tight.qualityTier = 1;
	tight.limits.maxTotalTokens = 1;
	kept.qualityTier = 3;
	const request = baseRequest({
		routingConstraints: {
			requiredCapabilities: ['structured-output'],
			minQualityTier: 3,
		},
	});
	const context = setup('governor-assess-dropped-route', { policy, request });
	try {
		const decision = await assessReservation(request, governOptions(context));
		assert.equal(decision.fits, true);
		assert.equal(context.adapters.get('fake-governed').callCount, 0);
		assert.equal(
			fs.existsSync(path.join(context.stateRoot, 'runs', `${request.runId}.json`)),
			false,
		);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('a blocked prompt reserves the 5-minute cache write and forwards the blocks', async () => {
	const policy = enabledFakePolicy();
	const route = policy.routes.find((item) => item.id === 'fake-governed');
	Object.assign(route.pricing, {
		inputMicrousdPerMillionTokens: 2_000_000,
		outputMicrousdPerMillionTokens: 0,
		cacheReadMicrousdPerMillionTokens: 100_000,
		cacheWrite5mMicrousdPerMillionTokens: 2_500_000,
	});
	const prompt = 'task\ntool result';
	const promptBlocks = ['task', 'tool result'];
	const request = baseRequest({ prompt, promptBlocks, promptCacheBreakpoint: 0 });
	let seen;
	let seenBreakpoint;
	const adapter = new FakeModelAdapter('fake-governed', [
		{
			onCall(adapterRequest) {
				seen = adapterRequest.promptBlocks;
				seenBreakpoint = adapterRequest.promptCacheBreakpoint;
			},
			result: {
				status: 'succeeded',
				output: { ok: true },
				usage: {
					promptTokens: 0,
					cacheWriteTokens: 10,
					completionTokens: 1,
					source: 'provider',
				},
			},
		},
	]);
	const context = setup('governor-cache-reservation', {
		policy,
		request,
		adapters: new Map([['fake-governed', adapter]]),
	});
	try {
		const result = await run(context);
		assert.equal(result.status, 'succeeded');
		assert.deepEqual(seen, promptBlocks);
		assert.equal(seenBreakpoint, 0);
		const envelope = JSON.parse(
			fs.readFileSync(path.join(context.stateRoot, 'runs', `${request.runId}.json`), 'utf8'),
		);
		const estimate = estimatePromptTokens({
			prompt,
			structuredOutputSchema: request.structuredOutputSchema,
			routeFraming: route.framing,
		});
		const reserved = calculateReservationPrice({
			promptTokens: estimate.promptTokens,
			completionTokens: request.requestedLimits.maxCompletionTokens,
			pricing: route.pricing,
			cacheWriteEligible: true,
		});
		const base = calculateReservationPrice({
			promptTokens: estimate.promptTokens,
			completionTokens: request.requestedLimits.maxCompletionTokens,
			pricing: route.pricing,
			cacheWriteEligible: false,
		});
		assert.equal(envelope.attempts[0].reservationCharge.costMicrousd, reserved.costMicrousd);
		assert.ok(reserved.costMicrousd > base.costMicrousd);
		assert.equal(envelope.attempts[0].charge.promptTokens, 10);
		assert.equal(envelope.attempts[0].charge.costMicrousd, 25);
	} finally {
		cleanupTestRoot(context.root);
	}
});
