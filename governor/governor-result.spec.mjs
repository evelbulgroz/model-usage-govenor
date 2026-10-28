import assert from 'node:assert/strict';
import test from 'node:test';
import { governorResult } from './governor-result.ts';
import { FakeModelAdapter } from '../adapters/fake.ts';
import { addSecondFakeRoute, cleanupTestRoot, enabledFakePolicy } from '../testing/test-support.mjs';
import { setup, run } from '../testing/governor-test-support.mjs';

test('counterfactual Tier-2 cost calculation and selectedQualityTier populated on terminal success', async () => {
	const rawPolicy = enabledFakePolicy();
	addSecondFakeRoute(rawPolicy);
	const primaryRoute = rawPolicy.routes.find((r) => r.id === 'fake-governed');
	primaryRoute.qualityTier = 1;
	primaryRoute.metered = true;
	primaryRoute.pricing = {
		status: 'known',
		inputMicrousdPerMillionTokens: 100_000,
		outputMicrousdPerMillionTokens: 200_000,
		fixedRequestMicrousd: 0,
		effectiveDate: '2026-09-11',
		citationUrl: 'https://platform.openai.com/docs/pricing',
	};

	const secondaryRoute = rawPolicy.routes.find((r) => r.id === 'fake-secondary');
	secondaryRoute.qualityTier = 2;
	secondaryRoute.metered = true;
	secondaryRoute.pricing = {
		status: 'known',
		inputMicrousdPerMillionTokens: 1_000_000,
		outputMicrousdPerMillionTokens: 2_000_000,
		fixedRequestMicrousd: 0,
		effectiveDate: '2026-09-11',
		citationUrl: 'https://platform.openai.com/docs/pricing',
	};

	const context = setup('governor-tier2-counterfactual', {
		policy: rawPolicy,
		adapters: new Map([
			[
				'fake-governed',
				new FakeModelAdapter('fake-governed', [
					{
						status: 'succeeded',
						output: { ok: true },
						usage: { promptTokens: 2, completionTokens: 1, source: 'provider' },
					},
				]),
			],
			[
				'fake-secondary',
				new FakeModelAdapter('fake-secondary', []),
			],
		]),
	});
	try {
		const res = await run(context);
		assert.equal(res.status, 'succeeded');
		assert.equal(res.selectedQualityTier, 1);
		assert.equal(typeof res.counterfactualTier2CostMicrousd, 'number');
		assert.ok(res.counterfactualTier2CostMicrousd > 0);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('governorResult freezes schema 1.0.0 for a fresh success and a replay', () => {
	const now = new Date('2026-10-22T00:00:00.000Z');
	const request = { operationId: 'operation', runId: 'run', consumer: 'agent-sdlc', profile: 'agent-sdlc-default' };
	const operation = {
		output: { ok: true },
		route: { routeId: 'fake-governed' },
		usageRecordIds: ['usage-1'],
		effectiveStrategy: 'balanced',
		selectedQualityTier: null,
		counterfactualTier2CostMicrousd: null,
	};
	const summary = {
		attemptedRoutes: [{ routeId: 'fake-governed', provider: 'fake', model: 'model', canonicalVendor: 'fake' }],
		operationTotal: { totalTokens: 1, physicalCalls: 1, costMicrousd: 0, premiumRequestUnits: 0 },
		runTotal: { totalTokens: 1, physicalCalls: 1, costMicrousd: 0, premiumRequestUnits: 0 },
		operationDeadlineAt: '2026-10-22T00:05:00.000Z',
		runDeadlineAt: '2026-10-22T01:00:00.000Z',
	};
	const limits = {
		maxTotalTokens: 10,
		runMaxTotalTokens: 20,
		maxPhysicalAttempts: 4,
		runMaxCostMicrousd: 10,
		runMaxPremiumRequestUnits: 2,
	};
	const fresh = governorResult(request, operation, summary, { limits }, false, now);
	const replayed = governorResult(request, operation, summary, { limits }, true, now);
	assert.equal(fresh.schemaVersion, '1.0.0');
	assert.equal(fresh.replayed, false);
	assert.equal(replayed.replayed, true);
	assert.equal(Object.isFrozen(fresh), true);
	assert.equal(fresh.remainingBudget.remainingOperationTokens, 9);
	assert.equal(fresh.selectedQualityTier, undefined);
	assert.equal(Object.hasOwn(fresh, 'counterfactualTier2CostMicrousd'), false);
});
