import { ModelUsageError } from '../policy/errors.ts';
import type { PolicyRoute } from '../policy/policy-route-catalog.ts';
import {
	type AdapterRequest,
	type AdapterResult,
	type ModelAdapter,
	fallbackDiagnosticContent,
	outcomeForStatus,
	parseModelJson,
	parseRetryAfterMs,
	validateAdapterRequest,
	validateAdapterResult,
} from './adapter-contract.ts';

// grok-4.5, grok-4.6, and grok-4.7 accept reasoning.effort on /v1/responses.
// grok-4.20 stays on chat completions and rejects that field at policy load.
const RESPONSES_MODELS = new Set(['grok-4.5', 'grok-4.6', 'grok-4.7']);

interface XaiBody {
	output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
	choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
	incomplete_details?: { reason?: string };
	usage?: {
		prompt_tokens?: unknown;
		completion_tokens?: unknown;
		input_tokens?: unknown;
		output_tokens?: unknown;
		prompt_tokens_details?: Record<string, unknown>;
		completion_tokens_details?: Record<string, unknown>;
		input_tokens_details?: Record<string, unknown>;
		output_tokens_details?: Record<string, unknown>;
	};
}

function detailCount(details: Record<string, unknown> | undefined, key: string): number | undefined {
	if (details?.[key] === undefined) return 0;
	const value = details[key];
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
	return value;
}

// Absent and invalid counts stay null. Do not reuse detailCount: it maps an omission to 0.
function observedCount(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
	return value;
}

function usesResponses(route: PolicyRoute): boolean {
	return RESPONSES_MODELS.has(route.model);
}

/**
 * input_tokens and prompt_tokens already include cached tokens.
 * An invalid count, or a cache count above the reported input, omits usage.
 * There is no cache-write product on these routes.
 */
function pricedPrompt(
	reported: number,
	cached: number | undefined,
	readRate: number | undefined,
): { promptTokens: number; cacheReadTokens?: number } | undefined {
	if (cached === undefined || cached > reported) return undefined;
	if (cached > 0 && Number.isSafeInteger(readRate)) {
		return { promptTokens: reported - cached, cacheReadTokens: cached };
	}
	return { promptTokens: reported };
}

function chatUsage(body: XaiBody | undefined, route: PolicyRoute): Record<string, unknown> | undefined {
	const reportedPrompt = body?.usage?.prompt_tokens;
	const completionTokens = body?.usage?.completion_tokens;
	if (
		typeof reportedPrompt !== 'number' ||
		!Number.isSafeInteger(reportedPrompt) ||
		reportedPrompt < 0 ||
		typeof completionTokens !== 'number' ||
		!Number.isSafeInteger(completionTokens) ||
		completionTokens < 0
	) {
		return undefined;
	}
	const cached = detailCount(body?.usage?.prompt_tokens_details, 'cached_tokens');
	const prompt = pricedPrompt(
		reportedPrompt,
		cached,
		route.pricing?.cacheReadMicrousdPerMillionTokens,
	);
	if (!prompt) return undefined;
	return {
		...prompt,
		completionTokens,
		source: 'provider',
		tokenDetails: {
			cacheReadTokens: observedCount(body?.usage?.prompt_tokens_details?.cached_tokens),
			cacheWriteTokens: null,
			reasoningTokens: observedCount(body?.usage?.completion_tokens_details?.reasoning_tokens),
		},
	};
}

// output_tokens already includes reasoning tokens. Do not add them again.
function responsesUsage(body: XaiBody | undefined, route: PolicyRoute): Record<string, unknown> | undefined {
	const reportedInput = body?.usage?.input_tokens;
	const completionTokens = body?.usage?.output_tokens;
	if (
		typeof reportedInput !== 'number' ||
		!Number.isSafeInteger(reportedInput) ||
		reportedInput < 0 ||
		typeof completionTokens !== 'number' ||
		!Number.isSafeInteger(completionTokens) ||
		completionTokens < 0
	) {
		return undefined;
	}
	const cached = detailCount(body?.usage?.input_tokens_details, 'cached_tokens');
	const prompt = pricedPrompt(
		reportedInput,
		cached,
		route.pricing?.cacheReadMicrousdPerMillionTokens,
	);
	if (!prompt) return undefined;
	return {
		...prompt,
		completionTokens,
		source: 'provider',
		tokenDetails: {
			cacheReadTokens: observedCount(body?.usage?.input_tokens_details?.cached_tokens),
			cacheWriteTokens: null,
			reasoningTokens: observedCount(body?.usage?.output_tokens_details?.reasoning_tokens),
		},
	};
}

function responseText(body: XaiBody | undefined): string | undefined {
	const output = body?.output;
	if (!Array.isArray(output)) return undefined;
	for (const item of output) {
		if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
		const part = item.content.find(
			(entry) => entry?.type === 'output_text' && typeof entry.text === 'string',
		);
		if (part) return part.text;
	}
	return undefined;
}

function lengthCapped(body: XaiBody | undefined, responses: boolean): boolean {
	if (responses) return body?.incomplete_details?.reason === 'max_output_tokens';
	return body?.choices?.[0]?.finish_reason === 'length';
}

