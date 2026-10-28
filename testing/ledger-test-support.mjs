/**
 * Shared ledger spec fixtures. Excluded from the navigability ceiling.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import { ModelUsageLedger, loadRunLedger } from '../ledger/ledger.ts';
import { effectiveProfile, operationInputHash, validateOperationRequest, validatePolicy } from '../policy/policy.ts';
import { baseRequest, enabledFakePolicy, makeTestRoot } from './test-support.mjs';

export function setup(label, requestOverrides = {}, policyMutation) {
	const stateRoot = makeTestRoot(label);
	const rawPolicy = enabledFakePolicy();
	policyMutation?.(rawPolicy);
	const policy = validatePolicy(rawPolicy);
	const request = validateOperationRequest(baseRequest(requestOverrides));
	const profile = effectiveProfile(policy, request);
	const route = policy.routes.find((candidate) => candidate.id === 'fake-governed');
	const ledger = new ModelUsageLedger({ stateRoot });
	return { stateRoot, policy, request, profile, route, ledger, inputHash: operationInputHash(request) };
}

export function reserve(context, overrides = {}) {
	return context.ledger.reserveAttempt({
		policy: context.policy,
		profile: context.profile,
		route: context.route,
		request: context.request,
		inputHash: context.inputHash,
		ownerToken: overrides.ownerToken ?? 'owner',
		reservation: overrides.charge ?? {
			promptTokens: 2,
			completionTokens: 3,
			totalTokens: 5,
			physicalCalls: 1,
			costMicrousd: 0,
			premiumRequestUnits: 0,
		},
		estimator: { name: 'test', version: '1' },
		retryIndex: overrides.retryIndex ?? 0,
		failoverIndex: overrides.failoverIndex ?? 0,
		attemptTimeoutMs: overrides.attemptTimeoutMs ?? 1000,
		effectiveStrategy: overrides.effectiveStrategy,
		counterfactualTier2CostMicrousd: overrides.counterfactualTier2CostMicrousd,
		dryRun: overrides.dryRun === true,
	});
}

export function contextForRequest(context, requestOverrides = {}, routeId = 'fake-governed') {
	const request = validateOperationRequest(
		baseRequest({
			runId: context.request.runId,
			...requestOverrides,
		}),
	);
	return {
		...context,
		request,
		profile: effectiveProfile(context.policy, request),
		route: context.policy.routes.find((candidate) => candidate.id === routeId),
		inputHash: operationInputHash(request),
	};
}

export function reconcileFullReservation(context, reserved, { terminal = 'succeeded' } = {}) {
	const now = new Date().toISOString();
	return context.ledger.recordAttemptAndReconcile({
		runId: context.request.runId,
		operationId: context.request.operationId,
		reservationId: reserved.reservation.id,
		result: {
			status: terminal === 'succeeded' ? 'succeeded' : 'failed',
			...(terminal === 'succeeded' ? { output: { ok: true } } : { outcome: 'transport' }),
		},
		route: context.route,
		terminal,
		...(terminal === 'succeeded'
			? { output: { ok: true } }
			: { failure: new ModelUsageError('ERR_ALL_ALLOWED_ROUTES_EXHAUSTED', 'failed') }),
		startedAt: now,
		completedAt: now,
	});
}

export function setHighCeilings(policy) {
	const limits = policy.profiles['agent-sdlc-default'].limits;
	Object.assign(limits, {
		maxPromptTokens: 100_000,
		maxCompletionTokens: 100_000,
		maxTotalTokens: 2_000_000,
		maxPhysicalAttempts: 10,
		maxRetriesPerRoute: 9,
		maxFailovers: 5,
		maxConcurrentOperations: 16,
		runMaxTotalTokens: 2_000_000,
		runMaxPhysicalCalls: 100,
		runMaxCostMicrousd: 1_000_000,
		runMaxPremiumRequestUnits: 100,
	});
	Object.assign(policy.instance, {
		maxTotalTokens: 2_000_000,
		maxPhysicalCalls: 100,
		maxCostMicrousd: 1_000_000,
		maxPremiumRequestUnits: 100,
		maxConcurrentReservations: 100,
	});
	for (const route of policy.routes) {
		if (route.id === 'copilot-external') continue;
		Object.assign(route.limits, {
			maxPromptTokens: 1_000_000,
			maxCompletionTokens: 1_000_000,
			maxTotalTokens: 1_000_000,
			maxPhysicalCalls: 100,
			maxCostMicrousd: 1_000_000,
			maxPremiumRequestUnits: 100,
			maxConcurrentReservations: 100,
		});
	}
}

export function successResult(context, reserved, output = { ok: true }) {
	const now = new Date().toISOString();
	return context.ledger.recordAttemptAndReconcile({
		runId: context.request.runId,
		operationId: context.request.operationId,
		reservationId: reserved.reservation.id,
		result: {
			status: 'succeeded',
			output,
			usage: { promptTokens: 1, completionTokens: 1, source: 'provider' },
		},
		route: context.route,
		terminal: 'succeeded',
		output,
		startedAt: now,
		completedAt: now,
	});
}

export function assertBudgetError(action, code, metadata) {
	assert.throws(action, (error) => {
		assert.ok(error instanceof ModelUsageError);
		assert.equal(error.code, code);
		for (const [key, value] of Object.entries(metadata)) {
			assert.equal(error.metadata[key], value, `metadata.${key}`);
		}
		return true;
	});
}

export function spawnLedgerChild(stateRoot, runId, operationId, barrierFile) {
	const child = spawn(
		process.execPath,
		[
			path.join(import.meta.dirname, '../ledger/ledger-child.mjs'),
			stateRoot,
			runId,
			operationId,
			barrierFile,
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] },
	);
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code) => {
			if (code !== 0) {
				reject(new Error(`ledger child exited ${code}: ${stderr}`));
				return;
			}
			resolve(JSON.parse(stdout.trim()));
		});
	});
}

export function spawnSuccessfulLedgerChild(stateRoot, runId, operationId) {
	const child = spawn(
		process.execPath,
		[
			path.join(import.meta.dirname, '../ledger/ledger-success-child.mjs'),
			stateRoot,
			runId,
			operationId,
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] },
	);
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code) => {
			if (code !== 0) {
				reject(new Error(`successful ledger child exited ${code}: ${stderr}`));
				return;
			}
			resolve(JSON.parse(stdout.trim()));
		});
	});
}

export async function waitForFiles(files) {
	const deadline = Date.now() + 5000;
	while (files.some((file) => !fs.existsSync(file))) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for ledger children');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export function reconcileUsage(context, reserved, { usage, terminal = 'succeeded', outcome, failure } = {}) {
	const now = new Date().toISOString();
	const succeeded = terminal === 'succeeded';
	return context.ledger.recordAttemptAndReconcile({
		runId: context.request.runId,
		operationId: context.request.operationId,
		reservationId: reserved.reservation.id,
		result: {
			status: succeeded ? 'succeeded' : 'failed',
			...(succeeded ? { output: { ok: true } } : { outcome }),
			...(usage === undefined ? {} : { usage }),
		},
		route: context.route,
		terminal,
		...(succeeded
			? { output: { ok: true } }
			: { failure }),
		startedAt: now,
		completedAt: now,
	});
}

export function readRunFile(context) {
	return fs.readFileSync(context.ledger.runFile(context.request.runId), 'utf8');
}

export const PROVIDER_USAGE = {
	promptTokens: 1,
	cacheReadTokens: 1,
	completionTokens: 1,
	source: 'provider',
};

export const PROVIDER_TOKEN_DETAILS = {
	cacheReadTokens: 1,
	cacheWriteTokens: null,
	reasoningTokens: 1,
};

export function detailsEnvelope(label) {
	const context = setup(label);
	reconcileUsage(context, reserve(context), {
		usage: { ...PROVIDER_USAGE, tokenDetails: { ...PROVIDER_TOKEN_DETAILS } },
	});
	return { context, envelope: JSON.parse(readRunFile(context)) };
}

export function assertLedgerRejects(envelope, pattern) {
	assert.throws(
		() => loadRunLedger(structuredClone(envelope), envelope.runId),
		(error) => {
			assert.ok(error instanceof TypeError);
			assert.match(error.message, pattern);
			return true;
		},
	);
}
