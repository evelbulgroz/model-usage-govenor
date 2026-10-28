/**
 * Shared live-adapter spec fixtures. Excluded from the navigability ceiling.
 */
import { validatePolicy } from '../policy/policy.ts';
import { readCommittedPolicy } from './test-support.mjs';

export function route(provider) {
	const raw = readCommittedPolicy();
	const candidate = raw.routes.find((item) => item.provider === provider);
	candidate.enabled = true;
	return validatePolicy(raw).routes.find((item) => item.provider === provider);
}

export function routeById(routeId) {
	const raw = readCommittedPolicy();
	const candidate = raw.routes.find((item) => item.id === routeId);
	candidate.enabled = true;
	return validatePolicy(raw).routes.find((item) => item.id === routeId);
}

export function request(signal = new AbortController().signal) {
	return {
		operationId: 'operation',
		attemptId: 'attempt',
		prompt: 'prompt',
		structuredOutputSchema: { type: 'object' },
		maxCompletionTokens: 10,
		signal,
	};
}

export function response({ status = 200, body, requestId = 'request-1', extraHeaders = {} }) {
	const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: {
			get: (name) => {
				if (name.includes('request-id')) return requestId;
				const lower = name.toLowerCase();
				if (lower in extraHeaders) return extraHeaders[lower];
				return undefined;
			},
		},
		text: async () => rawBody,
	};
}
