import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ModelUsageLedger } from './ledger.ts';
import { recoverEnvelope } from './ledger-recovery.ts';
import { effectiveProfile, validateOperationRequest, validatePolicy } from '../policy/policy.ts';
import { baseRequest, cleanupTestRoot, enabledFakePolicy, makeTestRoot } from '../testing/test-support.mjs';
import { setup, reserve, assertBudgetError, spawnLedgerChild, spawnSuccessfulLedgerChild, waitForFiles } from '../testing/ledger-test-support.mjs';

test('recovers dead-owner reservations at full charge and appends a recovery outcome', () => {
	const context = setup('ledger-recovery');
	try {
		reserve(context);
		const recovering = new ModelUsageLedger({
			stateRoot: context.stateRoot,
			isOwnerAlive: () => false,
		});
		assert.throws(
			() => recovering.getOperation(context.request.runId, context.request.operationId, context.inputHash),
			(error) => error.code === 'ERR_USAGE_RECONCILIATION_FAILED',
		);
		const envelope = JSON.parse(fs.readFileSync(recovering.runFile(context.request.runId), 'utf8'));
		assert.equal(envelope.reservations.length, 0);
		assert.equal(envelope.attempts[0].outcome, 'recovery_charged');
		assert.equal(envelope.attempts[0].charge.totalTokens, 5);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('keeps a live-owner reservation after attempt deadline until operation deadline', () => {
	const startMs = Date.parse('2026-01-01T00:00:00.000Z');
	let nowMs = startMs;
	const context = setup('ledger-attempt-deadline-boundary', {}, (policy) => {
		policy.profiles['agent-sdlc-default'].limits.operationTimeoutMs = 10_000;
	});
	context.ledger = new ModelUsageLedger({
		stateRoot: context.stateRoot,
		isOwnerAlive: () => true,
		now: () => new Date(nowMs),
	});
	try {
		const reserved = reserve(context, { attemptTimeoutMs: 1_000 });
		nowMs = startMs + 1_001;
		assertBudgetError(
			() =>
				context.ledger.getOperation(
					context.request.runId,
					context.request.operationId,
					context.inputHash,
				),
			'ERR_OPERATION_IN_PROGRESS',
			{
				runId: context.request.runId,
				operationId: context.request.operationId,
			},
		);
		let envelope = JSON.parse(
			fs.readFileSync(context.ledger.runFile(context.request.runId), 'utf8'),
		);
		assert.equal(envelope.reservations[0].id, reserved.reservation.id);
		assert.equal(envelope.attempts.length, 0);

		nowMs = startMs + 10_000;
		assertBudgetError(
			() =>
				context.ledger.getOperation(
					context.request.runId,
					context.request.operationId,
					context.inputHash,
				),
			'ERR_USAGE_RECONCILIATION_FAILED',
			{ operationId: context.request.operationId },
		);
		envelope = JSON.parse(
			fs.readFileSync(context.ledger.runFile(context.request.runId), 'utf8'),
		);
		assert.equal(envelope.reservations.length, 0);
		assert.equal(envelope.attempts[0].outcome, 'recovery_charged');
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('recovers an abandoned retry transition after its operation deadline with a live owner PID', () => {
	const startMs = Date.parse('2026-01-01T00:00:00.000Z');
	let nowMs = startMs;
	const context = setup('ledger-retry-transition-deadline', {}, (policy) => {
		policy.profiles['agent-sdlc-default'].limits.operationTimeoutMs = 10_000;
	});
	context.ledger = new ModelUsageLedger({
		stateRoot: context.stateRoot,
		isOwnerAlive: () => true,
		now: () => new Date(nowMs),
	});
	try {
		const reserved = reserve(context);
		const completedAt = new Date(startMs + 1_000).toISOString();
		context.ledger.recordAttemptAndReconcile({
			runId: context.request.runId,
			operationId: context.request.operationId,
			reservationId: reserved.reservation.id,
			result: { status: 'failed', outcome: 'transport' },
			route: context.route,
			startedAt: new Date(startMs).toISOString(),
			completedAt,
		});

		nowMs = startMs + 10_000;
		assertBudgetError(
			() =>
				context.ledger.getOperation(
					context.request.runId,
					context.request.operationId,
					context.inputHash,
				),
			'ERR_USAGE_RECONCILIATION_FAILED',
			{ operationId: context.request.operationId },
		);
		const envelope = JSON.parse(
			fs.readFileSync(context.ledger.runFile(context.request.runId), 'utf8'),
		);
		assert.equal(envelope.operations[context.request.operationId].state, 'recovery_charged');
		assert.equal(envelope.reservations.length, 0);
		assert.equal(envelope.attempts.length, 1);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('serializes final-budget reservations across genuine child processes', async () => {
	const root = makeTestRoot('ledger-cross-process');
	const stateRoot = path.join(root, 'state');
	const runId = 'cross-process-run';
	const barrier = path.join(root, 'start');
	const operationIds = ['child-one', 'child-two'];
	try {
		const children = operationIds.map((operationId) =>
			spawnLedgerChild(stateRoot, runId, operationId, barrier),
		);
		await waitForFiles(operationIds.map((operationId) => `${barrier}.${operationId}.ready`));
		fs.writeFileSync(barrier, 'start\n');
		const results = await Promise.all(children);
		assert.equal(results.filter((result) => result.status === 'reserved').length, 1);
		assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
		assert.equal(
			results.find((result) => result.status === 'rejected').code,
			'ERR_TOKEN_BUDGET_EXCEEDED',
		);
		const envelope = JSON.parse(
			fs.readFileSync(path.join(stateRoot, 'runs', `${runId}.json`), 'utf8'),
		);
		assert.equal(envelope.reservations.length + envelope.attempts.length, 1);
	} finally {
		cleanupTestRoot(root);
	}
});

test('recovers a durable reservation left by an exited child process', async () => {
	const root = makeTestRoot('ledger-child-crash');
	const stateRoot = path.join(root, 'state');
	const runId = 'child-crash-run';
	const operationId = 'child-crash-operation';
	const barrier = path.join(root, 'start');
	try {
		const child = spawnLedgerChild(stateRoot, runId, operationId, barrier);
		await waitForFiles([`${barrier}.${operationId}.ready`]);
		fs.writeFileSync(barrier, 'start\n');
		assert.equal((await child).status, 'reserved');
		const runFile = path.join(stateRoot, 'runs', `${runId}.json`);
		const before = JSON.parse(fs.readFileSync(runFile, 'utf8'));
		assert.equal(before.reservations.length, 1);
		const inputHash = before.operations[operationId].inputHash;
		const recovering = new ModelUsageLedger({ stateRoot });
		assert.throws(
			() => recovering.getOperation(runId, operationId, inputHash),
			(error) => error.code === 'ERR_USAGE_RECONCILIATION_FAILED',
		);
		const after = JSON.parse(fs.readFileSync(runFile, 'utf8'));
		assert.equal(after.reservations.length, 0);
		assert.equal(after.attempts[0].outcome, 'recovery_charged');
		assert.equal(after.attempts[0].charge.totalTokens, 5);
	} finally {
		cleanupTestRoot(root);
	}
});

test('replays child-process durable success without creating a new reservation', async () => {
	const root = makeTestRoot('ledger-child-success');
	const stateRoot = path.join(root, 'state');
	const runId = 'child-success-run';
	const operationId = 'child-success-operation';
	try {
		const childResult = await spawnSuccessfulLedgerChild(stateRoot, runId, operationId);
		const policy = validatePolicy(enabledFakePolicy());
		const request = validateOperationRequest(baseRequest({ runId, operationId }));
		const profile = effectiveProfile(policy, request);
		const route = policy.routes.find((candidate) => candidate.id === 'fake-governed');
		const ledger = new ModelUsageLedger({ stateRoot });
		const replayed = ledger.reserveAttempt({
			policy,
			profile,
			route,
			request,
			inputHash: childResult.inputHash,
			ownerToken: 'fresh-parent',
			reservation: {
				promptTokens: 2,
				completionTokens: 3,
				totalTokens: 5,
				physicalCalls: 1,
				costMicrousd: 0,
				premiumRequestUnits: 0,
			},
			estimator: { name: 'parent-test', version: '1' },
			retryIndex: 0,
			failoverIndex: 0,
			attemptTimeoutMs: 60_000,
		});
		assert.deepEqual(replayed.replay.output, { durable: true });
		const envelope = JSON.parse(
			fs.readFileSync(path.join(stateRoot, 'runs', `${runId}.json`), 'utf8'),
		);
		assert.equal(envelope.reservations.length, 0);
		assert.equal(envelope.attempts.length, 1);
	} finally {
		cleanupTestRoot(root);
	}
});

test('recoverEnvelope leaves an empty reservation list unchanged', () => {
	const envelope = { reservations: [], operations: {} };
	const copy = structuredClone(envelope);
	assert.equal(recoverEnvelope(envelope, Date.now(), () => false), false);
	assert.deepEqual(envelope, copy);
});
