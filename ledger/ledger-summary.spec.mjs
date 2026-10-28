import assert from 'node:assert/strict';
import test from 'node:test';
import { listExhaustedRouteIds, summarizeEnvelope } from './ledger-summary.ts';
import { addSecondFakeRoute, cleanupTestRoot } from '../testing/test-support.mjs';
import { setup, reserve, setHighCeilings } from '../testing/ledger-test-support.mjs';

test('getExhaustedRouteIds returns routes whose cumulative usage prevents a new attempt', () => {
	const context = setup('ledger-exhausted-routes', {}, (policy) => {
		setHighCeilings(policy);
		addSecondFakeRoute(policy);
		policy.routes.find((route) => route.id === 'fake-governed').limits.maxPhysicalCalls = 1;
		policy.routes.find((route) => route.id === 'fake-secondary').limits.maxPhysicalCalls = 10;
	});
	try {
		assert.deepEqual(context.ledger.getExhaustedRouteIds(context.policy), []);
		reserve(context, {
			charge: {
				promptTokens: 5,
				completionTokens: 0,
				totalTokens: 5,
				physicalCalls: 1,
				costMicrousd: 0,
				premiumRequestUnits: 0,
			},
		});
		assert.deepEqual(context.ledger.getExhaustedRouteIds(context.policy), ['fake-governed']);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('getRunBudgetSummary returns undefined for nonexistent run and sums all attempts and reservations safely', () => {
	const context = setup('ledger-run-budget-summary');
	try {
		// Nonexistent run returns undefined
		assert.equal(context.ledger.getRunBudgetSummary('nonexistent-run'), undefined);

		// Reserve attempt
		const reserved = context.ledger.reserveAttempt({
			policy: context.policy,
			profile: context.profile,
			route: context.route,
			request: context.request,
			inputHash: context.inputHash,
			ownerToken: 'owner-budget-summary',
			reservation: {
				promptTokens: 5,
				completionTokens: 10,
				totalTokens: 15,
				physicalCalls: 1,
				costMicrousd: 100,
				premiumRequestUnits: 0,
			},
			estimator: { name: 'test', version: '1' },
			retryIndex: 0,
			failoverIndex: 0,
			attemptTimeoutMs: 1000,
			effectiveStrategy: 'min-cost',
			counterfactualTier2CostMicrousd: 250,
		});

		const summary = context.ledger.getRunBudgetSummary(context.request.runId);
		assert.ok(summary);
		assert.equal(summary.runTotal.costMicrousd, 100);
		assert.equal(summary.runTotal.totalTokens, 15);

		// Operation summary doesn't crash on newly queried operation that isn't yet reserved
		const opSummary = context.ledger.getRunSummary(context.request.runId, 'unreserved-op');
		assert.ok(opSummary);
		assert.equal(opSummary.operationTotal.totalTokens, 0);
		assert.deepEqual(opSummary.usageRecordIds, []);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('listExhaustedRouteIds and summarizeEnvelope tolerate an empty run', () => {
	assert.deepEqual(listExhaustedRouteIds({ routes: [] }, []), []);
	const summary = summarizeEnvelope(
		{ attempts: [], reservations: [], runDeadlineAt: '2026-10-22T00:00:00.000Z' },
		'missing',
	);
	assert.deepEqual(summary.usageRecordIds, []);
	assert.equal(summary.operationTotal.physicalCalls, 0);
	assert.equal(summary.runTotal.totalTokens, 0);
});
