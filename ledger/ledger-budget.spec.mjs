import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import { assertReservationAdmissible, assembleReconciledCharge } from './ledger-budget.ts';
import { calculatePrice } from '../routing/pricing.ts';
import { addSecondFakeRoute, cleanupTestRoot } from '../testing/test-support.mjs';
import { setup, reserve, contextForRequest, setHighCeilings, assertBudgetError, reconcileUsage, readRunFile, PROVIDER_USAGE, PROVIDER_TOKEN_DETAILS } from '../testing/ledger-test-support.mjs';

test('provider cache usage counts the full prompt and prices each bucket', () => {
	const context = setup('ledger-cache-price', {}, (policy) => {
		const route = policy.routes.find((item) => item.id === 'fake-governed');
		Object.assign(route.pricing, {
			inputMicrousdPerMillionTokens: 2_000_000,
			outputMicrousdPerMillionTokens: 10_000_000,
			cacheReadMicrousdPerMillionTokens: 100_000,
			cacheWrite5mMicrousdPerMillionTokens: 2_500_000,
		});
	});
	try {
		const reserved = reserve(context, {
			charge: {
				promptTokens: 2_000,
				completionTokens: 20,
				totalTokens: 2_020,
				physicalCalls: 1,
				costMicrousd: 10_000,
				premiumRequestUnits: 0,
			},
		});
		const now = new Date().toISOString();
		const usage = {
			promptTokens: 100,
			cacheReadTokens: 1_000,
			cacheWriteTokens: 50,
			completionTokens: 10,
			source: 'provider',
		};
		context.ledger.recordAttemptAndReconcile({
			runId: context.request.runId,
			operationId: context.request.operationId,
			reservationId: reserved.reservation.id,
			result: {
				status: 'succeeded',
				output: { ok: true },
				usage,
				providerModelVersion: 'gemini-3.6-flash',
			},
			route: context.route,
			terminal: 'succeeded',
			output: { ok: true },
			startedAt: now,
			completedAt: now,
		});
		const attempt = context.ledger.loadRunLedger(context.request.runId).attempts[0];
		assert.equal(attempt.providerModelVersion, 'gemini-3.6-flash');
		const charge = attempt.charge;
		const priced = calculatePrice({
			promptTokens: usage.promptTokens,
			cacheReadTokens: usage.cacheReadTokens,
			cacheWriteTokens: usage.cacheWriteTokens,
			completionTokens: usage.completionTokens,
			pricing: context.route.pricing,
		});
		const uncached = calculatePrice({
			promptTokens: 1_150,
			completionTokens: usage.completionTokens,
			pricing: context.route.pricing,
		});
		assert.equal(charge.promptTokens, 1_150);
		assert.equal(charge.totalTokens, 1_160);
		assert.equal(charge.costMicrousd, priced.costMicrousd);
		assert.equal(charge.costMicrousd, 525);
		assert.ok(charge.costMicrousd < uncached.costMicrousd);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('charges full reservation when usage is absent and zero only when non-execution is proven', () => {
	const context = setup('ledger-conservative');
	try {
		let reserved = reserve(context);
		let now = new Date().toISOString();
		let reconciled = context.ledger.recordAttemptAndReconcile({
			runId: context.request.runId,
			operationId: context.request.operationId,
			reservationId: reserved.reservation.id,
			result: { status: 'failed', outcome: 'transport' },
			route: context.route,
			startedAt: now,
			completedAt: now,
		});

		test('charges the full reservation when adapter usage is only estimated', () => {
			const context = setup('ledger-estimated-usage');
			try {
				const reserved = reserve(context);
				const now = new Date().toISOString();
				const reconciled = context.ledger.recordAttemptAndReconcile({
					runId: context.request.runId,
					operationId: context.request.operationId,
					reservationId: reserved.reservation.id,
					result: {
						status: 'succeeded',
						output: { ok: true },
						usage: { promptTokens: 1, completionTokens: 0, source: 'estimated' },
					},
					route: context.route,
					terminal: 'succeeded',
					output: { ok: true },
					startedAt: now,
					completedAt: now,
				});
				assert.equal(reconciled.attempt.charge.totalTokens, 5);
				assert.equal(reconciled.attempt.usageSource, 'estimated');
			} finally {
				cleanupTestRoot(context.stateRoot);
			}
		});

		assert.equal(reconciled.attempt.charge.totalTokens, 5);
		reserved = reserve(context, { retryIndex: 1 });
		now = new Date().toISOString();
		reconciled = context.ledger.recordAttemptAndReconcile({
			runId: context.request.runId,
			operationId: context.request.operationId,
			reservationId: reserved.reservation.id,
			result: { status: 'failed', outcome: 'transport', executionProvenFalse: true },
			route: context.route,
			terminal: 'failed',
			failure: new ModelUsageError('ERR_ALL_ALLOWED_ROUTES_EXHAUSTED', 'failed'),
			startedAt: now,
			completedAt: now,
		});
		assert.equal(reconciled.attempt.charge.totalTokens, 0);
		assert.equal(reconciled.attempt.charge.physicalCalls, 1);
		assert.equal(reconciled.attempt.executionProvenFalse, true);
		assert.deepEqual(reconciled.attempt.reservationCharge, reserved.reservation.charge);
		assert.equal(
			reconciled.attempt.remainingRunBudget.totalTokens,
			context.profile.limits.runMaxTotalTokens - 5,
		);
		assert.equal(
			reconciled.attempt.remainingRunBudget.physicalCalls,
			context.profile.limits.runMaxPhysicalCalls - 2,
		);
		assert.equal(reconciled.summary.operationTotal.totalTokens, 5);
		assert.equal(reconciled.summary.operationTotal.physicalCalls, 2);
		const attempts = JSON.parse(
			fs.readFileSync(context.ledger.runFile(context.request.runId), 'utf8'),
		).attempts;
		assert.deepEqual(
			{
				totalTokens: reconciled.summary.operationTotal.totalTokens,
				physicalCalls: reconciled.summary.operationTotal.physicalCalls,
			},
			attempts.reduce(
				(total, attempt) => ({
					totalTokens: total.totalTokens + attempt.charge.totalTokens,
					physicalCalls: total.physicalCalls + attempt.charge.physicalCalls,
				}),
				{ totalTokens: 0, physicalCalls: 0 },
			),
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('charges but fails closed when provider usage exceeds the durable reservation', () => {
	const context = setup('ledger-provider-overage');
	try {
		const reserved = reserve(context);
		const now = new Date().toISOString();
		assert.throws(
			() =>
				context.ledger.recordAttemptAndReconcile({
					runId: context.request.runId,
					operationId: context.request.operationId,
					reservationId: reserved.reservation.id,
					result: {
						status: 'succeeded',
						output: { ok: true },
						usage: { promptTokens: 20, completionTokens: 20, source: 'provider' },
					},
					route: context.route,
					terminal: 'succeeded',
					output: { ok: true },
					startedAt: now,
					completedAt: now,
				}),
			(error) => error.code === 'ERR_USAGE_RECONCILIATION_FAILED',
		);
		const envelope = JSON.parse(
			fs.readFileSync(context.ledger.runFile(context.request.runId), 'utf8'),
		);
		assert.equal(envelope.attempts[0].charge.totalTokens, 40);
		assert.equal(envelope.operations[context.request.operationId].state, 'failed');
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('isolates the operation reservation ceiling', () => {
	const context = setup('ledger-operation-ceiling', {}, (policy) => {
		setHighCeilings(policy);
		Object.assign(policy.profiles['agent-sdlc-default'].limits, {
			maxPromptTokens: 68,
			maxCompletionTokens: 32,
			maxTotalTokens: 200,
			maxPhysicalAttempts: 2,
			maxRetriesPerRoute: 1,
			maxFailovers: 0,
		});
	});
	try {
		reserve(context, {
			charge: {
				promptTokens: 200,
				completionTokens: 0,
				totalTokens: 200,
				physicalCalls: 1,
				costMicrousd: 0,
				premiumRequestUnits: 0,
			},
		});
		assertBudgetError(
			() =>
				reserve(context, {
					retryIndex: 1,
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
				limit: 200,
				requested: 201,
				remaining: 0,
				operationId: context.request.operationId,
			},
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('enforces route maxTotalTokens as a per-attempt ceiling and rejects over-limit reservation', () => {
	const context = setup('ledger-route-attempt-token-ceiling', {}, (policy) => {
		setHighCeilings(policy);
		policy.routes.find((route) => route.id === 'fake-governed').limits.maxTotalTokens = 5;
	});
	try {
		assertBudgetError(
			() =>
				reserve(context, {
					charge: {
						promptTokens: 6,
						completionTokens: 0,
						totalTokens: 6,
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
				remaining: 5,
				reason: 'route',
				routeId: 'fake-governed',
				provider: 'fake',
				model: 'deterministic-json',
			},
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('@ac AC-03 @case AC-03.4 tokenDetails does not change the reconciled charge', () => {
	const plain = setup('ledger-ac-03-4-plain');
	const detailed = setup('ledger-ac-03-4-detailed');
	try {
		reconcileUsage(plain, reserve(plain), { usage: PROVIDER_USAGE });
		reconcileUsage(detailed, reserve(detailed), {
			usage: { ...PROVIDER_USAGE, tokenDetails: PROVIDER_TOKEN_DETAILS },
		});
		const plainAttempt = JSON.parse(readRunFile(plain)).attempts[0];
		const detailedAttempt = JSON.parse(readRunFile(detailed)).attempts[0];
		assert.equal(Object.hasOwn(plainAttempt, 'tokenDetails'), false);
		assert.deepEqual(detailedAttempt.tokenDetails, PROVIDER_TOKEN_DETAILS);
		assert.deepEqual(plainAttempt.charge, detailedAttempt.charge);
	} finally {
		cleanupTestRoot(plain.stateRoot);
		cleanupTestRoot(detailed.stateRoot);
	}
});

for (const dimension of ['route', 'model', 'provider']) {
	test(`isolates the ${dimension} reservation ceiling`, () => {
		const context = setup(`ledger-${dimension}-ceiling`, {}, (policy) => {
			setHighCeilings(policy);
			addSecondFakeRoute(policy);
			if (dimension === 'model') {
				policy.routes.find((route) => route.id === 'fake-secondary').model =
					'deterministic-json';
			}
			policy.routes.find((route) => route.id === 'fake-governed').limits.maxPhysicalCalls = 1;
		});
		try {
			const seedRouteId = dimension === 'route' ? 'fake-governed' : 'fake-secondary';
			const seed = contextForRequest(
				context,
				{ operationId: `${dimension}-seed-operation` },
				seedRouteId,
			);
			reserve(seed, {
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
				operationId: `${dimension}-second-operation`,
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
				'ERR_CALL_BUDGET_EXCEEDED',
				{
					dimension: 'physicalCalls',
					limit: 1,
					requested: 2,
					remaining: 0,
					reason: dimension,
					routeId: 'fake-governed',
					provider: 'fake',
					model: 'deterministic-json',
				},
			);
		} finally {
			cleanupTestRoot(context.stateRoot);
		}
	});
}

for (const budgetCase of [
	{
		name: 'calls',
		limitKey: 'maxPhysicalAttempts',
		chargeKey: 'physicalCalls',
		code: 'ERR_CALL_BUDGET_EXCEEDED',
		dimension: 'physicalCalls',
	},
	{
		name: 'cost',
		limitKey: 'runMaxCostMicrousd',
		chargeKey: 'costMicrousd',
		code: 'ERR_COST_BUDGET_EXCEEDED',
		dimension: 'costMicrousd',
	},
	{
		name: 'premium units',
		limitKey: 'runMaxPremiumRequestUnits',
		chargeKey: 'premiumRequestUnits',
		code: 'ERR_BUDGET_RESERVATION_DENIED',
		dimension: 'premiumRequestUnits',
	},
]) {
	test(`enforces the ${budgetCase.name} dimension with typed metadata`, () => {
		const context = setup(`ledger-${budgetCase.name.replaceAll(' ', '-')}`, {}, (policy) => {
			setHighCeilings(policy);
			policy.profiles['agent-sdlc-default'].limits[budgetCase.limitKey] = 5;
			if (budgetCase.limitKey === 'maxPhysicalAttempts') {
				policy.profiles['agent-sdlc-default'].limits.maxRetriesPerRoute = 4;
			}
		});
		try {
			const charge = {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				physicalCalls: 1,
				costMicrousd: 0,
				premiumRequestUnits: 0,
			};
			charge[budgetCase.chargeKey] = 6;
			assertBudgetError(
				() => reserve(context, { charge }),
				budgetCase.code,
				{
					dimension: budgetCase.dimension,
					limit: 5,
					requested: 6,
					remaining: 5,
					operationId: context.request.operationId,
				},
			);
		} finally {
			cleanupTestRoot(context.stateRoot);
		}
	});
}

test('assertReservationAdmissible admits the exact token ceiling and rejects one over each dimension', () => {
	const baseCharge = { promptTokens: 1, completionTokens: 0, totalTokens: 1, physicalCalls: 1, costMicrousd: 0, premiumRequestUnits: 0 };
	const limits = { maxTotalTokens: 10, maxPhysicalCalls: 10, maxCostMicrousd: 10, maxPremiumRequestUnits: 10, maxConcurrentReservations: 10 };
	const admit = (reservation, profileLimits = {}, records = []) => assertReservationAdmissible({
		envelopes: [{ attempts: records, reservations: [] }],
		envelope: { attempts: records, reservations: [] },
		request: { operationId: 'operation', profile: 'profile', runId: 'run' },
		profile: { limits: { maxTotalTokens: 1, maxPhysicalAttempts: 4, runMaxTotalTokens: 10, runMaxPhysicalCalls: 10, runMaxCostMicrousd: 10, runMaxPremiumRequestUnits: 10, maxConcurrentOperations: 2, ...profileLimits } },
		route: { id: 'route', provider: 'fake', model: 'model', limits },
		reservation,
		policy: { instance: limits },
	});
	const reject = (reservation, code, profileLimits, records) => {
		assert.throws(() => admit(reservation, profileLimits, records), (error) => error.code === code);
	};
	assert.doesNotThrow(() => admit(baseCharge));
	reject({ ...baseCharge, promptTokens: 2, totalTokens: 2 }, 'ERR_TOKEN_BUDGET_EXCEEDED');
	reject({ ...baseCharge, physicalCalls: 5 }, 'ERR_CALL_BUDGET_EXCEEDED');
	reject({ ...baseCharge, costMicrousd: 11 }, 'ERR_COST_BUDGET_EXCEEDED');
	reject({ ...baseCharge, premiumRequestUnits: 11 }, 'ERR_BUDGET_RESERVATION_DENIED');
	const active = { operationId: 'operation', profile: 'profile', routeId: 'route', provider: 'fake', model: 'model', deadlineAt: '2026-10-22T00:00:00.000Z', charge: baseCharge };
	reject(baseCharge, 'ERR_CONCURRENCY_LIMIT', { maxTotalTokens: 10, maxConcurrentOperations: 1 }, [active, active]);
});

test('assembleReconciledCharge keeps provider usage, proven non-execution, and the reservation', () => {
	const route = { metered: true, pricing: { status: 'known', inputMicrousdPerMillionTokens: 0, outputMicrousdPerMillionTokens: 0, fixedRequestMicrousd: 0 } };
	const reservation = { charge: { promptTokens: 4, completionTokens: 2, totalTokens: 6, physicalCalls: 1, costMicrousd: 3, premiumRequestUnits: 1 } };
	const provider = assembleReconciledCharge({ result: { usage: { source: 'provider', promptTokens: 1, completionTokens: 1 } }, reservation, route });
	assert.equal(provider.usageSource, 'provider');
	assert.equal(provider.charge.promptTokens, 1);
	assert.equal(provider.charge.completionTokens, 1);
	const proven = assembleReconciledCharge({ result: { executionProvenFalse: true }, reservation, route });
	assert.equal(proven.charge.totalTokens, 0);
	assert.equal(proven.charge.physicalCalls, 1);
	assert.equal(proven.usageSource, 'estimated');
	const estimated = assembleReconciledCharge({ result: {}, reservation, route });
	assert.equal(estimated.charge, reservation.charge);
	assert.equal(estimated.usageSource, 'estimated');
});
