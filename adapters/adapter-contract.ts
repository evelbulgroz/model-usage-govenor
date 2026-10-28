import { MALFORMED_OUTPUT_DIAGNOSTIC_MAX_CHARS } from '../governor/diagnostics.ts';
import type { StructuredOutputSchema } from '../governor/structured-output-schema.ts';

export type AdapterOutcome =
	| 'timeout'
	| 'cancelled'
	| 'quota'
	| 'transport'
	| 'http_4xx'
	| 'http_5xx'
	| 'malformed_output';

export type DiagnosticStage =
	| 'provider-body-json'
	| 'model-content-json'
	| 'schema-validation'
	| 'provider-error-response';

export interface AdapterDiagnostic {
	readonly stage: DiagnosticStage;
	readonly content: string;
	readonly truncated?: boolean;
}

export interface ProviderTokenDetails {
	readonly cacheReadTokens: number | null;
	readonly cacheWriteTokens: number | null;
	readonly reasoningTokens: number | null;
}

export interface ProviderUsage {
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly premiumRequestUnits?: number;
	readonly source: 'provider' | 'estimated';
	readonly tokenDetails?: ProviderTokenDetails;
}

export interface AdapterRequest {
	operationId: string;
	attemptId: string;
	prompt: string;
	promptBlocks?: readonly string[];
	promptCacheBreakpoint?: number;
	structuredOutputSchema: StructuredOutputSchema;
	maxCompletionTokens: number;
	signal: AbortSignal;
}

export interface AdapterSuccessResult {
	readonly status: 'succeeded';
	readonly output: unknown;
	readonly usage?: ProviderUsage;
	readonly providerRequestId?: string;
	readonly providerModelVersion?: string;
}

export interface AdapterFailureResult {
	readonly status: 'failed';
	readonly outcome: AdapterOutcome;
	readonly usage?: ProviderUsage;
	readonly providerRequestId?: string;
	readonly providerModelVersion?: string;
	readonly executionProvenFalse?: boolean;
	readonly diagnostic?: AdapterDiagnostic;
	readonly retryAfterMs?: number;
}

export type AdapterResult = AdapterSuccessResult | AdapterFailureResult;

export interface ModelAdapter {
	readonly routeId: string;
	execute(request: AdapterRequest): Promise<AdapterResult>;
}

const OUTCOMES = new Set([
	'timeout',
	'cancelled',
	'quota',
	'transport',
	'http_4xx',
	'http_5xx',
	'malformed_output',
]);
const DIAGNOSTIC_STAGES = new Set([
	'provider-body-json',
	'model-content-json',
	'schema-validation',
	'provider-error-response',
]);
// 'quota' (HTTP 429) is diagnostic-eligible too: real provider rate-limit responses
// almost always carry a body, and discarding it here would make validateAdapterResult
// throw a TypeError deep inside the adapter, which the governor's catch-all then
// silently reclassifies as an opaque 'transport' failure - losing both the real
// quota signal and the body that would explain it.
const DIAGNOSTIC_ELIGIBLE_OUTCOMES = new Set(['malformed_output', 'http_4xx', 'http_5xx', 'quota']);
const MAX_DIAGNOSTIC_CONTENT_CHARS = 65_536;
// Defensive ceiling on how long we'll let a provider-specified Retry-After push our
// circuit-breaker cooldown out to, so a malformed or hostile header value can't park a
// route unavailable for an unbounded/absurd duration.
export const MAX_RETRY_AFTER_MS = 600_000;
const RETRY_AFTER_ELIGIBLE_OUTCOMES = new Set(['quota', 'http_5xx']);
// Account exhaustion, not a malformed request. A bare "credit" is not enough:
// schema rejections must stay http_4xx and end the operation.
const CREDIT_BALANCE_MARKERS = [
	'credit balance is too low',
	'prepay credit balance is depleted',
	'prepayment credits are depleted',
	'insufficient_quota',
	'billing_hard_limit_reached',
	'you have run out of credits',
	'personal-team-blocked:spending-limit',
];

/**
 * True when a provider error body reports a depleted credit balance.
 * Callers map a matching HTTP 4xx to quota so the governor fails over.
 */