function requestId(response: Response): string | undefined {
	return (
		response.headers?.get?.('x-request-id') ??
		response.headers?.get?.('x-grok-request-id') ??
		undefined
	);
}

function responsesBody(route: PolicyRoute, request: AdapterRequest): Record<string, unknown> {
	return {
		model: route.model,
		input: request.prompt,
		store: false,
		max_output_tokens: request.maxCompletionTokens,
		prompt_cache_key: request.operationId,
		...(route.capabilities?.includes('reasoning') && route.reasoning?.effort
			? { reasoning: { effort: route.reasoning.effort } }
			: {}),
		text: {
			format: {
				type: 'json_schema',
				name: 'governed_output',
				strict: true,
				schema: request.structuredOutputSchema,
			},
		},
	};
}

function chatBody(route: PolicyRoute, request: AdapterRequest): Record<string, unknown> {
	return {
		model: route.model,
		messages: [{ role: 'user', content: request.prompt }],
		max_completion_tokens: request.maxCompletionTokens,
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'governed_output',
				strict: true,
				schema: request.structuredOutputSchema,
			},
		},
	};
}

export class XaiModelAdapter implements ModelAdapter {
	readonly routeId: string;
	readonly route: PolicyRoute;
	readonly fetchImpl: typeof globalThis.fetch;
	readonly env: NodeJS.ProcessEnv;

	constructor(
		route: PolicyRoute,
		{
			fetchImpl = globalThis.fetch,
			env = process.env,
		}: { fetchImpl?: typeof globalThis.fetch; env?: NodeJS.ProcessEnv } = {},
	) {
		if (
			!route?.enabled ||
			!['governed', 'governed-conservative'].includes(route.classification) ||
			!route.capabilities?.includes('structured-output') ||
			!route.capabilities?.includes('abort') ||
			!route.credentialEnv ||
			!route.baseUrl
		) {
			throw new ModelUsageError(
				'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
				'xAI route lacks committed governance capabilities',
				{ routeId: route?.id, reason: 'capability-gate' },
			);
		}
		this.routeId = route.id;
		this.route = route;
		this.fetchImpl = fetchImpl;
		this.env = env;
	}

	async execute(request: AdapterRequest): Promise<AdapterResult> {
		validateAdapterRequest(request);
		const credential = this.route.credentialEnv ? this.env[this.route.credentialEnv] : undefined;
		if (!credential) {
			return validateAdapterResult({
				status: 'failed',
				outcome: 'transport',
				executionProvenFalse: true,
			});
		}
		const responses = usesResponses(this.route);
		let response: Response;
		try {
			response = await this.fetchImpl(
				`${this.route.baseUrl}${responses ? '/responses' : '/chat/completions'}`,
				{
					method: 'POST',
					headers: {
						authorization: `Bearer ${credential}`,
						'content-type': 'application/json',
						...(responses ? {} : { 'x-grok-conv-id': request.operationId }),
					},
					signal: request.signal,
					body: JSON.stringify(
						responses ? responsesBody(this.route, request) : chatBody(this.route, request),
					),
				},
			);
		} catch {
			return validateAdapterResult({
				status: 'failed',
				outcome: request.signal.aborted
					? (request.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
						? 'timeout'
						: 'cancelled'
					: 'transport',
			});
		}
		const providerRequestId = requestId(response);
		if (!response.ok) {
			const errorBody = await response.text().catch(() => '');
			const outcome = outcomeForStatus(response.status, errorBody);
			const retryAfterMs = parseRetryAfterMs(response, outcome);
			return validateAdapterResult({
				status: 'failed',
				outcome,
				providerRequestId,
				executionProvenFalse: true,
				...(errorBody
					? { diagnostic: { stage: 'provider-error-response', content: errorBody } }
					: {}),
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			});
		}
		let body: XaiBody;
		let rawBody = '';
		try {
			rawBody = await response.text();
			body = JSON.parse(rawBody) as XaiBody;
		} catch {
			if (request.signal.aborted) {
				return validateAdapterResult({
					status: 'failed',
					outcome:
						(request.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
							? 'timeout'
							: 'cancelled',
					providerRequestId,
				});
			}
			return validateAdapterResult({
				status: 'failed',
				outcome: 'malformed_output',
				providerRequestId,
				diagnostic: { stage: 'provider-body-json', content: rawBody },
			});
		}
		const content = responses ? responseText(body) : body?.choices?.[0]?.message?.content;
		let output: unknown;
		try {
			output = parseModelJson(content);
		} catch {
			return validateAdapterResult({
				status: 'failed',
				outcome: 'malformed_output',
				providerRequestId,
				diagnostic: {
					stage: 'model-content-json',
					content: fallbackDiagnosticContent(content, body),
					...(lengthCapped(body, responses) ? { truncated: true } : {}),
				},
			});
		}
		const usage = responses ? responsesUsage(body, this.route) : chatUsage(body, this.route);
		return validateAdapterResult({ status: 'succeeded', output, usage, providerRequestId });
	}
}
