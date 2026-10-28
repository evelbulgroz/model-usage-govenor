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

/** Policy owns the effort allowlist. A route without reasoning sends no thinkingConfig. */
function resolveThinkingConfig(
	route: PolicyRoute,
): { thinkingLevel: string } | undefined {
	if (!route?.capabilities?.includes('reasoning') || !route.reasoning?.effort) return undefined;
	return { thinkingLevel: route.reasoning.effort };
}

/** Absent means no cached tokens. An invalid count omits usage so the reservation stands. */
function cacheReadCount(metadata: Record<string, unknown> | undefined): number | undefined {
	if (metadata?.cachedContentTokenCount === undefined) return 0;
	const value = metadata.cachedContentTokenCount;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
	return value;
}

// Absent and invalid counts stay null. Do not reuse cacheReadCount: it maps an omission to 0.
function observedCount(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
	return value;
}

function providerModelVersion(body: { modelVersion?: unknown } | undefined): string | undefined {
	const value = body?.modelVersion;
	if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return undefined;
	return value;
}

export class GoogleModelAdapter implements ModelAdapter {
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
				'Google route lacks committed governance capabilities',
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
		const url = `${this.route.baseUrl}/models/${encodeURIComponent(
			this.route.model,
		)}:generateContent`;
		const thinkingConfig = resolveThinkingConfig(this.route);
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-goog-api-key': credential,
				},
				signal: request.signal,
				body: JSON.stringify({
					contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
					generationConfig: {
						maxOutputTokens: request.maxCompletionTokens,
						responseMimeType: 'application/json',
						responseJsonSchema: request.structuredOutputSchema,
						...(thinkingConfig ? { thinkingConfig } : {}),
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
		const providerRequestId =
			response.headers?.get?.('x-request-id') ?? response.headers?.get?.('x-goog-request-id') ?? undefined;
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
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
			usageMetadata?: Record<string, unknown>;
			modelVersion?: unknown;
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
		const parts = body?.candidates?.[0]?.content?.parts;
		const text = Array.isArray(parts)
			? parts.find((part) => typeof part?.text === 'string')?.text
			: undefined;
		let output: unknown;
		try {
			output = parseModelJson(text);
		} catch {
			return validateAdapterResult({
				status: 'failed',
				outcome: 'malformed_output',
				providerRequestId,
				diagnostic: {
					stage: 'model-content-json',
					content: fallbackDiagnosticContent(text, body),
				},
			});
		}
		const metadata = body?.usageMetadata;
		let usage: unknown;
		const cacheReadTokens = cacheReadCount(metadata);
		const promptTokenCount = metadata?.promptTokenCount;
		const candidatesTokenCount = metadata?.candidatesTokenCount;
		if (
			cacheReadTokens !== undefined &&
			typeof promptTokenCount === 'number' &&
			Number.isSafeInteger(promptTokenCount) &&
			typeof candidatesTokenCount === 'number' &&
			Number.isSafeInteger(candidatesTokenCount) &&
			cacheReadTokens <= promptTokenCount
		) {
			const reportedPromptTokens = promptTokenCount;
			const candidatesTokens = candidatesTokenCount;
			let completionTokens = candidatesTokens;

			let totalBasedCompletion = -1;
			const totalTokenCount = metadata?.totalTokenCount;
			if (
				typeof totalTokenCount === 'number' &&
				Number.isSafeInteger(totalTokenCount) &&
				totalTokenCount >= reportedPromptTokens + candidatesTokens
			) {
				totalBasedCompletion = totalTokenCount - reportedPromptTokens;
			}

			let thoughtsBasedCompletion = -1;
			const thoughtsTokenCount = metadata?.thoughtsTokenCount;
			if (
				typeof thoughtsTokenCount === 'number' &&
				Number.isSafeInteger(thoughtsTokenCount) &&
				thoughtsTokenCount >= 0
			) {
				thoughtsBasedCompletion = candidatesTokens + thoughtsTokenCount;
			}

			if (totalBasedCompletion >= 0 || thoughtsBasedCompletion >= 0) {
				completionTokens = Math.max(
					totalBasedCompletion,
					thoughtsBasedCompletion,
					candidatesTokens,
				);
			}

			usage = {
				promptTokens: reportedPromptTokens - cacheReadTokens,
				completionTokens,
				source: 'provider',
				...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
				tokenDetails: {
					cacheReadTokens: observedCount(metadata?.cachedContentTokenCount),
					cacheWriteTokens: null,
					reasoningTokens: observedCount(metadata?.thoughtsTokenCount),
				},
			};
		}
		const modelVersion = providerModelVersion(body);
		return validateAdapterResult({
			status: 'succeeded',
			output,
			usage,
			providerRequestId,
			...(modelVersion === undefined ? {} : { providerModelVersion: modelVersion }),
		});
	}
}
