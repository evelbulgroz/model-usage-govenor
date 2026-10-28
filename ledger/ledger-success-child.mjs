import { ModelUsageLedger } from './ledger.ts';
import {
	effectiveProfile,
	operationInputHash,
	validateOperationRequest,
	validatePolicy,
} from '../policy/policy.ts';
import { baseRequest, enabledFakePolicy } from '../testing/test-support.mjs';

const [stateRoot, runId, operationId] = process.argv.slice(2);
const policy = validatePolicy(enabledFakePolicy());
const request = validateOperationRequest(baseRequest({ runId, operationId }));
const profile = effectiveProfile(policy, request);
const route = policy.routes.find((candidate) => candidate.id === 'fake-governed');
const inputHash = operationInputHash(request);
const ledger = new ModelUsageLedger({ stateRoot });
const reserved = ledger.reserveAttempt({
	policy,
	profile,
	route,
	request,
	inputHash,
	ownerToken: `success-child-${process.pid}`,
	reservation: {
		promptTokens: 2,
		completionTokens: 3,
		totalTokens: 5,
		physicalCalls: 1,
		costMicrousd: 0,
		premiumRequestUnits: 0,
	},
	estimator: { name: 'child-test', version: '1' },
	retryIndex: 0,
	failoverIndex: 0,
	attemptTimeoutMs: 60_000,
});
const now = new Date().toISOString();
ledger.recordAttemptAndReconcile({
	runId,
	operationId,
	reservationId: reserved.reservation.id,
	result: {
		status: 'succeeded',
		output: { durable: true },
		usage: { promptTokens: 1, completionTokens: 1, source: 'provider' },
	},
	route,
	terminal: 'succeeded',
	output: { durable: true },
	startedAt: now,
	completedAt: now,
});
process.stdout.write(`${JSON.stringify({ inputHash })}\n`);
