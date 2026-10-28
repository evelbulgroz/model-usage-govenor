import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizedOperationInput, validateOperationRequest, validatePolicy } from './policy.ts';
import { ROUTE_LIMIT_KEYS, validateLimits, validatePricing, validateRouteReasoning } from './policy-route-catalog.ts';
import { baseRequest, readCommittedPolicy } from '../testing/test-support.mjs';

test('anthropic cache rates must be set together and prompt blocks must join to the prompt', () => {
	const missingRead = readCommittedPolicy();
	const anthropic = missingRead.routes.find((route) => route.id === 'anthropic-claude-quality');
	delete anthropic.pricing.cacheReadMicrousdPerMillionTokens;
	assert.throws(() => validatePolicy(missingRead), /cache write rate requires a cache read rate/);
	const readOnly = readCommittedPolicy();
	const flash = readOnly.routes.find((route) => route.id === 'google-gemini-conservative');
	delete flash.pricing.cacheWrite5mMicrousdPerMillionTokens;
	assert.equal(validatePolicy(readOnly).schemaVersion, '1.0.0');

	const prompt = 'task\ntool result';
	const blocks = ['task', 'tool result'];
	const normalized = normalizedOperationInput(baseRequest({ prompt, promptBlocks: blocks }));
	assert.deepEqual(normalized.promptBlocks, blocks);
	assert.throws(
		() => validateOperationRequest(baseRequest({ prompt, promptBlocks: ['only'] })),
		/at least two strings/,
	);
	assert.throws(
		() => validateOperationRequest(baseRequest({ prompt, promptBlocks: ['task', ''] })),
		/non-empty string/,
	);
	assert.throws(
		() => normalizedOperationInput(baseRequest({ prompt, promptBlocks: ['task', 'other'] })),
		/must join to prompt/,
	);
	const marked = normalizedOperationInput(
		baseRequest({ prompt, promptBlocks: blocks, promptCacheBreakpoint: 0 }),
	);
	assert.equal(marked.promptCacheBreakpoint, 0);
	assert.throws(
		() => validateOperationRequest(baseRequest({ prompt, promptBlocks: blocks, promptCacheBreakpoint: 1 })),
		/trailing block/,
	);
	assert.throws(
		() => validateOperationRequest(baseRequest({ prompt, promptCacheBreakpoint: 0 })),
		/requires promptBlocks/,
	);
});

test('provider/vendor mappings are closed and unpriced non-metered routes remain explicit', () => {
	const invalid = readCommittedPolicy();
	invalid.routes[0].canonicalVendor = 'other';
	assert.throws(() => validatePolicy(invalid), /mapping is invalid/);

	const nonMetered = readCommittedPolicy();
	const route = nonMetered.routes[0];
	route.enabled = true;
	route.metered = false;
	route.pricing = { status: 'unknown' };
	assert.equal(validatePolicy(nonMetered).routes[0].pricing.status, 'unknown');
});

test('validates route qualityTier and pricing citations for enabled metered routes', () => {
	const policy = readCommittedPolicy();
	// Valid quality tiers
	assert.equal(policy.routes.find((r) => r.id === 'openai-compatible-conservative').qualityTier, 1);
	assert.equal(policy.routes.find((r) => r.id === 'google-gemini-conservative').qualityTier, 2);

	// Rejects missing or non-integer or < 1 qualityTier
	const invalidTier = readCommittedPolicy();
	invalidTier.routes[0].qualityTier = 0;
	assert.throws(() => validatePolicy(invalidTier), /qualityTier must be >= 1/);

	const missingTier = readCommittedPolicy();
	delete missingTier.routes[0].qualityTier;
	assert.throws(() => validatePolicy(missingTier), /qualityTier is required/);

	// Rejects missing effectiveDate or citationUrl on enabled metered route
	const missingDate = readCommittedPolicy();
	const enabledMetered = missingDate.routes.find((r) => r.enabled && r.metered);
	delete enabledMetered.pricing.effectiveDate;
	assert.throws(() => validatePolicy(missingDate), /requires effectiveDate/);

	const missingCitation = readCommittedPolicy();
	const metered2 = missingCitation.routes.find((r) => r.enabled && r.metered);
	delete metered2.pricing.citationUrl;
	assert.throws(() => validatePolicy(missingCitation), /requires citationUrl/);

	// Rejects pricingVersion mismatch with max effectiveDate
	const mismatchVersion = readCommittedPolicy();
	mismatchVersion.pricingVersion = '2025-01-01';
	assert.throws(() => validatePolicy(mismatchVersion), /must equal maximum route pricing effectiveDate/);
});

test('validatePricing rejects an unknown status, a bare rate, and an empty citation', () => {
	assert.throws(() => validatePricing({ status: 'other' }, 'pricing'), /status is invalid/);
	assert.throws(
		() => validatePricing({ status: 'unknown', inputMicrousdPerMillionTokens: 1 }, 'pricing'),
		/must not contain rates/,
	);
	assert.throws(
		() =>
			validatePricing(
				{
					status: 'known',
					inputMicrousdPerMillionTokens: 1,
					outputMicrousdPerMillionTokens: 1,
					fixedRequestMicrousd: 0,
					citationUrl: '',
				},
				'pricing',
			),
		/https URL/,
	);
});

test('validateRouteReasoning accepts a route without reasoning and rejects an unsupported effort', () => {
	assert.equal(validateRouteReasoning({ id: 'route', provider: 'fake', capabilities: [] }, 'policy'), undefined);
	assert.throws(
		() =>
			validateRouteReasoning(
				{ id: 'route', provider: 'fake', capabilities: ['reasoning'], reasoning: { effort: 'low' } },
				'policy',
			),
		/does not accept reasoning/,
	);
	assert.throws(
		() =>
			validateRouteReasoning(
				{ id: 'route', provider: 'google', capabilities: ['reasoning'], reasoning: { effort: 'max' } },
				'policy',
			),
		/google reasoning effort is not allowed/,
	);
	assert.throws(
		() => validateLimits({ maxPromptTokens: 1, extra: 1 }, ROUTE_LIMIT_KEYS, 'limits'),
		/unknown key 'extra'/,
	);
});
