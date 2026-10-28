import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import {
	effectiveProfile as resolveEffectiveProfile,
	resolvePolicy,
	validateOperationRequest,
	validatePolicy,
} from '../policy/policy.ts';
import { selectRoutes } from './routing.ts';
import {
	validateAdapterRequest,
	validateAdapterResult,
	validateProviderRequestId,
} from '../adapters/adapter-contract.ts';
import { FakeModelAdapter } from '../adapters/fake.ts';
import { baseRequest, readCommittedPolicy } from '../testing/test-support.mjs';

function effectiveProfile(policy, request) {
	const profile = resolveEffectiveProfile(policy, request);
	return {
		...profile,
		routeIds: policy.routes
			.filter((route) => route.classification !== 'external-best-effort')
			.map((route) => route.id),
	};
}

test('routing applies capability, vendor, disabled and deterministic preferred ordering', () => {
	const raw = readCommittedPolicy();
	raw.routes[0].enabled = true; // fake-governed
	const policy = validatePolicy(raw);
	const profile = effectiveProfile(policy, validateOperationRequest(baseRequest()));
	assert.deepEqual(
		selectRoutes(policy, profile, {
			requiredCapabilities: ['structured-output'],
			preferredRouteIds: ['google-gemini-conservative'],
		}).routes.map((route) => route.id),
		[
			'google-gemini-conservative',
			'fake-governed',
			'openai-compatible-conservative',
			'xai-grok-conservative',
			'openai-compatible-quality',
			'xai-grok-quality',
			'anthropic-claude-quality',
			'google-gemini-quality',
		],
	);
	assert.deepEqual(
		selectRoutes(policy, profile, { excludedVendors: ['google'] }).routes.map(
			(route) => route.id,
		),
		[
			'fake-governed',
			'openai-compatible-conservative',
			'xai-grok-conservative',
			'openai-compatible-quality',
			'xai-grok-quality',
			'anthropic-claude-quality',
		],
	);
});

test('routing fails typed when all routes are disabled or exhausted', () => {
	const raw = readCommittedPolicy();
	for (const route of raw.routes) route.enabled = false;
	const policy = validatePolicy(raw);
	const profile = effectiveProfile(policy, validateOperationRequest(baseRequest()));
	assert.throws(
		() => selectRoutes(policy, profile),
		(error) => error instanceof ModelUsageError && error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
	);
	const live = validatePolicy(readCommittedPolicy());
	const liveProfile = effectiveProfile(live, validateOperationRequest(baseRequest()));
	assert.throws(
		() =>
			selectRoutes(live, liveProfile, {}, [
				'google-gemini-conservative',
				'openai-compatible-conservative',
				'xai-grok-conservative',
				'openai-compatible-quality',
				'google-gemini-quality',
				'xai-grok-quality',
				'anthropic-claude-quality',
			]),
		(error) => error instanceof ModelUsageError && error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
	);
});

test('AC-01: Policy route order defaults to lowest-cost capable workhorse', () => {
	const policy = validatePolicy(readCommittedPolicy());
	const enabledRoutes = policy.routes.filter((r) => r.enabled && r.metered).map((r) => r.id);
	assert.deepEqual(enabledRoutes, [
		'openai-compatible-conservative',
		'xai-grok-conservative',
		'google-gemini-conservative',
		'openai-compatible-quality',
		'xai-grok-quality',
		'anthropic-claude-quality',
		'google-gemini-quality',
	]);
});

test('AC-02: Heterogeneous vendor exclusion retains absolute priority over cost sorting', () => {
	const policy = validatePolicy(readCommittedPolicy());
	const profile = effectiveProfile(
		policy,
		validateOperationRequest(
			baseRequest({
				requestedLimits: { maxCompletionTokens: 1000 },
			}),
		),
	);
	const decision = selectRoutes(
		policy,
		profile,
		{
			excludedVendors: ['openai'],
			strategy: 'min-cost',
		},
		[],
		{ estPromptTokens: 4000 },
	);
	assert.equal(decision.routes[0].id, 'google-gemini-conservative');
	assert.equal(
		decision.routes.some((r) => r.canonicalVendor === 'openai'),
		false,
	);
});

