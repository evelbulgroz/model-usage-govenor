import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelUsageError } from './errors.ts';
import { validatePolicy } from './policy.ts';
import { ensureLower, resolvePolicy } from './policy-local-merge.ts';
import { readCommittedPolicy } from '../testing/test-support.mjs';

test('local policy may lower limits, remove routes, capabilities and retry outcomes', () => {
	const committed = readCommittedPolicy();
	const resolved = resolvePolicy(committed, {
		instance: { maxTotalTokens: 1000 },
		retryableOutcomes: ['transport'],
		providerBoundary: {
			registeredConsumerRoots: [],
			allowedSetupFiles: [],
		},
		profiles: {
			'agent-sdlc-default': {
				routeIds: ['fake-governed'],
				limits: { maxPhysicalAttempts: 1 },
			},
		},
		routes: [
			{
				id: 'fake-governed',
				enabled: false,
				capabilities: ['structured-output'],
				limits: {
					maxPromptTokens: 700,
					maxCompletionTokens: 300,
					maxTotalTokens: 1000,
				},
			},
		],
	});
	assert.equal(resolved.instance.maxTotalTokens, 1000);
	assert.equal(resolved.routes[0].enabled, false);
	assert.deepEqual(resolved.retryableOutcomes, ['transport']);
	assert.deepEqual(resolved.providerBoundary.registeredConsumerRoots, []);
	assert.deepEqual(resolved.providerBoundary.allowedAdapterRoots, [
		'packages/model-usage/adapters',
	]);
});

test('local policy rejects all permission and ceiling escalation categories', () => {
	const cases = [
		{ instance: { maxTotalTokens: 80000001 } },
		{ retryableOutcomes: ['transport', 'quota'] },
		{ providerBoundary: { registeredConsumerRoots: ['tools/new-consumer'] } },
		{ providerBoundary: { allowedAdapterRoots: ['tools'] } },
		{ providerBoundary: { allowedSetupFiles: ['tools/setup-provider.mjs'] } },
		{ profiles: { 'new-profile': {} } },
		{ profiles: { 'agent-sdlc-default': { routeIds: ['copilot-external'] } } },
		{ profiles: { 'agent-sdlc-default': { limits: { maxFailovers: 3 } } } },
		{ profiles: { 'agent-sdlc-default': { limits: { maxRetriesPerRoute: 3 } } } },
		{ routes: [{ id: 'fake-governed', enabled: true }] },
		{ routes: [{ id: 'fake-governed', capabilities: ['structured-output', 'usage', 'new'] }] },
		{ routes: [{ id: 'fake-governed', metered: true }] },
		{ routes: [{ id: 'google-gemini-conservative', premiumRequestUnits: 0 }] },
	];
	for (const override of cases) {
		assert.throws(
			() => resolvePolicy(readCommittedPolicy(), override),
			(error) => error instanceof ModelUsageError && error.code === 'ERR_LIMIT_ESCALATION_FORBIDDEN',
		);
	}
});

test('local policy rejects qualityTier escalation and pricing mutation', () => {
	const committed = readCommittedPolicy();

	// Escalating qualityTier (e.g. from 1 to 2) throws ERR_LIMIT_ESCALATION_FORBIDDEN
	assert.throws(
		() =>
			resolvePolicy(committed, {
				routes: [{ id: 'openai-compatible-conservative', qualityTier: 2 }],
			}),
		(err) => err instanceof ModelUsageError && err.code === 'ERR_LIMIT_ESCALATION_FORBIDDEN',
	);

	// Lowering qualityTier (e.g. from 2 to 1) is allowed
	const lowered = resolvePolicy(committed, {
		routes: [{ id: 'google-gemini-conservative', qualityTier: 1 }],
	});
	assert.equal(
		lowered.routes.find((r) => r.id === 'google-gemini-conservative').qualityTier,
		1,
	);

	// Mutating pricing throws ERR_LIMIT_ESCALATION_FORBIDDEN
	assert.throws(
		() =>
			resolvePolicy(committed, {
				routes: [
					{
						id: 'openai-compatible-conservative',
						pricing: { inputMicrousdPerMillionTokens: 10 },
					},
				],
			}),
		(err) => err instanceof ModelUsageError && err.code === 'ERR_LIMIT_ESCALATION_FORBIDDEN',
	);

	// Mutating pricingVersion throws ERR_LIMIT_ESCALATION_FORBIDDEN
	assert.throws(
		() =>
			resolvePolicy(committed, {
				pricingVersion: '2099-01-01',
			}),
		(err) => err instanceof ModelUsageError && err.code === 'ERR_LIMIT_ESCALATION_FORBIDDEN',
	);
});

test('ensureLower accepts an equal ceiling and rejects one above it', () => {
	assert.equal(ensureLower(3, 3, 'limit'), 3);
	assert.throws(
		() => ensureLower(4, 3, 'limit'),
		(error) => error instanceof ModelUsageError && error.code === 'ERR_LIMIT_ESCALATION_FORBIDDEN',
	);
});

test('resolvePolicy leaves the committed policy unchanged when local input is omitted', () => {
	const committed = readCommittedPolicy();
	assert.deepEqual(resolvePolicy(committed, undefined), validatePolicy(committed));
});
