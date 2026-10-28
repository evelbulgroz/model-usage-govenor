import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelUsageError } from './errors.ts';
import { resolvePolicy } from './policy.ts';
import { validatePolicy } from './policy-validation.ts';
import { readCommittedPolicy } from '../testing/test-support.mjs';

test('validates the committed closed policy and rejects unknown keys', () => {
	const policy = readCommittedPolicy();
	const validated = validatePolicy(policy);
	assert.equal(validated.schemaVersion, '1.0.0');
	assert.equal(validated.pricingVersion, '2026-10-16');
	const google = validated.routes.find((route) => route.id === 'google-gemini-conservative');
	assert.equal(google.model, 'gemini-3.6-flash');
	assert.equal(google.enabled, true);
	assert.equal(google.pricing.inputMicrousdPerMillionTokens, 750000);
	assert.equal(google.pricing.outputMicrousdPerMillionTokens, 3750000);
	assert.equal(google.pricing.cacheReadMicrousdPerMillionTokens, 75000);
	assert.equal(google.pricing.cacheWrite5mMicrousdPerMillionTokens, undefined);
	assert.equal(google.pricing.effectiveDate, '2026-10-16');
	const geminiQuality = validated.routes.find((route) => route.id === 'google-gemini-quality');
	assert.equal(geminiQuality.model, 'gemini-3.1-pro-preview');
	assert.equal(geminiQuality.pricing.inputMicrousdPerMillionTokens, 2000000);
	assert.equal(geminiQuality.pricing.outputMicrousdPerMillionTokens, 12000000);
	assert.equal(geminiQuality.pricing.cacheReadMicrousdPerMillionTokens, 200000);
	assert.equal(geminiQuality.pricing.cacheWrite5mMicrousdPerMillionTokens, undefined);
	assert.equal(geminiQuality.pricing.effectiveDate, '2026-10-16');
	assert.equal(geminiQuality.limits.maxPromptTokens, 968000);
	assert.equal(geminiQuality.limits.maxCompletionTokens, 16000);
	assert.equal(geminiQuality.limits.maxTotalTokens, 984000);
	assert.equal(geminiQuality.limits.maxPhysicalCalls, 750);
	assert.equal(geminiQuality.limits.maxPremiumRequestUnits, 750);
	const openai = validated.routes.find((route) => route.id === 'openai-compatible-conservative');
	assert.equal(openai.model, 'gpt-4o-mini');
	assert.equal(openai.enabled, true);
	assert.equal(openai.pricing.inputMicrousdPerMillionTokens, 150000);
	assert.equal(openai.pricing.outputMicrousdPerMillionTokens, 600000);
	const openaiQuality = validated.routes.find((route) => route.id === 'openai-compatible-quality');
	assert.equal(openaiQuality.model, 'gpt-6.1-sol');
	assert.equal(openaiQuality.enabled, true);
	assert.equal(openaiQuality.reasoning.effort, 'low');
	assert.equal(openaiQuality.pricing.inputMicrousdPerMillionTokens, 2000000);
	assert.equal(openaiQuality.pricing.outputMicrousdPerMillionTokens, 10000000);
	assert.equal(openaiQuality.pricing.cacheReadMicrousdPerMillionTokens, 100000);
	assert.equal(openaiQuality.pricing.cacheWrite5mMicrousdPerMillionTokens, 2500000);
	assert.equal(openaiQuality.pricing.effectiveDate, '2026-10-16');
	assert.equal(openaiQuality.limits.maxPromptTokens, 922000);
	assert.equal(openaiQuality.limits.maxCompletionTokens, 16000);
	assert.equal(openaiQuality.limits.maxTotalTokens, 938000);
	const xai = validated.routes.find((route) => route.id === 'xai-grok-conservative');
	assert.equal(xai.model, 'grok-4.20-0309-non-reasoning');
	assert.equal(xai.enabled, true);
	assert.equal(xai.canonicalVendor, 'xai');
	assert.equal(xai.pricing.inputMicrousdPerMillionTokens, 1250000);
	assert.equal(xai.pricing.outputMicrousdPerMillionTokens, 2500000);
	assert.equal(xai.pricing.cacheReadMicrousdPerMillionTokens, 200000);
	assert.equal(xai.pricing.effectiveDate, '2026-10-16');
	assert.equal(xai.pricing.citationUrl, 'https://docs.x.ai/developers/pricing');
	const xaiQuality = validated.routes.find((route) => route.id === 'xai-grok-quality');
	assert.equal(xaiQuality.model, 'grok-4.7');
	assert.equal(xaiQuality.reasoning.effort, 'low');
	assert.equal(xaiQuality.pricing.inputMicrousdPerMillionTokens, 2000000);
	assert.equal(xaiQuality.pricing.outputMicrousdPerMillionTokens, 6000000);
	assert.equal(xaiQuality.pricing.cacheReadMicrousdPerMillionTokens, 500000);
	assert.equal(xaiQuality.pricing.cacheWrite5mMicrousdPerMillionTokens, undefined);
	assert.equal(xaiQuality.pricing.effectiveDate, '2026-10-16');
	assert.equal(xaiQuality.pricing.citationUrl, 'https://docs.x.ai/developers/pricing');
	assert.equal(xaiQuality.limits.maxPromptTokens, 484000);
	assert.equal(xaiQuality.limits.maxCompletionTokens, 16000);
	assert.equal(xaiQuality.limits.maxTotalTokens, 500000);
	assert.equal(xaiQuality.limits.maxCostMicrousd, 50000000);
	const anthropic = validated.routes.find((route) => route.id === 'anthropic-claude-quality');
	assert.equal(anthropic.model, 'claude-sonnet-5-5');
	assert.equal(anthropic.enabled, true);
	assert.equal(anthropic.canonicalVendor, 'anthropic');
	assert.equal(anthropic.pricing.inputMicrousdPerMillionTokens, 2000000);
	assert.equal(anthropic.pricing.outputMicrousdPerMillionTokens, 10000000);
	assert.equal(anthropic.pricing.cacheReadMicrousdPerMillionTokens, 100000);
	assert.equal(anthropic.pricing.cacheWrite5mMicrousdPerMillionTokens, 2500000);
	assert.equal(anthropic.pricing.effectiveDate, '2026-10-16');
	assert.equal(anthropic.limits.maxPromptTokens, 968000);
	assert.equal(anthropic.limits.maxTotalTokens, 984000);
	assert.deepEqual(validated.profiles['agent-sdlc-default'].limits, {
		maxPromptTokens: 968000,
		maxCompletionTokens: 16000,
		maxTotalTokens: 3936000,
		maxPhysicalAttempts: 4,
		maxRetriesPerRoute: 2,
		maxFailovers: 2,
		maxConcurrentOperations: 1,
		operationTimeoutMs: 180000,
		runTimeoutMs: 28800000,
		runMaxTotalTokens: 80000000,
		runMaxPhysicalCalls: 1250,
		runMaxCostMicrousd: 50000000,
		runMaxPremiumRequestUnits: 1250,
	});
	assert.equal(validated.profiles['critic-review'].limits.maxCompletionTokens, 16000);
	assert.equal(validated.profiles['critic-review'].limits.maxTotalTokens, 108000);
	assert.equal(validated.profiles['critic-review'].limits.runTimeoutMs, 7200000);
	assert.equal(validated.profiles['trace-attribution'].limits.runTimeoutMs, 7200000);
	const qualityRouteIds = [
		'fake-governed',
		'openai-compatible-quality',
		'xai-grok-quality',
		'anthropic-claude-quality',
		'google-gemini-quality',
	];
	assert.deepEqual(validated.profiles['agent-sdlc-default'].routeIds, qualityRouteIds);
	assert.deepEqual(validated.profiles['critic-review'].routeIds, qualityRouteIds);
	assert.deepEqual(validated.profiles['trace-attribution'].routeIds, qualityRouteIds);
	assert.deepEqual(validated.retryableOutcomes, [
		'timeout',
		'transport',
		'http_5xx',
		'malformed_output',
	]);

	policy.unexpected = true;
	assert.throws(() => validatePolicy(policy), /unknown key/);
});

