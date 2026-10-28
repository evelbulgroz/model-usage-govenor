import fs from 'node:fs';
import { ModelUsageLedger } from './ledger.ts';
import {
	effectiveProfile,
	operationInputHash,
	validateOperationRequest,
	validatePolicy,
} from '../policy/policy.ts';
import { baseRequest, enabledFakePolicy } from '../testing/test-support.mjs';

const [stateRoot, runId, operationId, barrierFile] = process.argv.slice(2);
const policyInput = enabledFakePolicy();
Object.assign(policyInput.profiles['agent-sdlc-default'].limits, {
	maxPromptTokens: 2,
	maxCompletionTokens: 3,
	maxTotalTokens: 5,
	maxPhysicalAttempts: 1,
	maxRetriesPerRoute: 0,
	maxFailovers: 0,
	maxConcurrentOperations: 2,
	runMaxTotalTokens: 5,
	runMaxPhysicalCalls: 3,
});
Object.assign(policyInput.instance, {
	maxTotalTokens: 5,
	maxPhysicalCalls: 2,
	maxConcurrentReservations: 2,
});
Object.assign(policyInput.routes[0].limits, {
	maxPromptTokens: 2,
	maxCompletionTokens: 3,
	maxTotalTokens: 5,
	maxPhysicalCalls: 2,
	maxConcurrentReservations: 2,
});
const policy = validatePolicy(policyInput);
const request = validateOperationRequest(
	baseRequest({
		runId,
		operationId,
		requestedLimits: { maxCompletionTokens: 3 },
	}),
);
const profile = effectiveProfile(policy, request);
const route = policy.routes.find((candidate) => candidate.id === 'fake-governed');
const readyFile = `${barrierFile}.${operationId}.ready`;
fs.writeFileSync(readyFile, `${process.pid}\n`);
while (!fs.existsSync(barrierFile)) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

try {
	const ledger = new ModelUsageLedger({ stateRoot });
	const reserved = ledger.reserveAttempt({
		policy,
		profile,
		route,
		request,
		inputHash: operationInputHash(request),
		ownerToken: `child-${process.pid}`,
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
	process.stdout.write(`${JSON.stringify({ status: 'reserved', id: reserved.reservation.id })}\n`);
} catch (error) {
	process.stdout.write(`${JSON.stringify({ status: 'rejected', code: error.code ?? error.name })}\n`);
}
