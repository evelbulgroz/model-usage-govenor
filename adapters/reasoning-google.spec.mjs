import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { GoogleModelAdapter } from './google.ts';
import { FakeModelAdapter } from './fake.ts';
import { executeOperation } from '../governor/governor.ts';
import { ModelUsageError } from '../policy/errors.ts';
import { resolvePolicy, validatePolicy } from '../policy/policy.ts';
import {
	baseRequest,
	cleanupTestRoot,
	makeTestRoot,
	readCommittedPolicy,
	writePolicy,
} from '../testing/test-support.mjs';

function committedRoute(routeId) {
	return validatePolicy(readCommittedPolicy()).routes.find((route) => route.id === routeId);
}

function adapterRequest(maxCompletionTokens = 6000) {
	return {
		operationId: 'operation',
		attemptId: 'attempt',
		prompt: 'prompt',
		structuredOutputSchema: { type: 'object' },
		maxCompletionTokens,
		signal: new AbortController().signal,
	};
}

async function captureGoogleBody(route) {
	let captured;
	const adapter = new GoogleModelAdapter(route, {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async (_url, init) => {
			captured = JSON.parse(init.body);
			return {
				ok: true,
				status: 200,
				headers: { get: () => 'request-1' },
				text: async () =>
					JSON.stringify({
						candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
						usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
					}),
			};
		},
	});
	const result = await adapter.execute(adapterRequest());
	assert.equal(result.status, 'succeeded');
	return captured;
}

test('@ac AC-03 @case AC-03.1 google-gemini-conservative sends thinkingLevel minimal and maxOutputTokens 6000', async () => {
	const body = await captureGoogleBody(committedRoute('google-gemini-conservative'));
	assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
	assert.equal(body.generationConfig.maxOutputTokens, 6000);
});

test('@ac AC-03 @case AC-03.2 google-gemini-quality sends thinkingLevel medium and maxOutputTokens 6000', async () => {
	const body = await captureGoogleBody(committedRoute('google-gemini-quality'));
	assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'medium');
	assert.equal(body.generationConfig.maxOutputTokens, 6000);
});

test('@ac AC-04 a flash model without reasoning sends no thinkingConfig and maxOutputTokens 6000', async () => {
	const policy = structuredClone(readCommittedPolicy());
	const route = policy.routes.find((item) => item.id === 'google-gemini-conservative');
	route.capabilities = route.capabilities.filter((capability) => capability !== 'reasoning');
	delete route.reasoning;
	assert.equal(route.model, 'gemini-3.6-flash');
	const validated = validatePolicy(policy).routes.find((item) => item.id === 'google-gemini-conservative');
	const body = await captureGoogleBody(validated);
	assert.equal(Object.hasOwn(body.generationConfig, 'thinkingConfig'), false);
	assert.equal(body.generationConfig.maxOutputTokens, 6000);
});

test('@ac AC-05 @case AC-05.1 raising effort from medium to high is rejected with ERR_LIMIT_ESCALATION_FORBIDDEN', () => {
	assert.throws(
		() =>
			resolvePolicy(readCommittedPolicy(), {
				routes: [{ id: 'google-gemini-quality', reasoning: { effort: 'high' } }],
			}),
		(error) => error instanceof ModelUsageError && error.code === 'ERR_LIMIT_ESCALATION_FORBIDDEN',
	);
});

test('@ac AC-05 @case AC-05.2 lowering effort from medium to minimal loads effort minimal', () => {
	const resolved = resolvePolicy(readCommittedPolicy(), {
		routes: [{ id: 'google-gemini-quality', reasoning: { effort: 'minimal' } }],
	});
	const route = resolved.routes.find((item) => item.id === 'google-gemini-quality');
	assert.equal(route.reasoning.effort, 'minimal');
});

test('@ac AC-05 @case AC-05.3 removing the reasoning capability drops both the capability and the reasoning object', () => {
	const resolved = resolvePolicy(readCommittedPolicy(), {
		routes: [
			{
				id: 'google-gemini-quality',
				capabilities: ['structured-output', 'usage', 'abort', 'request-id'],
			},
		],
	});
	const route = resolved.routes.find((item) => item.id === 'google-gemini-quality');
	assert.equal(route.capabilities.includes('reasoning'), false);
	assert.equal(Object.hasOwn(route, 'reasoning'), false);
});

test('@ac AC-06 a reasoning Google route reserves and dispatches the profile completion ceiling', async () => {
	const root = makeTestRoot('reasoning-google-reservation');
	const stateRoot = path.join(root, 'state');
	const request = baseRequest({
		routingConstraints: {
			requiredCapabilities: ['structured-output'],
			preferredRouteIds: ['google-gemini-quality'],
		},
		requestedLimits: {
			maxCompletionTokens: 6000,
			maxPhysicalAttempts: 1,
			maxRetriesPerRoute: 0,
			maxFailovers: 0,
		},
	});
	let seenCompletion;
	let persistedCompletion;
	const adapter = new FakeModelAdapter('google-gemini-quality', [
		{
			onCall(adapterRequest) {
				seenCompletion = adapterRequest.maxCompletionTokens;
				const envelope = JSON.parse(
					fs.readFileSync(path.join(stateRoot, 'runs', `${request.runId}.json`), 'utf8'),
				);
				persistedCompletion = envelope.reservations[0].charge.completionTokens;
			},
			result: {
				status: 'succeeded',
				output: { ok: true },
				usage: { promptTokens: 2, completionTokens: 1, source: 'provider' },
			},
		},
	]);
	try {
		const policyPath = writePolicy(root, readCommittedPolicy());
		await executeOperation(request, {
			policyPath,
			stateRoot,
			localPolicyPath: null,
			adapters: new Map([['google-gemini-quality', adapter]]),
		});
		assert.equal(seenCompletion, 6000);
		assert.equal(persistedCompletion, 6000);
		assert.equal(adapter.callCount, 1);
	} finally {
		cleanupTestRoot(root);
	}
});
