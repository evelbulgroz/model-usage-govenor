import assert from 'node:assert/strict';
import test from 'node:test';
import { operationInputHash, validateOperationRequest } from '../policy/policy.ts';
import { baseRequest, cleanupTestRoot } from '../testing/test-support.mjs';
import { setup, reserve, contextForRequest, setHighCeilings, assertBudgetError } from '../testing/ledger-test-support.mjs';

test('isolates the instance reservation ceiling', () => {
	const context = setup('ledger-instance-ceiling', {}, (policy) => {
		setHighCeilings(policy);
		policy.instance.maxTotalTokens = 5;
	});
	try {
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
		const second = contextForRequest(context, {
			runId: 'instance-second-run',
			operationId: 'instance-second-operation',
		});
		assertBudgetError(
			() =>
				reserve(second, {
					charge: {
						promptTokens: 1,
						completionTokens: 0,
						totalTokens: 1,
						physicalCalls: 1,
						costMicrousd: 0,
						premiumRequestUnits: 0,
					},
				}),
			'ERR_TOKEN_BUDGET_EXCEEDED',
			{
				dimension: 'totalTokens',
				limit: 5,
				requested: 6,
				remaining: 0,
				reason: 'instance',
			},
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('isolates the instance concurrency ceiling', () => {
	const context = setup('ledger-concurrency-ceiling', {}, (policy) => {
		setHighCeilings(policy);
		policy.instance.maxConcurrentReservations = 1;
	});
	try {
		reserve(context);
		const second = contextForRequest(context, {
			runId: 'concurrency-second-run',
			operationId: 'concurrency-second-operation',
		});
		assertBudgetError(
			() => reserve(second),
			'ERR_CONCURRENCY_LIMIT',
			{
				dimension: 'concurrency',
				limit: 1,
				requested: 2,
				remaining: 0,
				reason: 'instance',
			},
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('serializes competing final-budget reservations under the instance lock', async () => {
	const context = setup('ledger-concurrency', { requestedLimits: { maxCompletionTokens: 3 } }, (policy) => {
		const limits = policy.profiles['agent-sdlc-default'].limits;
		Object.assign(limits, {
			maxPromptTokens: 2,
			maxCompletionTokens: 3,
			maxTotalTokens: 5,
			maxPhysicalAttempts: 1,
			maxRetriesPerRoute: 0,
			maxFailovers: 0,
			maxConcurrentOperations: 2,
			runMaxTotalTokens: 9,
		});
		policy.instance.maxConcurrentReservations = 2;
	});
	try {
		const secondRequest = validateOperationRequest(
			baseRequest({ runId: context.request.runId, operationId: 'second-operation' }),
		);
		const second = { ...context, request: secondRequest, inputHash: operationInputHash(secondRequest) };
		const results = await Promise.allSettled([
			Promise.resolve().then(() => reserve(context)),
			Promise.resolve().then(() => reserve(second)),
		]);
		assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
		assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('applies operation concurrency within one run without blocking unrelated runs', () => {
	const context = setup('ledger-run-concurrency', {}, (policy) => {
		policy.instance.maxConcurrentReservations = 2;
		policy.routes[0].limits.maxConcurrentReservations = 2;
	});
	try {
		reserve(context);
		const otherRun = contextForRequest(context, {
			runId: 'other-run',
			operationId: 'other-operation',
		});
		assert.doesNotThrow(() => reserve(otherRun));
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});
