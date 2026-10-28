import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import { cleanupTestRoot } from '../testing/test-support.mjs';
import { setup, reserve, contextForRequest, reconcileFullReservation, setHighCeilings, assertBudgetError } from '../testing/ledger-test-support.mjs';

test('profile run reservation ceilings apply per run, not across runs', () => {
	const context = setup('ledger-profile-run-ceiling', {}, (policy) => {
		setHighCeilings(policy);
		Object.assign(policy.profiles['agent-sdlc-default'].limits, {
			maxPromptTokens: 68,
			maxCompletionTokens: 32,
			maxTotalTokens: 100,
			maxPhysicalAttempts: 1,
			maxRetriesPerRoute: 0,
			maxFailovers: 0,
			runMaxTotalTokens: 100,
		});
	});
	try {
		reserve(context, {
			charge: {
				promptTokens: 100,
				completionTokens: 0,
				totalTokens: 100,
				physicalCalls: 1,
				costMicrousd: 0,
				premiumRequestUnits: 0,
			},
		});
		// Second run under the same profile has its own 100-token run ceiling
		const second = contextForRequest(context, {
			runId: 'profile-second-run',
			operationId: 'profile-second-operation',
		});
		const result = reserve(second, {
			charge: {
				promptTokens: 100,
				completionTokens: 0,
				totalTokens: 100,
				physicalCalls: 1,
				costMicrousd: 0,
				premiumRequestUnits: 0,
			},
		});
		assert.equal(result.reservation.charge.totalTokens, 100);

		// But within the second run, exceeding its run ceiling is rejected
		assertBudgetError(
			() =>
				reserve(
					contextForRequest(context, {
						runId: 'profile-second-run',
						operationId: 'profile-second-overflow',
					}),
					{
						charge: {
							promptTokens: 1,
							completionTokens: 0,
							totalTokens: 1,
							physicalCalls: 1,
							costMicrousd: 0,
							premiumRequestUnits: 0,
						},
					},
				),
			'ERR_TOKEN_BUDGET_EXCEEDED',
			{
				dimension: 'totalTokens',
				limit: 100,
				requested: 101,
				remaining: 0,
				profile: context.request.profile,
				runId: 'profile-second-run',
			},
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('two sequential runs each reserving full 16,000 tokens on the same route succeed under default policy', () => {
	const context = setup('ledger-sequential-runs-default', {
		requestedLimits: { maxCompletionTokens: 4000 },
	});
	try {
		const first = reserve(context, {
			charge: {
				promptTokens: 12000,
				completionTokens: 4000,
				totalTokens: 16000,
				physicalCalls: 1,
				costMicrousd: 0,
				premiumRequestUnits: 0,
			},
		});
		assert.equal(first.reservation.charge.totalTokens, 16000);
		reconcileFullReservation(context, first);

		const second = contextForRequest(context, {
			runId: 'sequential-run-2',
			operationId: 'sequential-op-2',
			requestedLimits: { maxCompletionTokens: 4000 },
		});
		const secondResult = reserve(second, {
			charge: {
				promptTokens: 12000,
				completionTokens: 4000,
				totalTokens: 16000,
				physicalCalls: 1,
				costMicrousd: 0,
				premiumRequestUnits: 0,
			},
		});
		assert.equal(secondResult.reservation.charge.totalTokens, 16000);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('profile run ceilings stay independent and the instance ceiling caps the sum', () => {
	const context = setup('ledger-run-ceiling', {}, (policy) => {
		setHighCeilings(policy);
		policy.profiles.alternate = structuredClone(
			policy.profiles['agent-sdlc-default'],
		);
		Object.assign(policy.profiles.alternate.limits, {
			maxPromptTokens: 68,
			maxCompletionTokens: 32,
			maxTotalTokens: 100,
			maxPhysicalAttempts: 1,
			maxRetriesPerRoute: 0,
			maxFailovers: 0,
			runMaxTotalTokens: 100,
		});
		Object.assign(policy.profiles['agent-sdlc-default'].limits, {
			maxPromptTokens: 68,
			maxCompletionTokens: 32,
			maxTotalTokens: 100,
			maxPhysicalAttempts: 1,
			maxRetriesPerRoute: 0,
			maxFailovers: 0,
			runMaxTotalTokens: 100,
		});
		policy.instance.maxTotalTokens = 150;
	});
	try {
		const charge = (totalTokens) => ({
			promptTokens: totalTokens,
			completionTokens: 0,
			totalTokens,
			physicalCalls: 1,
			costMicrousd: 0,
			premiumRequestUnits: 0,
		});
		const alternate = contextForRequest(context, {
			profile: 'alternate',
			operationId: 'alternate-operation',
		});
		reserve(alternate, { charge: charge(100) });

		const second = contextForRequest(context, { operationId: 'run-second-operation' });
		const admitted = reserve(second, { charge: charge(1) });
		assert.equal(admitted.reservation.charge.totalTokens, 1);
		const reconciled = reconcileFullReservation(second, admitted);
		assert.equal(reconciled.attempt.remainingRunBudget.totalTokens, 99);

		assertBudgetError(
			() =>
				reserve(contextForRequest(context, { operationId: 'run-profile-overflow' }), {
					charge: charge(100),
				}),
			'ERR_TOKEN_BUDGET_EXCEEDED',
			{
				dimension: 'totalTokens',
				limit: 100,
				requested: 101,
				remaining: 99,
				profile: 'agent-sdlc-default',
				runId: context.request.runId,
			},
		);
		assertBudgetError(
			() =>
				reserve(contextForRequest(context, { operationId: 'run-instance-overflow' }), {
					charge: charge(50),
				}),
			'ERR_TOKEN_BUDGET_EXCEEDED',
			{
				dimension: 'totalTokens',
				limit: 150,
				requested: 151,
				remaining: 49,
				reason: 'instance',
			},
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('denies a 16,000-token reservation after the same profile consumed 49,000 tokens', () => {
	const context = setup('ledger-explicit-run-budget', {}, (policy) => {
		setHighCeilings(policy);
		Object.assign(policy.profiles['agent-sdlc-default'].limits, {
			maxPromptTokens: 49_968,
			maxCompletionTokens: 32,
			maxTotalTokens: 50_000,
			maxPhysicalAttempts: 1,
			maxRetriesPerRoute: 0,
			maxFailovers: 0,
			runMaxTotalTokens: 64_000,
		});
	});
	try {
		const consumed = contextForRequest(context, { operationId: 'consumed-49000' });
		reserve(consumed, {
			charge: {
				promptTokens: 49_000,
				completionTokens: 0,
				totalTokens: 49_000,
				physicalCalls: 1,
				costMicrousd: 0,
				premiumRequestUnits: 0,
			},
		});
		const denied = contextForRequest(context, { operationId: 'denied-16000' });
		assertBudgetError(
			() =>
				reserve(denied, {
					charge: {
						promptTokens: 16_000,
						completionTokens: 0,
						totalTokens: 16_000,
						physicalCalls: 1,
						costMicrousd: 0,
						premiumRequestUnits: 0,
					},
				}),
			'ERR_TOKEN_BUDGET_EXCEEDED',
			{
				dimension: 'totalTokens',
				limit: 64_000,
				requested: 65_000,
				remaining: 15_000,
				runId: context.request.runId,
			},
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('applies one run concurrency ceiling across participating profiles', () => {
	const context = setup('ledger-cross-profile-concurrency', {}, (policy) => {
		policy.instance.maxConcurrentReservations = 2;
		policy.routes[0].limits.maxConcurrentReservations = 2;
		policy.profiles['second-profile'] = {
			...structuredClone(policy.profiles['agent-sdlc-default']),
			consumer: 'second-consumer',
		};
	});
	try {
		reserve(context);
		const secondProfile = contextForRequest(context, {
			operationId: 'second-operation',
			consumer: 'second-consumer',
			profile: 'second-profile',
		});
		assert.throws(
			() => reserve(secondProfile),
			(error) =>
				error instanceof ModelUsageError &&
				error.code === 'ERR_CONCURRENCY_LIMIT',
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});
