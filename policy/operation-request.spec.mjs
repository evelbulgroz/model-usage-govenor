import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveProfile, validatePolicy } from './policy.ts';
import { canonicalJson, normalizedOperationInput, operationInputHash, validateOperationRequest } from './operation-request.ts';
import { baseRequest, readCommittedPolicy } from '../testing/test-support.mjs';

test('consumer requested limits are lower-only', () => {
	const policy = validatePolicy(readCommittedPolicy());
	const lower = validateOperationRequest(baseRequest({ requestedLimits: { maxPhysicalAttempts: 1 } }));
	assert.equal(effectiveProfile(policy, lower).limits.maxPhysicalAttempts, 1);
	const higher = validateOperationRequest(baseRequest({ requestedLimits: { maxPhysicalAttempts: 5 } }));
	assert.throws(
		() => effectiveProfile(policy, higher),
		(error) => error.code === 'ERR_LIMIT_ESCALATION_FORBIDDEN',
	);
	const retries = validateOperationRequest(
		baseRequest({ requestedLimits: { maxRetriesPerRoute: 1 } }),
	);
	assert.equal(effectiveProfile(policy, retries).limits.maxRetriesPerRoute, 1);
	const zeroLimits = validateOperationRequest(
		baseRequest({
			requestedLimits: {
				maxRetriesPerRoute: 0,
				maxFailovers: 0,
				maxCostMicrousd: 0,
				maxPremiumRequestUnits: 0,
			},
		}),
	);
	assert.equal(effectiveProfile(policy, zeroLimits).limits.maxRetriesPerRoute, 0);
	assert.equal(effectiveProfile(policy, zeroLimits).limits.maxFailovers, 0);
	assert.equal(effectiveProfile(policy, zeroLimits).limits.runMaxCostMicrousd, 0);
	assert.equal(effectiveProfile(policy, zeroLimits).limits.runMaxPremiumRequestUnits, 0);
});

test('validates IDs, nulls, empty strings and closed attribution', () => {
	for (const invalid of [
		baseRequest({ runId: '../escape' }),
		baseRequest({ operationId: 'a/b' }),
		baseRequest({ prompt: '' }),
		baseRequest({ attribution: null }),
		baseRequest({ attribution: { secret: 'no' } }),
	]) {
		assert.throws(() => validateOperationRequest(invalid));
	}
});

test('normalizes prompt and hashes deterministic canonical input without credentials', () => {
	const left = baseRequest({ prompt: 'cafe\u0301\r\n', attribution: { nodeId: 'n', taskId: 't' } });
	const right = structuredClone(left);
	right.prompt = 'café\n';
	right.attribution = { taskId: 't', nodeId: 'n' };
	assert.equal(operationInputHash(left), operationInputHash(right));
	assert.equal(normalizedOperationInput(left).prompt, 'café\n');
	assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
	assert.doesNotMatch(canonicalJson(normalizedOperationInput(left)), /API_KEY|credential/i);
});

test('validates and normalizes routing strategy and minQualityTier', () => {
	// Valid requests with strategy and minQualityTier
	const req1 = validateOperationRequest(
		baseRequest({
			routingConstraints: {
				strategy: 'min-cost',
				minQualityTier: 2,
				requiredCapabilities: ['structured-output'],
			},
		}),
	);
	assert.equal(req1.routingConstraints.strategy, 'min-cost');
	assert.equal(req1.routingConstraints.minQualityTier, 2);

	const normalized = normalizedOperationInput(req1);
	assert.equal(normalized.routingConstraints.strategy, 'min-cost');
	assert.equal(normalized.routingConstraints.minQualityTier, 2);
	assert.equal(
		validateOperationRequest(
			baseRequest({ routingConstraints: { minQualityTier: 3 } }),
		).routingConstraints.minQualityTier,
		3,
	);

	// Invalid strategy
	assert.throws(
		() =>
			validateOperationRequest(
				baseRequest({ routingConstraints: { strategy: 'super-cheap' } }),
			),
		/routingConstraints\.strategy must be min-cost, balanced, or quality-first/,
	);

	// Invalid minQualityTier
	assert.throws(
		() =>
			validateOperationRequest(
				baseRequest({ routingConstraints: { minQualityTier: 4 } }),
			),
		/routingConstraints\.minQualityTier must be 1, 2, or 3/,
	);
});

test('canonicalJson renders undefined as null and the same request hashes to the same bytes', () => {
	assert.equal(canonicalJson(undefined), 'null');
	const request = baseRequest();
	assert.equal(operationInputHash(request), operationInputHash(structuredClone(request)));
	assert.throws(() => validateOperationRequest({ ...request, prompt: '' }), /non-empty string/);
	assert.throws(
		() => validateOperationRequest({ ...request, promptBlocks: ['', 'tail'] }),
		/non-empty string/,
	);
});