test('heterogeneous vendor exclusion dynamically selects Anthropic when other authors are excluded', () => {
	const policy = validatePolicy(readCommittedPolicy());
	const profile = effectiveProfile(policy, validateOperationRequest(baseRequest()));
	const decision = selectRoutes(policy, profile, {
		excludedVendors: ['openai', 'google', 'xai'],
		strategy: 'balanced',
		minQualityTier: 3,
	});
	assert.deepEqual(decision.routes.map((route) => route.id), ['anthropic-claude-quality']);
});

test('AC-03: Preferred routes take priority under healthy runway', () => {
	const policy = validatePolicy(readCommittedPolicy());
	const profile = effectiveProfile(policy, validateOperationRequest(baseRequest()));
	const decision = selectRoutes(
		policy,
		profile,
		{
			preferredRouteIds: ['xai-grok-conservative'],
			strategy: 'min-cost',
		},
		[],
		{
			// Healthy-runway threshold is relative to the committed
			// agent-sdlc-default profile's runMaxCostMicrousd ceiling (50,000,000);
			// this keeps the runwayRatio well above the 0.3 pressure threshold.
			remainingRunCostMicrousd: 40000000, // runwayRatio = 0.80
		},
	);
	assert.equal(decision.routes[0].id, 'xai-grok-conservative');
	assert.equal(decision.pressureActive, false);
	assert.equal(decision.effectiveStrategy, 'min-cost');
});

test('selectRoutes honors swapped priority order from local policy under balanced strategy', () => {
	const policy = resolvePolicy(readCommittedPolicy(), {
		profiles: {
			'agent-sdlc-default': {
				routeIds: [
					'fake-governed',
					'xai-grok-quality',
					'openai-compatible-quality',
					'anthropic-claude-quality',
					'google-gemini-quality',
				],
			},
		},
	});
	const profile = resolveEffectiveProfile(policy, validateOperationRequest(baseRequest()));
	const decision = selectRoutes(policy, profile);
	assert.deepEqual(
		decision.routes.map((route) => route.id),
		[
			'xai-grok-quality',
			'openai-compatible-quality',
			'anthropic-claude-quality',
			'google-gemini-quality',
		],
	);
});

test('AC-04: Min-cost strategy sorts candidate routes by estimated reservation price', () => {
	const policy = validatePolicy(readCommittedPolicy());
	const profile = effectiveProfile(
		policy,
		validateOperationRequest(
			baseRequest({
				requestedLimits: { maxCompletionTokens: 1000 },
			}),
		),
	);
	const decision = selectRoutes(
		policy,
		profile,
		{ strategy: 'min-cost' },
		[],
		{ estPromptTokens: 4000, remainingRunCostMicrousd: 25000000 },
	);
	// OpenAI ($0.15/$0.60) before Google ($0.75/$3.75) before xAI ($1.25/$2.50)
	assert.equal(decision.routes[0].id, 'openai-compatible-conservative');
	assert.equal(decision.routes[1].id, 'google-gemini-conservative');
	assert.equal(decision.routes[2].id, 'xai-grok-conservative');
	assert.equal(decision.pressureActive, false);
});

