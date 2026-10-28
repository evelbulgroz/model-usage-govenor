import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicModelAdapter } from './anthropic.ts';
import { OpenAICompatibleModelAdapter } from './openai-compatible.ts';
import { XaiModelAdapter } from './xai.ts';
import { resolvePolicy, validatePolicy } from '../policy/policy.ts';
import { readCommittedPolicy } from '../testing/test-support.mjs';

function clonePolicy() {
	return structuredClone(readCommittedPolicy());
}

function routeById(policy, routeId) {
	const route = policy.routes.find((item) => item.id === routeId);
	if (!route) throw new Error(`missing route ${routeId}`);
	return route;
}

function declareReasoning(policy, routeId, effort = 'low') {
	const route = routeById(policy, routeId);
	if (!route.capabilities.includes('reasoning')) {
		route.capabilities = [...route.capabilities, 'reasoning'];
	}
	route.reasoning = { effort };
	return route;
}

function xaiFixture(policy, effort) {
	const route = structuredClone(routeById(policy, 'xai-grok-quality'));
	route.id = 'xai-grok-4-5-fixture';
	route.model = 'grok-4.5';
	if (!route.capabilities.includes('reasoning')) {
		route.capabilities = [...route.capabilities, 'reasoning'];
	}
	route.reasoning = { effort };
	policy.routes.push(route);
	return route;
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

function jsonResponse(body) {
	return {
		ok: true,
		status: 200,
		headers: { get: () => 'request-1' },
		text: async () => JSON.stringify(body),
	};
}

async function captureCall(Adapter, route, env) {
	let captured;
	const adapter = new Adapter(route, {
		env,
		fetchImpl: async (url, init) => {
			captured = { url, headers: init.headers, body: JSON.parse(init.body) };
			return jsonResponse({
				choices: [{ message: { content: '{"ok":true}' } }],
				content: [{ type: 'text', text: '{"ok":true}' }],
				output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
				usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 },
			});
		},
	});
	const result = await adapter.execute(adapterRequest());
	assert.equal(result.status, 'succeeded');
	return captured;
}

test('@ac AC-01 @case AC-01.1 validatePolicy accepts the grok-4.5 effort low fixture', () => {
	const policy = clonePolicy();
	xaiFixture(policy, 'low');
	const validated = validatePolicy(policy);
	const route = validated.routes.find((item) => item.id === 'xai-grok-4-5-fixture');
	assert.equal(route.model, 'grok-4.5');
	assert.equal(route.reasoning.effort, 'low');
	assert.ok(route.capabilities.includes('reasoning'));
});

test('@ac AC-01 @case AC-01.2 the outgoing Responses body sets reasoning.effort low and max_output_tokens 6000', async () => {
	const policy = clonePolicy();
	xaiFixture(policy, 'low');
	const route = validatePolicy(policy).routes.find((item) => item.id === 'xai-grok-4-5-fixture');
	const captured = await captureCall(XaiModelAdapter, route, { XAI_API_KEY: 'credential' });
	assert.match(captured.url, /\/v1\/responses$/);
	assert.equal(captured.body.reasoning.effort, 'low');
	assert.equal(captured.body.max_output_tokens, 6000);
	assert.equal(captured.body.store, false);
	assert.equal(captured.body.prompt_cache_key, 'operation');
	assert.equal(captured.body.input, 'prompt');
	assert.equal(captured.body.messages, undefined);
	assert.equal(captured.body.prompt_cache_options, undefined);
	assert.equal(captured.body.tools, undefined);
});

test('@ac AC-02 @case AC-02.1 xai-grok-quality accepts grok-4.7 at effort low and rejects grok-4.20', () => {
	const policy = clonePolicy();
	const committed = validatePolicy(structuredClone(policy)).routes.find(
		(item) => item.id === 'xai-grok-quality',
	);
	assert.equal(committed.model, 'grok-4.7');
	assert.equal(committed.reasoning.effort, 'low');
	const route = routeById(policy, 'xai-grok-quality');
	route.model = 'grok-4.20-0309-reasoning';
	assert.throws(
		() => validatePolicy(policy),
		(error) => error instanceof TypeError && error.message.includes('xai-grok-quality'),
	);
	const xhigh = clonePolicy();
	routeById(xhigh, 'xai-grok-quality').reasoning = { effort: 'xhigh' };
	assert.throws(
		() => validatePolicy(xhigh),
		(error) => error instanceof TypeError && error.message.includes('xai reasoning effort is not allowed'),
	);
});

test('@ac AC-02 @case AC-02.2 xai-grok-conservative with model grok-4.20-0309-non-reasoning is rejected', () => {
	const policy = clonePolicy();
	const route = declareReasoning(policy, 'xai-grok-conservative', 'low');
	assert.equal(route.model, 'grok-4.20-0309-non-reasoning');
	assert.throws(
		() => validatePolicy(policy),
		(error) => error instanceof TypeError && error.message.includes('xai-grok-conservative'),
	);
});

