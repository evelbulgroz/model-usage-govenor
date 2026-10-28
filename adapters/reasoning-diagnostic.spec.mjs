import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicModelAdapter } from './anthropic.ts';
import { fallbackDiagnosticContent } from './adapter-contract.ts';
import { GoogleModelAdapter } from './google.ts';
import { OpenAICompatibleModelAdapter } from './openai-compatible.ts';
import { validatePolicy } from '../policy/policy.ts';
import { readCommittedPolicy } from '../testing/test-support.mjs';

function committedRoute(routeId) {
	const raw = readCommittedPolicy();
	return validatePolicy(raw).routes.find((route) => route.id === routeId);
}

function request() {
	return {
		operationId: 'operation',
		attemptId: 'attempt',
		prompt: 'prompt',
		structuredOutputSchema: { type: 'object' },
		maxCompletionTokens: 6000,
		signal: new AbortController().signal,
	};
}

function response(body) {
	const rawBody = JSON.stringify(body);
	return {
		ok: true,
		status: 200,
		headers: { get: () => undefined },
		text: async () => rawBody,
	};
}

async function captureDiagnostic(adapter, body) {
	const result = await adapter.execute(request());
	assert.equal(result.status, 'failed');
	assert.equal(result.outcome, 'malformed_output');
	assert.equal(result.diagnostic.content, fallbackDiagnosticContent(
		body?.choices?.[0]?.message?.content ??
			body?.candidates?.[0]?.content?.parts?.find((part) => typeof part?.text === 'string')?.text ??
			body?.content?.find((block) => block?.type === 'text')?.text,
		body,
	));
	return result.diagnostic.content;
}

test('@ac AC-07 @case AC-07.1 the OpenAI-compatible adapter stores the serialized body', async () => {
	const body = { ok: false, choices: [{ message: { content: '' } }] };
	const adapter = new OpenAICompatibleModelAdapter(committedRoute('openai-compatible-quality'), {
		env: { OPENAI_API_KEY: 'credential' },
		fetchImpl: async () => response(body),
	});
	const content = await captureDiagnostic(adapter, body);
	assert.equal(content, JSON.stringify(body));
	assert.notEqual(content, '');
});

test('@ac AC-07 @case AC-07.2 the Google adapter stores the serialized body', async () => {
	const body = { ok: false, candidates: [{ content: { parts: [{ text: '' }] } }] };
	const adapter = new GoogleModelAdapter(committedRoute('google-gemini-quality'), {
		env: { GOOGLE_API_KEY: 'credential' },
		fetchImpl: async () => response(body),
	});
	const content = await captureDiagnostic(adapter, body);
	assert.equal(content, JSON.stringify(body));
	assert.notEqual(content, '');
});

test('@ac AC-07 @case AC-07.3 the Anthropic adapter stores the serialized body', async () => {
	const body = { ok: false, content: [{ type: 'text', text: '' }] };
	const adapter = new AnthropicModelAdapter(committedRoute('anthropic-claude-quality'), {
		env: { ANTHROPIC_API_KEY: 'credential' },
		fetchImpl: async () => response(body),
	});
	const content = await captureDiagnostic(adapter, body);
	assert.equal(content, JSON.stringify(body));
	assert.notEqual(content, '');
});

test('@ac AC-07 @case AC-07.4 a serialization longer than 32768 characters is stored at length 32768', async () => {
	const body = {
		ok: false,
		choices: [{ message: { content: '' } }],
		pad: 'x'.repeat(40_000),
	};
	assert.ok(JSON.stringify(body).length > 32768);
	const adapter = new OpenAICompatibleModelAdapter(committedRoute('openai-compatible-quality'), {
		env: { OPENAI_API_KEY: 'credential' },
		fetchImpl: async () => response(body),
	});
	const content = await captureDiagnostic(adapter, body);
	assert.equal(content.length, 32768);
	assert.equal(content, fallbackDiagnosticContent('', body));
});

test('@ac AC-07 @case AC-07.5 a non-string extracted value stores the serialized body', async () => {
	const body = { ok: false, choices: [{ message: { content: null } }] };
	const adapter = new OpenAICompatibleModelAdapter(committedRoute('openai-compatible-quality'), {
		env: { OPENAI_API_KEY: 'credential' },
		fetchImpl: async () => response(body),
	});
	const content = await captureDiagnostic(adapter, body);
	assert.equal(content, JSON.stringify(body));
	assert.equal(content, fallbackDiagnosticContent(null, body));
});
