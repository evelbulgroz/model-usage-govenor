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

function explicitPromptCache(route: PolicyRoute): boolean {
	return (
		route.model === 'gpt-6.1-sol' &&
		Number.isSafeInteger(route.pricing?.cacheReadMicrousdPerMillionTokens) &&
		Number.isSafeInteger(route.pricing?.cacheWrite5mMicrousdPerMillionTokens)
	);
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

// OpenAI looks up only declared breakpoints. Mark every stable block so the previous
// prefix is a boundary. Leave the trailing block, when the caller set a breakpoint, uncached.
function chatMessages(request: AdapterRequest, cacheExplicit: boolean): unknown[] {
	const blocks = Array.isArray(request.promptBlocks) ? request.promptBlocks : null;
	if (!cacheExplicit || !blocks) {
		return [{ role: 'user', content: request.prompt }];
	}
	const stableThrough =
		request.promptCacheBreakpoint === undefined
			? blocks.length - 1
			: request.promptCacheBreakpoint;
	return [
		{
			role: 'user',
			content: blocks.map((text, index) => ({
				type: 'text',
				text: index === 0 ? text : `\n${text}`,
				...(index <= stableThrough ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}),
			})),
		},
	];
}

function providerUsage(
	body: {
		usage?: {
			prompt_tokens?: unknown;
			completion_tokens?: unknown;
			prompt_tokens_details?: Record<string, unknown>;
			completion_tokens_details?: Record<string, unknown>;
		};
	} | null | undefined,
	route: PolicyRoute,
): Record<string, unknown> | undefined {
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
	const details = body?.usage?.prompt_tokens_details;
	const cached = detailCount(details, 'cached_tokens');
	const written = detailCount(details, 'cache_write_tokens');
	if (
		cached === undefined ||
		written === undefined ||
		cached > reportedPrompt ||
		written > reportedPrompt - cached
	) {
		return undefined;
	}
	const readRate = route.pricing?.cacheReadMicrousdPerMillionTokens;
	const writeRate = route.pricing?.cacheWrite5mMicrousdPerMillionTokens;
	let promptTokens = reportedPrompt - cached - written;
	const usage: Record<string, unknown> = { completionTokens, source: 'provider' };
	if (cached > 0 && Number.isSafeInteger(readRate)) usage.cacheReadTokens = cached;
	else promptTokens += cached;
	if (written > 0 && Number.isSafeInteger(writeRate)) usage.cacheWriteTokens = written;
	else promptTokens += written;
	usage.promptTokens = promptTokens;
	usage.tokenDetails = {
		cacheReadTokens: observedCount(details?.cached_tokens),
		cacheWriteTokens: observedCount(details?.cache_write_tokens),
		reasoningTokens: observedCount(body?.usage?.completion_tokens_details?.reasoning_tokens),
	};
	return usage;
}

export class OpenAICompatibleModelAdapter implements ModelAdapter {
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
				'OpenAI-compatible route lacks committed governance capabilities',
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
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.route.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${credential}`,
					'content-type': 'application/json',
				},
				signal: request.signal,
				body: JSON.stringify({
					model: this.route.model,
					messages: chatMessages(request, explicitPromptCache(this.route)),
					max_completion_tokens: request.maxCompletionTokens,
					...(explicitPromptCache(this.route) && Array.isArray(request.promptBlocks)
						? { prompt_cache_options: { mode: 'explicit', ttl: '30m' } }
						: {}),
					...(this.route.capabilities?.includes('reasoning') && this.route.reasoning
						? { reasoning_effort: this.route.reasoning.effort }
						: {}),
					response_format: {
						type: 'json_schema',
						json_schema: {
							name: 'governed_output',
							strict: true,
							schema: request.structuredOutputSchema,
						},
					},
				}),
			});
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
		const providerRequestId = response.headers?.get?.('x-request-id') ?? undefined;
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
		let body: {
			choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
			usage?: {
				prompt_tokens?: unknown;
				completion_tokens?: unknown;
				prompt_tokens_details?: Record<string, unknown>;
				completion_tokens_details?: Record<string, unknown>;
			};
		};
		let rawBody = '';
		try {
			rawBody = await response.text();
			body = JSON.parse(rawBody) as typeof body;
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
		const content = body?.choices?.[0]?.message?.content;
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
					...(body?.choices?.[0]?.finish_reason === 'length' ? { truncated: true } : {}),
				},
			});
		}
		const usage = providerUsage(body, this.route);
		return validateAdapterResult({ status: 'succeeded', output, usage, providerRequestId });
	}
}