test('AC-05: Quality-first strategy sorts candidate routes by descending qualityTier with price tie-breaker', () => {
	const policy = validatePolicy(readCommittedPolicy());
	const profile = effectiveProfile(
		policy,
		validateOperationRequest(
			baseRequest({
				requestedLimits: { maxCompletionTokens: 1000 },
			}),
		),
	);
	const decision = selectRoutes(
		policy,
		profile,
		{ strategy: 'quality-first' },
		[],
		{ estPromptTokens: 4000, remainingRunCostMicrousd: 25000000 },
	);
	// Tier 3 (quality routes) before Tier 2 (conservative routes) before Tier 1;
	// within a tier, cheapest estimated cost first, then policy order as tie-breaker.
	// xAI quality is $2.00/$6.00. OpenAI and Anthropic tie at $2.00/$10.00 and retain policy order.
	// Gemini 3.1 Pro Preview is $2.00/$12.00.
	assert.equal(decision.routes[0].id, 'xai-grok-quality');
	assert.equal(decision.routes[1].id, 'openai-compatible-quality');
	assert.equal(decision.routes[2].id, 'anthropic-claude-quality');
	assert.equal(decision.routes[3].id, 'google-gemini-quality');
	assert.equal(decision.routes[4].id, 'google-gemini-conservative');
	assert.equal(decision.routes[5].id, 'xai-grok-conservative');
	assert.equal(decision.routes[6].id, 'openai-compatible-conservative');
	assert.equal(decision.effectiveStrategy, 'quality-first');
});

test('AC-07: Pre-flight budget pruning filters unaffordable routes before dispatch', () => {
	const policy = validatePolicy(readCommittedPolicy());
	const profile = effectiveProfile(
		policy,
		validateOperationRequest(
			baseRequest({
				requestedLimits: { maxCompletionTokens: 1000 },
			}),
		),
	);
	// 4000 prompt tokens + 1000 completion tokens:
	// OpenAI cost: 4000*0.15 + 1000*0.60 = 600 + 600 = 1200 microusd
	// Google cost: 4000*0.75 + 1000*3.75 = 3000 + 3750 = 6750 microusd
	// xAI cost: 4000*1.25 + 1000*2.50 = 5000 + 2500 = 7500 microusd
	// With remainingRunCostMicrousd = 2000, only OpenAI is affordable
	const decision = selectRoutes(
		policy,
		profile,
		{ strategy: 'balanced' },
		[],
		{ estPromptTokens: 4000, remainingRunCostMicrousd: 2000 },
	);
	assert.equal(decision.routes.length, 1);
	assert.equal(decision.routes[0].id, 'openai-compatible-conservative');
});

test('AC-08: Runway pressure demotes preferred routes in favor of minimum cost', () => {
	const policy = validatePolicy(readCommittedPolicy());
	const profile = effectiveProfile(policy, validateOperationRequest(baseRequest()));
	const decision = selectRoutes(
		policy,
		profile,
		{
			preferredRouteIds: ['xai-grok-conservative'],
			strategy: 'balanced',
		},
		[],
		{
			remainingRunCostMicrousd: 1000000, // runwayRatio = 0.04 <= 0.30 -> pressure active
		},
	);
	// Pressure active overrides preference: OpenAI ahead of xAI
	assert.equal(decision.pressureActive, true);
	assert.equal(decision.effectiveStrategy, 'min-cost');
	assert.equal(decision.routes[0].id, 'openai-compatible-conservative');
	assert.ok(
		decision.routes.findIndex((r) => r.id === 'openai-compatible-conservative') <
			decision.routes.findIndex((r) => r.id === 'xai-grok-conservative'),
	);
});

test('AC-19: Runway pressure active triggers when remaining cost < 3 * C_min or when all routes unaffordable', () => {
	const policy = validatePolicy(readCommittedPolicy());
	const profile = effectiveProfile(
		policy,
		validateOperationRequest(baseRequest({ requestedLimits: { maxCompletionTokens: 1000 } })),
	);
	// OpenAI cost is 1200 microusd for prompt 4000, completion 1000.
	// 3 * 1200 = 3600 microusd. If remainingRunCostMicrousd = 3000 (< 3600):
	const decision1 = selectRoutes(
		policy,
		profile,
		{},
		[],
		{ estPromptTokens: 4000, remainingRunCostMicrousd: 3000 },
	);
	assert.equal(decision1.pressureActive, true);
	assert.equal(decision1.effectiveStrategy, 'min-cost');

	// If remainingRunCostMicrousd = 100 (< 1200, so NO affordable route):
	// Retains candidate routes and marks pressureActive = true
	const decision2 = selectRoutes(
		policy,
		profile,
		{},
		[],
		{ estPromptTokens: 4000, remainingRunCostMicrousd: 100 },
	);
	assert.equal(decision2.pressureActive, true);
	assert.equal(decision2.effectiveStrategy, 'min-cost');
	assert.ok(decision2.routes.length > 0);
	assert.equal(decision2.routes[0].id, 'openai-compatible-conservative');
});