test('@ac AC-02 @case AC-02.3 anthropic-claude-quality with model claude-sonnet-5-5 is rejected', () => {
	const policy = clonePolicy();
	const route = declareReasoning(policy, 'anthropic-claude-quality', 'low');
	assert.equal(route.model, 'claude-sonnet-5-5');
	assert.throws(
		() => validatePolicy(policy),
		(error) => error instanceof TypeError && error.message.includes('anthropic-claude-quality'),
	);
});

test('@ac AC-02 @case AC-02.4 gpt-6.1-sol accepts effort low and rejects minimal and xhigh', () => {
	const policy = clonePolicy();
	const route = routeById(policy, 'openai-compatible-quality');
	assert.equal(route.model, 'gpt-6.1-sol');
	assert.equal(validatePolicy(policy).routes.find((item) => item.id === route.id).reasoning.effort, 'low');
	route.reasoning = { effort: 'minimal' };
	assert.throws(
		() => validatePolicy(policy),
		(error) => error instanceof TypeError && error.message.includes('openai-compatible-quality'),
	);
	route.reasoning = { effort: 'xhigh' };
	assert.throws(
		() => validatePolicy(policy),
		(error) => error instanceof TypeError && error.message.includes('openai reasoning effort is not allowed'),
	);
	const conservative = clonePolicy();
	declareReasoning(conservative, 'openai-compatible-conservative', 'low');
	assert.throws(
		() => validatePolicy(conservative),
		(error) => error instanceof TypeError && error.message.includes('openai-compatible-conservative'),
	);
});

test('@ac AC-02 @case AC-02.5 a Google route that lists the reasoning capability and omits the reasoning object is rejected', () => {
	const policy = clonePolicy();
	const route = routeById(policy, 'google-gemini-quality');
	delete route.reasoning;
	assert.ok(route.capabilities.includes('reasoning'));
	assert.throws(
		() => validatePolicy(policy),
		(error) => error instanceof TypeError && error.message.includes('google-gemini-quality'),
	);
});

test('@ac AC-02 @case AC-02.6 xai model grok-4.5 with effort minimal is rejected', () => {
	const policy = clonePolicy();
	const route = xaiFixture(policy, 'minimal');
	assert.equal(route.model, 'grok-4.5');
	assert.throws(
		() => validatePolicy(policy),
		(error) => error instanceof TypeError && error.message.includes('xai-grok-4-5-fixture'),
	);
});

test('@ac AC-02 a reasoning object without the capability fails policy load', () => {
	const policy = clonePolicy();
	const route = routeById(policy, 'xai-grok-quality');
	route.capabilities = route.capabilities.filter((item) => item !== 'reasoning');
	route.reasoning = { effort: 'low' };
	assert.throws(
		() => validatePolicy(policy),
		(error) => error instanceof TypeError && error.message.includes('xai-grok-quality'),
	);
});

test('@ac AC-08 @case AC-08.1 openai-compatible-quality sends reasoning_effort low and max_completion_tokens 6000', async () => {
	const route = validatePolicy(readCommittedPolicy()).routes.find(
		(item) => item.id === 'openai-compatible-quality',
	);
	const captured = await captureCall(OpenAICompatibleModelAdapter, route, { OPENAI_API_KEY: 'credential' });
	assert.equal(captured.body.reasoning_effort, 'low');
	assert.equal(captured.body.prompt_cache_options, undefined);
	assert.equal(captured.body.max_completion_tokens, 6000);
});

test('@ac AC-08 @case AC-08.2 xai-grok-quality sends reasoning.effort low and max_output_tokens 6000', async () => {
	const route = validatePolicy(readCommittedPolicy()).routes.find((item) => item.id === 'xai-grok-quality');
	const captured = await captureCall(XaiModelAdapter, route, { XAI_API_KEY: 'credential' });
	assert.match(captured.url, /\/v1\/responses$/);
	assert.equal(captured.body.model, 'grok-4.7');
	assert.equal(captured.body.reasoning.effort, 'low');
	assert.equal(captured.body.max_output_tokens, 6000);
	assert.equal(captured.body.store, false);
	assert.equal(captured.body.prompt_cache_key, 'operation');
	assert.equal(captured.body.messages, undefined);
	assert.equal(captured.body.prompt_cache_options, undefined);
	assert.equal(captured.body.reasoning_effort, undefined);
});

test('@ac AC-08 @case AC-08.3 anthropic-claude-quality uses between_tools thinking and sends max_tokens 6000', async () => {
	const route = validatePolicy(readCommittedPolicy()).routes.find(
		(item) => item.id === 'anthropic-claude-quality',
	);
	const captured = await captureCall(AnthropicModelAdapter, route, { ANTHROPIC_API_KEY: 'credential' });
	assert.deepEqual(captured.body.thinking, { type: 'between_tools' });
	assert.equal(captured.body.max_tokens, 6000);
});

test('@ac AC-02 local policy cannot add reasoning to a route that does not declare it', () => {
	assert.throws(
		() =>
			resolvePolicy(readCommittedPolicy(), {
				routes: [{ id: 'xai-grok-conservative', reasoning: { effort: 'low' } }],
			}),
		(error) => error.code === 'ERR_LIMIT_ESCALATION_FORBIDDEN',
	);
});