export function isCreditBalanceBody(body: unknown): boolean {
	if (typeof body !== 'string' || body.length === 0) return false;
	const text = body.toLowerCase();
	return CREDIT_BALANCE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Map an HTTP status to a governor outcome. Credit-balance 4xx is quota so the
 * existing failover path runs. 429 stays quota. 5xx stays http_5xx. Other 4xx
 * stays terminal.
 */
export function outcomeForStatus(status: number, body: unknown): AdapterOutcome {
	if (status === 429) return 'quota';
	if (status >= 500) return 'http_5xx';
	if (isCreditBalanceBody(body)) return 'quota';
	return 'http_4xx';
}

/**
 * Empty extracted model text is not captured content. Non-empty text is kept.
 * Truncate to the diagnostic writer cap before validateAdapterResult, whose own
 * ceiling is larger than the stored excerpt.
 */
export function fallbackDiagnosticContent(extracted: unknown, body: unknown): string {
	const text =
		typeof extracted === 'string' && extracted.length > 0 ? extracted : JSON.stringify(body);
	return text.length > MALFORMED_OUTPUT_DIAGNOSTIC_MAX_CHARS
		? text.slice(0, MALFORMED_OUTPUT_DIAGNOSTIC_MAX_CHARS)
		: text;
}

export function parseRetryAfterMs(
	response: { headers?: { get?: (name: string) => string | null } } | null | undefined,
	outcome: string,
	nowMs = Date.now(),
): number | undefined {
	if (!RETRY_AFTER_ELIGIBLE_OUTCOMES.has(outcome)) return undefined;
	const header = response?.headers?.get?.('retry-after');
	if (!header) return undefined;
	const trimmed = header.trim();
	let ms: number;
	if (/^\d+$/.test(trimmed)) {
		ms = Number(trimmed) * 1000;
	} else {
		const parsed = Date.parse(trimmed);
		if (Number.isNaN(parsed)) return undefined;
		ms = parsed - nowMs;
	}
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
}

function safeInteger(value: unknown, name: string): void {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative safe integer`);
	}
}

export function validateAdapterRequest(requestInput: unknown): AdapterRequest {
	if (!requestInput || typeof requestInput !== 'object' || Array.isArray(requestInput)) {
		throw new TypeError('Adapter request must be an object');
	}
	const request = requestInput as AdapterRequest & Record<string, unknown>;
	const keys = new Set([
		'operationId',
		'attemptId',
		'prompt',
		'promptBlocks',
		'promptCacheBreakpoint',
		'structuredOutputSchema',
		'maxCompletionTokens',
		'signal',
	]);
	for (const key of Object.keys(request)) {
		if (!keys.has(key)) throw new TypeError(`Adapter request contains unknown key '${key}'`);
	}
	if (typeof request.operationId !== 'string' || !request.operationId) {
		throw new TypeError('operationId is required');
	}
	if (typeof request.attemptId !== 'string' || !request.attemptId) {
		throw new TypeError('attemptId is required');
	}
	if (typeof request.prompt !== 'string') throw new TypeError('prompt must be a string');
	if (request.promptBlocks !== undefined) {
		if (!Array.isArray(request.promptBlocks) || request.promptBlocks.length < 2) {
			throw new TypeError('promptBlocks must contain at least two strings');
		}
		for (const block of request.promptBlocks) {
			if (typeof block !== 'string' || block.length === 0) {
				throw new TypeError('promptBlocks must contain non-empty strings');
			}
		}
		if (request.promptBlocks.join('\n') !== request.prompt) {
			throw new TypeError('promptBlocks must join to prompt');
		}
	}
	if (request.promptCacheBreakpoint !== undefined) {
		if (!Array.isArray(request.promptBlocks)) {
			throw new TypeError('promptCacheBreakpoint requires promptBlocks');
		}
		safeInteger(request.promptCacheBreakpoint, 'promptCacheBreakpoint');
		if (request.promptCacheBreakpoint >= request.promptBlocks.length - 1) {
			throw new TypeError(
				'promptCacheBreakpoint must leave a trailing block outside the cache prefix',
			);
		}
	}
	if (
		!request.structuredOutputSchema ||
		typeof request.structuredOutputSchema !== 'object' ||
		Array.isArray(request.structuredOutputSchema)
	) {
		throw new TypeError('structuredOutputSchema must be an object');
	}
	safeInteger(request.maxCompletionTokens, 'maxCompletionTokens');
	if (!(request.signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
	return request;
}

const TOKEN_DETAIL_KEYS = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;

function validateTokenDetails(detailsInput: unknown): ProviderTokenDetails {
	if (!detailsInput || typeof detailsInput !== 'object' || Array.isArray(detailsInput)) {
		throw new TypeError('usage.tokenDetails must be an object');
	}
	const details = detailsInput as Record<string, unknown>;
	for (const key of Object.keys(details)) {
		if (!TOKEN_DETAIL_KEYS.includes(key as (typeof TOKEN_DETAIL_KEYS)[number])) {
			throw new TypeError(`usage.tokenDetails contains unknown key '${key}'`);
		}
	}
	for (const key of TOKEN_DETAIL_KEYS) {
		if (!Object.hasOwn(details, key)) throw new TypeError(`usage.tokenDetails.${key} is required`);
		if (details[key] === null) continue;
		safeInteger(details[key], `usage.tokenDetails.${key}`);
	}
	return Object.freeze({
		cacheReadTokens: details.cacheReadTokens as number | null,
		cacheWriteTokens: details.cacheWriteTokens as number | null,
		reasoningTokens: details.reasoningTokens as number | null,
	});
}

export function validateProviderUsage(usageInput: unknown): ProviderUsage {
	if (!usageInput || typeof usageInput !== 'object' || Array.isArray(usageInput)) {
		throw new TypeError('Provider usage must be an object');
	}
	const usage = usageInput as ProviderUsage & Record<string, unknown>;
	for (const key of Object.keys(usage)) {
		if (
			![
				'promptTokens',
				'completionTokens',
				'cacheReadTokens',
				'cacheWriteTokens',
				'premiumRequestUnits',
				'source',
				'tokenDetails',
			].includes(key)
		) {
			throw new TypeError(`Provider usage contains unknown key '${key}'`);
		}
	}
	safeInteger(usage.promptTokens, 'usage.promptTokens');
	safeInteger(usage.completionTokens, 'usage.completionTokens');
	if (usage.cacheReadTokens !== undefined) safeInteger(usage.cacheReadTokens, 'usage.cacheReadTokens');
	if (usage.cacheWriteTokens !== undefined) safeInteger(usage.cacheWriteTokens, 'usage.cacheWriteTokens');
	if (usage.premiumRequestUnits !== undefined) {
		safeInteger(usage.premiumRequestUnits, 'usage.premiumRequestUnits');
	}
	if (!['provider', 'estimated'].includes(usage.source)) throw new TypeError('usage.source is invalid');
	const tokenDetails = usage.tokenDetails === undefined ? undefined : validateTokenDetails(usage.tokenDetails);
	return Object.freeze({
		...usage,
		...(tokenDetails === undefined ? {} : { tokenDetails }),
	});
}

export function validateProviderRequestId(value: unknown): string | undefined {
	if (
		value !== undefined &&
		(typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value))
	) {
		throw new TypeError('providerRequestId is invalid');
	}
	return value as string | undefined;
}

export function validateProviderModelVersion(value: unknown): string | undefined {
	if (
		value !== undefined &&
		(typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
	) {
		throw new TypeError('providerModelVersion is invalid');
	}
	return value as string | undefined;
}

function validateDiagnostic(diagnosticInput: unknown): AdapterDiagnostic {
	if (!diagnosticInput || typeof diagnosticInput !== 'object' || Array.isArray(diagnosticInput)) {
		throw new TypeError('diagnostic must be an object');
	}
	const diagnostic = diagnosticInput as AdapterDiagnostic & Record<string, unknown>;
	for (const key of Object.keys(diagnostic)) {
		if (!['stage', 'content', 'truncated'].includes(key)) {
			throw new TypeError(`diagnostic contains unknown key '${key}'`);
		}
	}
	if (!DIAGNOSTIC_STAGES.has(diagnostic.stage)) {
		throw new TypeError('diagnostic.stage is invalid');
	}
	if (diagnostic.truncated !== undefined && typeof diagnostic.truncated !== 'boolean') {
		throw new TypeError('diagnostic.truncated must be boolean');
	}
	if (
		typeof diagnostic.content !== 'string' ||
		diagnostic.content.length > MAX_DIAGNOSTIC_CONTENT_CHARS
	) {
		throw new TypeError('diagnostic.content is invalid');
	}
	return Object.freeze({ ...diagnostic });
}

export function validateAdapterResult(resultInput: unknown): AdapterResult {
	if (!resultInput || typeof resultInput !== 'object' || Array.isArray(resultInput)) {
		throw new TypeError('Adapter result must be an object');
	}
	const result = resultInput as Record<string, unknown>;
	validateProviderRequestId(result.providerRequestId);
	validateProviderModelVersion(result.providerModelVersion);
	const usage = result.usage === undefined ? undefined : validateProviderUsage(result.usage);
	if (result.status === 'succeeded') {
		const allowed = new Set(['status', 'output', 'usage', 'providerRequestId', 'providerModelVersion']);
		for (const key of Object.keys(result)) {
			if (!allowed.has(key)) throw new TypeError(`Adapter success contains unknown key '${key}'`);
		}
		const succeeded = result as AdapterSuccessResult & Record<string, unknown>;
		return Object.freeze({ ...succeeded, usage });
	}
	if (result.status === 'failed') {
		const allowed = new Set([
			'status',
			'outcome',
			'usage',
			'providerRequestId',
			'providerModelVersion',
			'executionProvenFalse',
			'diagnostic',
			'retryAfterMs',
		]);
		for (const key of Object.keys(result)) {
			if (!allowed.has(key)) throw new TypeError(`Adapter failure contains unknown key '${key}'`);
		}
		if (typeof result.outcome !== 'string' || !OUTCOMES.has(result.outcome)) {
			throw new TypeError('Adapter outcome is invalid');
		}
		if (
			result.executionProvenFalse !== undefined &&
			typeof result.executionProvenFalse !== 'boolean'
		) {
			throw new TypeError('executionProvenFalse must be boolean');
		}
		if (result.executionProvenFalse === true && usage !== undefined) {
			throw new TypeError('executionProvenFalse cannot accompany provider usage');
		}
		if (result.diagnostic !== undefined && !DIAGNOSTIC_ELIGIBLE_OUTCOMES.has(result.outcome)) {
			throw new TypeError('diagnostic requires malformed_output, http_4xx, http_5xx, or quota');
		}
		if (
			result.retryAfterMs !== undefined &&
			(!RETRY_AFTER_ELIGIBLE_OUTCOMES.has(result.outcome) ||
				typeof result.retryAfterMs !== 'number' ||
				!Number.isSafeInteger(result.retryAfterMs) ||
				result.retryAfterMs <= 0 ||
				result.retryAfterMs > MAX_RETRY_AFTER_MS)
		) {
			throw new TypeError('retryAfterMs requires quota or http_5xx and a bounded positive integer');
		}
		const diagnostic =
			result.diagnostic === undefined ? undefined : validateDiagnostic(result.diagnostic);
		const failed = result as AdapterFailureResult & Record<string, unknown>;
		return Object.freeze({
			...failed,
			usage,
			...(diagnostic === undefined ? {} : { diagnostic }),
		});
	}
	throw new TypeError('Adapter result status is invalid');
}

/**
 * Robustly parse JSON from raw model text output, handling markdown code fences
 * and conversational preambles/postambles.
 */
export function parseModelJson(raw: unknown): unknown {
	if (typeof raw !== 'string') throw new TypeError('missing content');
	const trimmed = raw.trim();
	try {
		return JSON.parse(trimmed);
	} catch (err) {
		const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
		if (fenceMatch) {
			try {
				return JSON.parse(fenceMatch[1].trim());
			} catch {}
		}
		const startObj = trimmed.indexOf('{');
		const endObj = trimmed.lastIndexOf('}');
		if (startObj !== -1 && endObj > startObj) {
			try {
				return JSON.parse(trimmed.slice(startObj, endObj + 1));
			} catch {}
		}
		const startArr = trimmed.indexOf('[');
		const endArr = trimmed.lastIndexOf(']');
		if (startArr !== -1 && endArr > startArr) {
			try {
				return JSON.parse(trimmed.slice(startArr, endArr + 1));
			} catch {}
		}
		throw err;
	}
}