test('AC-20: Route token ceiling filtering in Step 1 excludes incapable routes', () => {
	const raw = readCommittedPolicy();
	// Artificially lower completion ceiling of OpenAI route
	raw.routes.find((r) => r.id === 'openai-compatible-conservative').limits.maxCompletionTokens = 500;
	const policy = validatePolicy(raw);
	const profile = effectiveProfile(
		policy,
		validateOperationRequest(baseRequest({ requestedLimits: { maxCompletionTokens: 1000 } })),
	);
	const decision = selectRoutes(policy, profile, { strategy: 'min-cost' }, [], {
		estPromptTokens: 4000,
	});
	// OpenAI route must be excluded because maxCompletionTokens (500) < profile limit (1000)
	assert.equal(
		decision.routes.some((r) => r.id === 'openai-compatible-conservative'),
		false,
	);
	assert.equal(decision.routes[0].id, 'google-gemini-conservative');
});

test('AC-23: Safe backward-compatible defaults when budgetContext is omitted and non-circular return', () => {
	const policy = validatePolicy(readCommittedPolicy());
	const profile = effectiveProfile(policy, validateOperationRequest(baseRequest()));

	// Omitted budgetContext
	const decision = selectRoutes(policy, profile);
	assert.equal(decision.pressureActive, false);
	assert.equal(decision.effectiveStrategy, 'balanced');
	assert.ok(decision.routes.length >= 3);

	// Safe JSON.stringify (no circular references)
	const serialized = JSON.stringify(decision);
	assert.ok(typeof serialized === 'string');
	const parsed = JSON.parse(serialized);
	assert.equal(parsed.effectiveStrategy, 'balanced');
	assert.equal(parsed.pressureActive, false);
	assert.equal(parsed.routes.length, decision.routes.length);
});

test('adapter contract rejects null, empty, unsafe request IDs and unknown fields', () => {
	assert.throws(() => validateAdapterRequest(null));
	assert.throws(() => validateProviderRequestId('../ secret'));
	assert.throws(() => validateAdapterResult({ status: 'succeeded', output: {}, rawBody: 'no' }));
	assert.throws(() =>
		validateAdapterResult({
			status: 'failed',
			outcome: 'transport',
			usage: { promptTokens: -1, completionTokens: 0, source: 'provider' },
		}),
	);
	assert.throws(
		() =>
			validateAdapterResult({
				status: 'failed',
				outcome: 'transport',
				executionProvenFalse: true,
				usage: {
					promptTokens: 1,
					completionTokens: 1,
					source: 'provider',
				},
			}),
		/cannot accompany provider usage/,
	);
});

test('fake adapter scripts success, failure, exception, delay and records call count', async () => {
	const fake = new FakeModelAdapter('fake', [
		{ status: 'succeeded', output: { ok: true } },
		{ status: 'failed', outcome: 'quota', executionProvenFalse: true },
		{ throw: new Error('transport') },
	]);
	const request = {
		operationId: 'op',
		attemptId: 'attempt',
		prompt: '',
		structuredOutputSchema: {},
		maxCompletionTokens: 1,
		signal: new AbortController().signal,
	};
	assert.equal((await fake.execute(request)).status, 'succeeded');
	assert.equal((await fake.execute(request)).outcome, 'quota');
	await assert.rejects(fake.execute(request), /transport/);
	assert.equal(fake.callCount, 3);
});
