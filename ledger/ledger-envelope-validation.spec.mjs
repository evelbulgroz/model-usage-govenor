import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import { ModelUsageLedger, loadRunLedger } from './ledger.ts';
import { emptyEnvelope, validateEnvelope } from './ledger-envelope-validation.ts';
import { canonicalJson } from '../policy/policy.ts';
import { cleanupTestRoot, makeTestRoot } from '../testing/test-support.mjs';
import { setup, reserve, contextForRequest, reconcileFullReservation, successResult, reconcileUsage, readRunFile, PROVIDER_USAGE, PROVIDER_TOKEN_DETAILS } from '../testing/ledger-test-support.mjs';

test('reserves durably before dispatch, reconciles provider usage and replays copies', () => {
	const context = setup('ledger-success');
	try {
		const reserved = reserve(context);
		const file = context.ledger.runFile(context.request.runId);
		const persistedReservation = JSON.parse(fs.readFileSync(file)).reservations[0];
		assert.deepEqual(persistedReservation.charge, reserved.reservation.charge);
		assert.deepEqual(persistedReservation.estimator, { name: 'test', version: '1' });
		assert.deepEqual(persistedReservation.runLimitSnapshot, {
			maxTotalTokens: context.profile.limits.runMaxTotalTokens,
			maxPhysicalCalls: context.profile.limits.runMaxPhysicalCalls,
			maxCostMicrousd: context.profile.limits.runMaxCostMicrousd,
			maxPremiumRequestUnits: context.profile.limits.runMaxPremiumRequestUnits,
		});
		const reconciled = successResult(context, reserved);
		assert.equal(reconciled.summary.operationTotal.totalTokens, 2);
		assert.deepEqual(reconciled.attempt.reservationCharge, reserved.reservation.charge);
		assert.deepEqual(reconciled.attempt.estimator, { name: 'test', version: '1' });
		assert.equal(reconciled.attempt.executionProvenFalse, false);
		assert.equal(reconciled.attempt.usageSource, 'provider');
		assert.equal(reconciled.attempt.charge.totalTokens, 2);
		assert.deepEqual(reconciled.attempt.runLimitSnapshot, {
			maxTotalTokens: context.profile.limits.runMaxTotalTokens,
			maxPhysicalCalls: context.profile.limits.runMaxPhysicalCalls,
			maxCostMicrousd: context.profile.limits.runMaxCostMicrousd,
			maxPremiumRequestUnits: context.profile.limits.runMaxPremiumRequestUnits,
		});
		assert.deepEqual(reconciled.attempt.remainingRunBudget, {
			totalTokens: context.profile.limits.runMaxTotalTokens - 2,
			physicalCalls: context.profile.limits.runMaxPhysicalCalls - 1,
			costMicrousd: context.profile.limits.runMaxCostMicrousd,
			premiumRequestUnits: context.profile.limits.runMaxPremiumRequestUnits,
		});
		const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
		const reconstructed = envelope.attempts.reduce(
			(total, attempt) => ({
				totalTokens: total.totalTokens + attempt.charge.totalTokens,
				physicalCalls: total.physicalCalls + attempt.charge.physicalCalls,
				costMicrousd: total.costMicrousd + attempt.charge.costMicrousd,
				premiumRequestUnits:
					total.premiumRequestUnits + attempt.charge.premiumRequestUnits,
			}),
			{ totalTokens: 0, physicalCalls: 0, costMicrousd: 0, premiumRequestUnits: 0 },
		);
		assert.deepEqual(
			{
				totalTokens: reconciled.summary.runTotal.totalTokens,
				physicalCalls: reconciled.summary.runTotal.physicalCalls,
				costMicrousd: reconciled.summary.runTotal.costMicrousd,
				premiumRequestUnits: reconciled.summary.runTotal.premiumRequestUnits,
			},
			reconstructed,
		);
		const replay = context.ledger.getOperation(
			context.request.runId,
			context.request.operationId,
			context.inputHash,
		);
		assert.equal(replay.state, 'succeeded');
		replay.usageRecordIds.push('mutation');
		assert.equal(
			context.ledger.getOperation(context.request.runId, context.request.operationId, context.inputHash)
				.usageRecordIds.length,
			1,
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('fails closed on malformed ledger envelopes and path traversal IDs', () => {
	const root = makeTestRoot('ledger-malformed');
	try {
		const ledger = new ModelUsageLedger({ stateRoot: root });
		assert.throws(() => ledger.runFile('../escape'));
		fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
		fs.writeFileSync(path.join(root, 'runs', 'valid.json'), '{"schemaVersion":"bad"}');
		assert.throws(() => ledger.getRunSummary('valid', 'operation'));
	} finally {
		cleanupTestRoot(root);
	}
});

test('AC-22: loadRunLedger accepts schemaVersion 1.0.0 and normalizes missing calibration fields, and accepts 1.1.0', () => {
	const context = setup('ledger-ac22');
	try {
		reserve(context, {
			effectiveStrategy: 'quality-first',
			counterfactualTier2CostMicrousd: 500,
		});
		const raw120 = JSON.parse(fs.readFileSync(context.ledger.runFile(context.request.runId), 'utf8'));
		assert.equal(raw120.schemaVersion, '1.2.0');

		// 1.1.0 loads cleanly when the same bytes are labelled 1.1.0
		const raw110 = structuredClone(raw120);
		raw110.schemaVersion = '1.1.0';
		const loaded110 = loadRunLedger(raw110, context.request.runId);
		assert.equal(loaded110.schemaVersion, '1.1.0');
		assert.equal(loaded110.operations[context.request.operationId].effectiveStrategy, 'quality-first');
		assert.equal(loaded110.operations[context.request.operationId].counterfactualTier2CostMicrousd, 500);

		// Mutate into 1.0.0 legacy shape by stripping calibration fields
		const raw100 = structuredClone(raw110);
		raw100.schemaVersion = '1.0.0';
		delete raw100.operations[context.request.operationId].effectiveStrategy;
		delete raw100.operations[context.request.operationId].selectedQualityTier;
		delete raw100.operations[context.request.operationId].counterfactualTier2CostMicrousd;
		for (const res of raw100.reservations) {
			delete res.qualityTier;
			delete res.effectiveStrategy;
		}

		// 1.0.0 loads cleanly and normalizes missing calibration fields
		const loaded100 = loadRunLedger(raw100, context.request.runId);
		assert.equal(loaded100.schemaVersion, '1.0.0');
		assert.equal(loaded100.operations[context.request.operationId].effectiveStrategy, 'balanced');
		assert.equal(loaded100.operations[context.request.operationId].selectedQualityTier, undefined);
		assert.equal(loaded100.operations[context.request.operationId].counterfactualTier2CostMicrousd, undefined);
		assert.equal(loaded100.reservations[0].qualityTier, undefined);
		assert.equal(loaded100.reservations[0].effectiveStrategy, undefined);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('reserveAttempt and recordAttemptAndReconcile persist and copy qualityTier and effectiveStrategy', () => {
	const context = setup('ledger-calibration-fields');
	try {
		const reserved = context.ledger.reserveAttempt({
			policy: context.policy,
			profile: context.profile,
			route: context.route,
			request: context.request,
			inputHash: context.inputHash,
			ownerToken: 'owner-calibration',
			reservation: {
				promptTokens: 2,
				completionTokens: 3,
				totalTokens: 5,
				physicalCalls: 1,
				costMicrousd: 50,
				premiumRequestUnits: 0,
			},
			estimator: { name: 'test', version: '1' },
			retryIndex: 0,
			failoverIndex: 0,
			attemptTimeoutMs: 1000,
			effectiveStrategy: 'quality-first',
			counterfactualTier2CostMicrousd: 150,
		});

		assert.equal(reserved.reservation.qualityTier, context.route.qualityTier);
		assert.equal(reserved.reservation.effectiveStrategy, 'quality-first');

		const now = new Date().toISOString();
		const reconciled = context.ledger.recordAttemptAndReconcile({
			runId: context.request.runId,
			operationId: context.request.operationId,
			reservationId: reserved.reservation.id,
			result: {
				status: 'succeeded',
				output: { calibration: 'ok' },
			},
			route: context.route,
			terminal: 'succeeded',
			output: { calibration: 'ok' },
			startedAt: now,
			completedAt: now,
		});

		const envelope = context.ledger.loadRunLedger(context.request.runId);
		assert.equal(envelope.attempts[0].qualityTier, context.route.qualityTier);
		assert.equal(envelope.attempts[0].effectiveStrategy, 'quality-first');
		assert.equal(envelope.operations[context.request.operationId].effectiveStrategy, 'quality-first');
		assert.equal(envelope.operations[context.request.operationId].selectedQualityTier, context.route.qualityTier);
		assert.equal(envelope.operations[context.request.operationId].counterfactualTier2CostMicrousd, 150);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('a later profile extends the shared run deadline from creation and expiry is not a route timeout', () => {
	const startMs = Date.parse('2026-10-21T11:50:03.867Z');
	const criticTimeoutMs = 7_200_000;
	const implementerTimeoutMs = 28_800_000;
	let nowMs = startMs;
	const context = setup('ledger-shared-run-deadline', { profile: 'critic-review' });
	context.ledger = new ModelUsageLedger({
		stateRoot: context.stateRoot,
		now: () => new Date(nowMs),
	});
	try {
		const critic = reserve(context);
		reconcileFullReservation(context, critic);
		assert.equal(Date.parse(critic.runDeadlineAt) - startMs, criticTimeoutMs);

		nowMs = startMs + criticTimeoutMs + 1_000;
		const implementer = contextForRequest(context, {
			profile: 'agent-sdlc-default',
			operationId: 'operation-implementer',
		});
		const probed = reserve(implementer, { dryRun: true });
		assert.equal(probed.fits, true);
		const beforePersist = JSON.parse(
			fs.readFileSync(context.ledger.runFile(context.request.runId), 'utf8'),
		);
		assert.equal(Date.parse(beforePersist.runDeadlineAt) - startMs, criticTimeoutMs);

		const extended = reserve(implementer);
		reconcileFullReservation(implementer, extended);
		assert.equal(Date.parse(extended.runDeadlineAt) - startMs, implementerTimeoutMs);

		const criticAgain = contextForRequest(context, {
			profile: 'critic-review',
			operationId: 'operation-critic-again',
		});
		const unchanged = reserve(criticAgain);
		reconcileFullReservation(criticAgain, unchanged);
		assert.equal(Date.parse(unchanged.runDeadlineAt) - startMs, implementerTimeoutMs);

		nowMs = startMs + implementerTimeoutMs;
		const expiredOperationId = 'operation-expired';
		assert.throws(
			() =>
				reserve(
					contextForRequest(context, {
						profile: 'agent-sdlc-default',
						operationId: expiredOperationId,
					}),
				),
			(error) => {
				assert.ok(error instanceof ModelUsageError);
				assert.equal(error.code, 'ERR_RUN_DEADLINE_EXPIRED');
				assert.equal(error.metadata.profile, 'agent-sdlc-default');
				assert.equal(error.metadata.limit, implementerTimeoutMs);
				assert.equal(Date.parse(error.metadata.runDeadlineAt) - startMs, implementerTimeoutMs);
				return true;
			},
		);
		const expired = JSON.parse(fs.readFileSync(context.ledger.runFile(context.request.runId), 'utf8'));
		assert.equal(expired.operations[expiredOperationId], undefined);
		assert.equal(Date.parse(expired.runDeadlineAt) - startMs, implementerTimeoutMs);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('@ac AC-03 @case AC-03.1 a new envelope is 1.2.0 and its provider attempt has tokenDetails', () => {
	const context = setup('ledger-ac-03-1');
	try {
		const reserved = reserve(context);
		reconcileUsage(context, reserved, {
			usage: { ...PROVIDER_USAGE, tokenDetails: PROVIDER_TOKEN_DETAILS },
		});
		const envelope = JSON.parse(readRunFile(context));
		assert.equal(envelope.schemaVersion, '1.2.0');
		assert.equal(envelope.attempts[0].usageSource, 'provider');
		assert.deepEqual(envelope.attempts[0].tokenDetails, PROVIDER_TOKEN_DETAILS);
		assert.deepEqual(envelope.attempts[0].charge, {
			promptTokens: 2,
			completionTokens: 1,
			totalTokens: 3,
			physicalCalls: 1,
			costMicrousd: 0,
			premiumRequestUnits: 0,
		});
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('@ac AC-03 @case AC-03.3 the next attempt upgrades a 1.1.0 envelope without rewriting earlier attempts', () => {
	const context = setup('ledger-ac-03-3');
	try {
		successResult(context, reserve(context));
		const before = readRunFile(context);
		const attemptBytes = canonicalJson(JSON.parse(before).attempts[0]);
		assert.equal(before.split(attemptBytes).length - 1, 1);
		const schemaNeedle = '"schemaVersion":"1.2.0"';
		assert.equal(before.split(schemaNeedle).length - 1, 1);
		fs.writeFileSync(context.ledger.runFile(context.request.runId), before.replace(schemaNeedle, '"schemaVersion":"1.1.0"'));

		const next = contextForRequest(context, { operationId: 'operation-token-details' });
		reconcileUsage(next, reserve(next), {
			usage: { ...PROVIDER_USAGE, tokenDetails: PROVIDER_TOKEN_DETAILS },
		});

		const after = readRunFile(context);
		const envelope = JSON.parse(after);
		assert.equal(envelope.schemaVersion, '1.2.0');
		assert.equal(canonicalJson(envelope.attempts[0]), attemptBytes);
		assert.equal(after.split(attemptBytes).length - 1, 1);
		assert.deepEqual(envelope.attempts[1].tokenDetails, PROVIDER_TOKEN_DETAILS);
		assert.equal(envelope.attempts[0].tokenDetails, undefined);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('@ac AC-04 @case AC-04.1 schema 1.0.0 and 1.1.0 envelopes still validate', () => {
	const context = setup('ledger-ac-04-1');
	try {
		successResult(context, reserve(context));
		const current = JSON.parse(readRunFile(context));
		const raw110 = structuredClone(current);
		raw110.schemaVersion = '1.1.0';
		const loaded110 = loadRunLedger(raw110, context.request.runId);
		assert.equal(loaded110.schemaVersion, '1.1.0');
		assert.equal(loaded110.attempts[0].id, current.attempts[0].id);
		assert.equal(loaded110.attempts[0].tokenDetails, undefined);

		const raw100 = structuredClone(raw110);
		raw100.schemaVersion = '1.0.0';
		delete raw100.operations[context.request.operationId].effectiveStrategy;
		delete raw100.operations[context.request.operationId].selectedQualityTier;
		delete raw100.operations[context.request.operationId].counterfactualTier2CostMicrousd;
		delete raw100.attempts[0].qualityTier;
		delete raw100.attempts[0].effectiveStrategy;
		const loaded100 = loadRunLedger(raw100, context.request.runId);
		assert.equal(loaded100.schemaVersion, '1.0.0');
		assert.equal(loaded100.attempts[0].id, current.attempts[0].id);
		assert.equal(loaded100.operations[context.request.operationId].effectiveStrategy, 'balanced');
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('emptyEnvelope is schema 1.2.0 and validateEnvelope accepts that shape', () => {
	const now = new Date().toISOString();
	const deadline = new Date(Date.now() + 1000).toISOString();
	const envelope = emptyEnvelope('run-id', { schemaVersion: '1.0.0', pricingVersion: '2026-10-16' }, now, deadline);
	assert.equal(envelope.schemaVersion, '1.2.0');
	assert.equal(validateEnvelope(envelope, 'run-id').runId, 'run-id');
	assert.throws(() => validateEnvelope({}, 'run-id'), /required/);
});