test('requires every committed policy field while local overrides remain partial', () => {
	const cases = [];
	const root = readCommittedPolicy();
	for (const key of Object.keys(root)) cases.push([`policy.${key}`, (policy) => delete policy[key]]);
	for (const key of Object.keys(root.instance)) {
		cases.push([`policy.instance.${key}`, (policy) => delete policy.instance[key]]);
	}
	for (const key of Object.keys(root.providerBoundary)) {
		cases.push([
			`policy.providerBoundary.${key}`,
			(policy) => delete policy.providerBoundary[key],
		]);
	}
	const profile = root.profiles['agent-sdlc-default'];
	for (const key of Object.keys(profile)) {
		cases.push([
			`policy.profiles.agent-sdlc-default.${key}`,
			(policy) => delete policy.profiles['agent-sdlc-default'][key],
		]);
	}
	for (const key of Object.keys(profile.limits)) {
		cases.push([
			`policy.profiles.agent-sdlc-default.limits.${key}`,
			(policy) => delete policy.profiles['agent-sdlc-default'].limits[key],
		]);
	}
	const route = root.routes.find((candidate) => candidate.pricing.status === 'known');
	for (const key of Object.keys(route)) {
		cases.push([
			`policy.routes[0].${key}`,
			(policy) => delete policy.routes[0][key],
		]);
	}
	for (const key of Object.keys(route.limits)) {
		cases.push([
			`policy.routes[0].limits.${key}`,
			(policy) => delete policy.routes[0].limits[key],
		]);
	}
	for (const key of Object.keys(route.pricing)) {
		cases.push([
			`policy.routes[0].pricing.${key}`,
			(policy) => delete policy.routes[0].pricing[key],
		]);
	}
	for (const [name, mutate] of cases) {
		const policy = readCommittedPolicy();
		mutate(policy);
		assert.throws(() => validatePolicy(policy), /required/, name);
	}
	assert.equal(resolvePolicy(readCommittedPolicy(), { instance: { maxTotalTokens: 1000 } }).instance.maxTotalTokens, 1000);
});

