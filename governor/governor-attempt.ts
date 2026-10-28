/**
 * One physical attempt: timeout linking, adapter dispatch, and the next step.
 * dispatchAttempt calls the adapter only. Ledger writes stay in the caller, outside this call.
 */
import {
	type AdapterFailureResult,
	type AdapterResult,
	type ModelAdapter,
	validateAdapterResult,
} from '../adapters/adapter-contract.ts';
import { ModelUsageError, type RouteEliminationEntry } from '../policy/errors.ts';
import type { EffectiveProfile, NormalizedOperationRequest } from '../policy/operation-request.ts';
import type { PolicyRoute } from '../policy/policy-route-catalog.ts';
import type { ModelUsagePolicy } from '../policy/policy-validation.ts';

const FAILOVER_FIRST_OUTCOMES = new Set([
	'timeout',
	'http_5xx',
	'quota',
	'malformed_output',
]);

export interface LinkedAttemptSignal {
	signal: AbortSignal;
	aborted: Promise<AdapterFailureResult>;
	dispose(): void;
}

export function withRoutesEliminated(
	error: unknown,
	routesEliminated: readonly RouteEliminationEntry[],
): unknown {
	if (!(error instanceof ModelUsageError) || routesEliminated.length === 0) return error;
	return new ModelUsageError(
		error.code,
		error.message,
		{ ...error.metadata, routesEliminated },
		{ cause: error.cause },
	);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export function linkedAttemptSignal(
	externalSignal: AbortSignal | undefined,
	timeoutMs: number,
): LinkedAttemptSignal {
	const controller = new AbortController();
	const timeoutReason = new DOMException('Operation attempt timed out', 'TimeoutError');
	const timer = setTimeout(() => controller.abort(timeoutReason), timeoutMs);
	const aborted = new Promise<AdapterFailureResult>((resolve) => {
		controller.signal.addEventListener(
			'abort',
			() =>
				resolve({
					status: 'failed',
					outcome:
						(controller.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
							? 'timeout'
							: 'cancelled',
				}),
			{ once: true },
		);
	});
	const onAbort = () =>
		controller.abort(externalSignal?.reason ?? new DOMException('Operation cancelled', 'AbortError'));
	if (externalSignal) {
		if (externalSignal.aborted) onAbort();
		else externalSignal.addEventListener('abort', onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		aborted,
		dispose() {
			clearTimeout(timer);
			externalSignal?.removeEventListener('abort', onAbort);
		},
	};
}

export function reservedFailoverTimeMs(
	baseTimeoutMs: number,
	profile: EffectiveProfile,
	availableAlternativeCount: number,
	attempts: number,
	failovers: number,
): number {
	const reservableFailovers = Math.min(
		availableAlternativeCount,
		Math.max(0, profile.limits.maxFailovers - failovers),
		Math.max(0, profile.limits.maxPhysicalAttempts - attempts),
	);
	if (reservableFailovers === 0) return 0;
	const minimumFailoverWindowMs = Math.min(
		30_000,
		Math.max(
			1,
			Math.floor(profile.limits.operationTimeoutMs / (profile.limits.maxFailovers + 1)),
		),
	);
	return Math.min(
		Math.max(0, baseTimeoutMs - 1),
		reservableFailovers * minimumFailoverWindowMs,
	);
}

export function terminalErrorFor(
	result: { outcome?: string },
	request: NormalizedOperationRequest,
	route: PolicyRoute,
	diagnosticRef?: string,
	completionTruncated = false,
): ModelUsageError {
	const metadata = {
		operationId: request.operationId,
		runId: request.runId,
		routeId: route.id,
		outcome: result.outcome,
		...(completionTruncated ? { truncated: true } : {}),
		...(diagnosticRef ? { diagnosticRef } : {}),
	};
	if (result.outcome === 'timeout') {
		return new ModelUsageError('ERR_OPERATION_TIMEOUT', 'Model operation timed out', metadata);
	}
	return new ModelUsageError(
		'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
		'All allowed model routes failed',
		metadata,
	);
}

export async function dispatchAttempt({
	adapter,
	request,
	reserved,
	completionTokens,
	linked,
}: {
	adapter: ModelAdapter;
	request: NormalizedOperationRequest;
	reserved: { reservation: { attemptId: string } };
	completionTokens: number;
	linked: LinkedAttemptSignal;
}): Promise<AdapterResult> {
	let result: AdapterResult;
	try {
		if (linked.signal.aborted) {
			result = {
				status: 'failed',
				outcome:
					(linked.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
						? 'timeout'
						: 'cancelled',
				executionProvenFalse: true,
			};
		} else {
			const adapterOutcome: Promise<AdapterResult> = Promise.resolve()
				.then(() =>
					adapter.execute({
						operationId: request.operationId,
						attemptId: reserved.reservation.attemptId,
						prompt: request.prompt,
						...(request.promptBlocks ? { promptBlocks: request.promptBlocks } : {}),
						...(request.promptCacheBreakpoint !== undefined
							? { promptCacheBreakpoint: request.promptCacheBreakpoint }
							: {}),
						structuredOutputSchema: request.structuredOutputSchema,
						maxCompletionTokens: completionTokens,
						signal: linked.signal,
					}),
				)
				.then(validateAdapterResult)
				.catch(
					(): AdapterFailureResult => ({
						status: 'failed',
						outcome: linked.signal.aborted
							? (linked.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
								? 'timeout'
								: 'cancelled'
							: 'transport',
					}),
				);
			result = await Promise.race([adapterOutcome, linked.aborted]);
		}
	} catch {
		result = {
			status: 'failed',
			outcome: linked.signal.aborted
				? (linked.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
					? 'timeout'
					: 'cancelled'
				: 'transport',
		};
	} finally {
		linked.dispose();
	}
	return result;
}

export function classifyAttemptOutcome({
	result,
	policy,
	profile,
	routes,
	routeIndex,
	failovers,
	attempts,
	retryIndex,
	availableAlternativeVendorCount,
	hasDispatchTimeRemaining,
	completionTruncated,
}: {
	result: AdapterResult;
	policy: Readonly<ModelUsagePolicy>;
	profile: EffectiveProfile;
	routes: readonly PolicyRoute[];
	routeIndex: number;
	failovers: number;
	attempts: number;
	retryIndex: number;
	availableAlternativeVendorCount: number;
	hasDispatchTimeRemaining: boolean;
	completionTruncated: boolean;
}): {
	canFailover: boolean;
	preferFailover: boolean;
	canRetry: boolean;
	terminal: 'succeeded' | 'failed' | undefined;
} {
	const canFailover =
		result.status === 'failed' &&
		hasDispatchTimeRemaining &&
		(result.outcome === 'quota' || policy.retryableOutcomes.includes(result.outcome)) &&
		routeIndex + 1 < routes.length &&
		failovers < profile.limits.maxFailovers &&
		attempts < profile.limits.maxPhysicalAttempts;
	const preferFailover =
		canFailover &&
		result.status === 'failed' &&
		(result.outcome === 'quota' ||
			(availableAlternativeVendorCount > 0 &&
				FAILOVER_FIRST_OUTCOMES.has(result.outcome)));
	const canRetry =
		result.status === 'failed' &&
		hasDispatchTimeRemaining &&
		policy.retryableOutcomes.includes(result.outcome) &&
		retryIndex < profile.limits.maxRetriesPerRoute &&
		attempts < profile.limits.maxPhysicalAttempts &&
		!preferFailover &&
		// The same prompt under the same completion cap is cut off again.
		!completionTruncated;
	const terminal =
		result.status === 'succeeded'
			? 'succeeded'
			: canRetry
				? undefined
				: canFailover
					? undefined
					: 'failed';
	return { canFailover, preferFailover, canRetry, terminal };
}