test('rejects duplicate routes and inconsistent or unsafe ceilings', () => {
	const duplicate = readCommittedPolicy();
	duplicate.routes.push(structuredClone(duplicate.routes[0]));
	assert.throws(() => validatePolicy(duplicate), /Duplicate route/);
	const inconsistent = readCommittedPolicy();
	inconsistent.profiles['agent-sdlc-default'].limits.runMaxTotalTokens = 1;
	assert.throws(() => validatePolicy(inconsistent), /below operation ceiling/);
	const unsafe = readCommittedPolicy();
	unsafe.profiles['agent-sdlc-default'].limits.maxPhysicalAttempts = 11;
	unsafe.profiles['agent-sdlc-default'].limits.runMaxPhysicalCalls = 11;
	assert.throws(
		() => validatePolicy(unsafe),
		(error) => error instanceof ModelUsageError && error.code === 'ERR_LIMIT_ESCALATION_FORBIDDEN',
	);
});

test('enabled unknown-priced routes are denied under committed hard monetary ceilings', () => {
	const policy = readCommittedPolicy();
	const route = policy.routes[0];
	route.enabled = true;
	route.metered = true;
	route.pricing = { status: 'unknown' };
	assert.throws(() => validatePolicy(policy), /requires known pricing/);
});

test('provider boundary is closed, repository-relative and traversal-safe', () => {
	const policy = readCommittedPolicy();
	assert.deepEqual(validatePolicy(policy).providerBoundary, {
		registeredConsumerRoots: ['packages/agent-sdlc'],
		allowedAdapterRoots: ['packages/model-usage/adapters'],
		allowedSetupFiles: [],
	});

	for (const invalidBoundary of [
		null,
		{ registeredConsumerRoots: [], allowedAdapterRoots: [], allowedSetupFiles: [], extra: [] },
		{
			registeredConsumerRoots: ['../outside'],
			allowedAdapterRoots: ['tools/model-usage/adapters'],
			allowedSetupFiles: [],
		},
		{
			registeredConsumerRoots: [],
			allowedAdapterRoots: ['/tmp/adapters'],
			allowedSetupFiles: [],
		},
		{
			registeredConsumerRoots: [],
			allowedAdapterRoots: ['tools\\model-usage\\adapters'],
			allowedSetupFiles: [],
		},
	]) {
		const candidate = readCommittedPolicy();
		candidate.providerBoundary = invalidBoundary;
		assert.throws(() => validatePolicy(candidate));
	}
});

test('AC-08: rejects impossible failover policy where operation token ceiling cannot fund conservative reservations', () => {
	const policy = readCommittedPolicy();
	// Set maxPhysicalAttempts to 2, but maxTotalTokens to 26000 (which only funds 1 reservation of 26000)
	policy.profiles['agent-sdlc-default'].limits.maxPhysicalAttempts = 2;
	policy.profiles['agent-sdlc-default'].limits.maxRetriesPerRoute = 1;
	policy.profiles['agent-sdlc-default'].limits.maxPromptTokens = 20000;
	policy.profiles['agent-sdlc-default'].limits.maxCompletionTokens = 6000;
	policy.profiles['agent-sdlc-default'].limits.maxTotalTokens = 26000;

	assert.throws(
		() => validatePolicy(policy),
		(err) =>
			err instanceof TypeError &&
			err.message.includes('operation token ceiling cannot fund 2 conservative maximum reservations'),
	);
});

test('validatePolicy rejects an empty profile map and a missing root field', () => {
	const empty = readCommittedPolicy();
	empty.profiles = {};
	assert.throws(() => validatePolicy(empty), /policy\.profiles must not be empty/);
	const missing = readCommittedPolicy();
	delete missing.pricingVersion;
	assert.throws(() => validatePolicy(missing), /pricingVersion is required/);
});
