/**
 * Public governor facade. Live adapters are imported only here.
 * Retry, failover, and accounting stay in this family. Submodules do not import this file.
 */
import crypto from 'node:crypto';
import type { ModelAdapter } from '../adapters/adapter-contract.ts';
import { AnthropicModelAdapter } from '../adapters/anthropic.ts';
import { GoogleModelAdapter } from '../adapters/google.ts';
import { OpenAICompatibleModelAdapter } from '../adapters/openai-compatible.ts';
import { XaiModelAdapter } from '../adapters/xai.ts';
import { ProviderCircuitBreaker } from './circuit-breaker.ts';
import { writeMalformedOutputDiagnostic } from './diagnostics.ts';
import { ModelUsageError, type RouteEliminationEntry, asModelUsageError } from '../policy/errors.ts';
import {
	classifyAttemptOutcome,
	dispatchAttempt,
	linkedAttemptSignal,
	reservedFailoverTimeMs,
	sleep,
	terminalErrorFor,
	withRoutesEliminated,
} from './governor-attempt.ts';
import { type GovernorResult, governorResult } from './governor-result.ts';
import {
	type GovernorOptions,
	beginGovernedRequest,
	readDurableOperation,
	reservationChargeForRoute,
	resolveRoutesForReservation,
} from './governor-reservation.ts';
import type { ModelUsagePolicy } from '../policy/policy.ts';
import { matchesSchema } from './structured-output-schema.ts';

export { assessReservation, type GovernorOptions } from './governor-reservation.ts';
export type { GovernorResult } from './governor-result.ts';
export {
	assertStrictModeSchemaCompleteness,
	validateSchemaDefinition,
	type StructuredOutputSchema,
} from './structured-output-schema.ts';

const NON_RETRYABLE_COOLDOWN_OUTCOMES = new Set(['http_4xx']);

const NON_RETRYABLE_COOLDOWN_MS = 10_000;

export interface ExecuteOperationOptions extends GovernorOptions {
	circuitBreaker?: ProviderCircuitBreaker;
	adapters?: Map<string, ModelAdapter>;
}

function defaultAdapters(policy: Readonly<ModelUsagePolicy>): Map<string, ModelAdapter> {
	const adapters = new Map<string, ModelAdapter>();
	for (const route of policy.routes) {
		if (!route.enabled) continue;
		if (route.provider === 'anthropic') adapters.set(route.id, new AnthropicModelAdapter(route));
		if (route.provider === 'google') adapters.set(route.id, new GoogleModelAdapter(route));
		if (route.provider === 'openai-compatible') {
			adapters.set(route.id, new OpenAICompatibleModelAdapter(route));
		}
		if (route.provider === 'xai') adapters.set(route.id, new XaiModelAdapter(route));
	}
	return adapters;
}

export async function executeOperation(
	requestInput: unknown,
	options: ExecuteOperationOptions = {},
): Promise<GovernorResult> {
	const { request, policy, profile, inputHash, now, ledger } = beginGovernedRequest(
		requestInput,
		options,
	);
	const isTestEnv =
		process.env.NODE_ENV === 'test' ||
		Boolean(process.env.NODE_TEST_CONTEXT) ||
		process.execArgv.includes('--test') ||
		process.argv.includes('--test');
	const circuitBreaker =
		options.circuitBreaker ?? new ProviderCircuitBreaker({ stateRoot: options.stateRoot });
	const backoffBaseDelayMs =
		options.backoffBaseDelayMs ?? (isTestEnv ? 5 : 1000);
	const existingSchedule = circuitBreaker.getRetrySchedule(request.operationId);
	if (existingSchedule?.nextEligibleRetryAt) {
		const waitMs = Date.parse(existingSchedule.nextEligibleRetryAt) - now().getTime();
		if (waitMs > 0) {
			await sleep(waitMs, options.signal);
		}
		circuitBreaker.clearRetrySchedule(request.operationId);
	}
	const existing = readDurableOperation(ledger, request, inputHash);
	if (existing) {
		if (!matchesSchema(existing.output, request.structuredOutputSchema)) {
			throw new ModelUsageError(
				'ERR_USAGE_RECONCILIATION_FAILED',
				'Persisted operation output no longer satisfies the requested schema',
				{ runId: request.runId, operationId: request.operationId, reason: 'invalid-replay-output' },
			);
		}
		const summary = ledger.getRunSummary(request.runId, request.operationId);
		if (!summary) {
			throw new ModelUsageError(
				'ERR_USAGE_RECONCILIATION_FAILED',
				'Persisted operation summary is missing',
				{ runId: request.runId, operationId: request.operationId },
			);
		}
		return governorResult(request, existing, summary, profile, true, now());
	}
	const { routes, effectiveStrategy, counterfactualTier2CostMicrousd } = resolveRoutesForReservation(
		request,
		policy,
		profile,
		ledger,
	);

	const adapters = options.adapters ?? defaultAdapters(policy);
	const ownerToken = crypto.randomUUID();
	let attempts = 0;
	let failovers = 0;
	let routeAttemptedOrReserved = false;
	let lastFailure: unknown;
	const routesEliminated: RouteEliminationEntry[] = [];

	for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
		if (routeAttemptedOrReserved) {
			failovers += 1;
			routeAttemptedOrReserved = false;
			if (failovers > profile.limits.maxFailovers) break;
		}
		const route = routes[routeIndex];
		if (!circuitBreaker.isProviderAvailable(route.provider, now().getTime())) {
			const remainingRoutes = routes.slice(routeIndex + 1);
			const hasAlternative = remainingRoutes.some((r) =>
				circuitBreaker.isProviderAvailable(r.provider, now().getTime()),
			);
			if (hasAlternative) {
				lastFailure = new ModelUsageError(
					'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
					`Provider ${route.provider} is in circuit cooldown`,
					{
						routeId: route.id,
						provider: route.provider,
						outcome: 'circuit_cooldown',
					},
				);
				routesEliminated.push({
					routeId: route.id,
					provider: route.provider,
					outcome: 'circuit_cooldown',
					reason: 'circuit-cooldown',
				});
				continue;
			}
		}
		const adapter = adapters.get(route.id);
		if (!adapter || adapter.routeId !== route.id) {
			lastFailure = new ModelUsageError(
				'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
				'No adapter is available for an allowed route',
				{ routeId: route.id, reason: 'adapter-unavailable' },
			);
			routesEliminated.push({
				routeId: route.id,
				provider: route.provider,
				reason: 'adapter-unavailable',
			});
			continue;
		}
		let retryIndex = 0;
		while (attempts < profile.limits.maxPhysicalAttempts) {
			let charged: ReturnType<typeof reservationChargeForRoute>;
			try {
				charged = reservationChargeForRoute(request, profile, route);
			} catch (preReserveError) {
				if (
					preReserveError instanceof ModelUsageError &&
					routeIndex + 1 < routes.length &&
					failovers < profile.limits.maxFailovers
				) {
					lastFailure = preReserveError;
					routesEliminated.push({
						routeId: route.id,
						provider: route.provider,
						reason: preReserveError.metadata?.reason ?? 'pre-reservation-denied',
					});
					routeAttemptedOrReserved = true;
					break;
				}
				if (attempts > 0) {
					ledger.finalizeFailure(
						request.runId,
						request.operationId,
						asModelUsageError(
							preReserveError,
							'ERR_TOKEN_BUDGET_EXCEEDED',
							'Attempt pre-reservation check failed',
							{ runId: request.runId, operationId: request.operationId, routeId: route.id },
						),
					);
				}
				throw preReserveError;
			}
			const { estimate, completionTokens, reservationCharge } = charged;
			let reserved: ReturnType<typeof ledger.reserveAttempt>;
			try {
				reserved = ledger.reserveAttempt({
					policy,
					profile,
					route,
					request,
					inputHash,
					ownerToken,
					reservation: reservationCharge,
					estimator: estimate.estimator,
					retryIndex,
					failoverIndex: failovers,
					attemptTimeoutMs: Math.min(
						route.limits.attemptTimeoutMs,
						profile.limits.operationTimeoutMs,
					),
					effectiveStrategy,
					counterfactualTier2CostMicrousd,
				});
			} catch (error) {
				if (
					error instanceof ModelUsageError &&
					['route', 'model', 'provider'].includes(String(error.metadata.reason ?? '')) &&
					routeIndex + 1 < routes.length &&
					failovers < profile.limits.maxFailovers
				) {
					lastFailure = error;
					routesEliminated.push({
						routeId: route.id,
						provider: route.provider,
						reason: error.metadata?.reason ?? 'reservation-denied',
					});
					routeAttemptedOrReserved = true;
					break;
				}
				ledger.finalizeFailure(
					request.runId,
					request.operationId,
					asModelUsageError(
						error,
						'ERR_BUDGET_RESERVATION_DENIED',
						'Attempt reservation failed',
						{ runId: request.runId, operationId: request.operationId, routeId: route.id },
					),
				);
				throw error;
			}
			if (reserved.replay) {
				const summary = ledger.getRunSummary(request.runId, request.operationId);
				if (!summary) {
					throw new ModelUsageError(
						'ERR_USAGE_RECONCILIATION_FAILED',
						'Persisted operation summary is missing',
						{ runId: request.runId, operationId: request.operationId },
					);
				}
				return governorResult(request, reserved.replay, summary, profile, true, now());
			}
			if (!reserved.reservation || !reserved.operationDeadlineAt || !reserved.runDeadlineAt) {
				throw new ModelUsageError(
					'ERR_USAGE_RECONCILIATION_FAILED',
					'Reservation record incomplete',
					{ runId: request.runId, operationId: request.operationId },
				);
			}
			const activeReservation = reserved.reservation;
			const operationDeadlineAt = reserved.operationDeadlineAt;
			const runDeadlineAt = reserved.runDeadlineAt;
			attempts += 1;
			routeAttemptedOrReserved = true;
			const attemptStartedAt = now();
			const baseTimeoutMs = Math.max(
				1,
				Math.min(
					Date.parse(activeReservation.deadlineAt) - attemptStartedAt.getTime(),
					Date.parse(operationDeadlineAt) - attemptStartedAt.getTime(),
					Date.parse(runDeadlineAt) - attemptStartedAt.getTime(),
				),
			);
			const availableAlternativeRoutes = routes
				.slice(routeIndex + 1)
				.filter((candidate) =>
					circuitBreaker.isProviderAvailable(candidate.provider, attemptStartedAt.getTime()),
				);
			const availableAlternativeVendorCount = availableAlternativeRoutes.filter(
				(candidate) => candidate.provider !== route.provider,
			).length;
			const timeoutMs = Math.max(
				1,
				baseTimeoutMs -
					reservedFailoverTimeMs(
						baseTimeoutMs,
						profile,
						availableAlternativeRoutes.length,
						attempts,
						failovers,
					),
			);
			const linked = linkedAttemptSignal(options.signal, timeoutMs);
			const startedAt = attemptStartedAt.toISOString();
			let result = await dispatchAttempt({
				adapter,
				request,
				reserved: { reservation: activeReservation },
				completionTokens,
				linked,
			});
			if (
				result.status === 'succeeded' &&
				!matchesSchema(result.output, request.structuredOutputSchema)
			) {
				result = {
					status: 'failed',
					outcome: 'malformed_output',
					usage: result.usage,
					providerRequestId: result.providerRequestId,
					...(result.providerModelVersion
						? { providerModelVersion: result.providerModelVersion }
						: {}),
					diagnostic: {
						stage: 'schema-validation',
						content: JSON.stringify(result.output),
					},
				};
			}
			const completionTruncated =
				result.status === 'failed' && result.diagnostic?.truncated === true;
			let diagnosticRef: string | undefined;
			if (result.status === 'failed' && result.diagnostic !== undefined) {
				try {
					diagnosticRef = writeMalformedOutputDiagnostic({
						stateRoot: ledger.stateRoot,
						runId: request.runId,
						operationId: request.operationId,
						attemptId: activeReservation.attemptId,
						route,
						providerRequestId: result.providerRequestId,
						diagnostic: result.diagnostic,
						now: new Date(now().getTime()),
					});
				} catch (error) {
					console.error(
						`[model-usage] Failed to persist malformed-output diagnostic: ${(error as Error).message}`,
					);
				}
				const { diagnostic: _diagnostic, ...ledgerSafeResult } = result;
				result = ledgerSafeResult;
			}
			const completedAt = now().toISOString();
			const hasDispatchTimeRemaining =
				Date.parse(completedAt) < Date.parse(operationDeadlineAt) &&
				Date.parse(completedAt) < Date.parse(runDeadlineAt);
			const { canFailover, preferFailover, canRetry, terminal } = classifyAttemptOutcome({
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
			});
			const failure =
				result.status === 'failed'
					? terminalErrorFor(result, request, route, diagnosticRef, completionTruncated)
					: undefined;
			const reconciled = ledger.recordAttemptAndReconcile({
				runId: request.runId,
				operationId: request.operationId,
				reservationId: activeReservation.id,
				result,
				route,
				terminal,
				output: result.status === 'succeeded' ? result.output : undefined,
				failure,
				startedAt,
				completedAt,
			});
			if (result.status === 'succeeded') {
				circuitBreaker.recordProviderSuccess(route.provider);
				return governorResult(
					request,
					reconciled.operation,
					reconciled.summary,
					profile,
					false,
					now(),
				);
			}
			if (result.outcome === 'quota' || policy.retryableOutcomes.includes(result.outcome)) {
				circuitBreaker.recordProviderFailure(
					route.provider,
					result.outcome,
					now().getTime(),
					result.retryAfterMs ?? null,
				);
			} else if (NON_RETRYABLE_COOLDOWN_OUTCOMES.has(result.outcome)) {
				circuitBreaker.recordProviderFailure(
					route.provider,
					result.outcome,
					now().getTime(),
					NON_RETRYABLE_COOLDOWN_MS,
				);
			}
			lastFailure =
				failure ?? terminalErrorFor(result, request, route, diagnosticRef, completionTruncated);
			routesEliminated.push({
				routeId: route.id,
				provider: route.provider,
				outcome: result.outcome,
				reason: 'attempt-failed',
			});
			if (terminal === 'failed') {
				for (const unreached of routes.slice(routeIndex + 1)) {
					routesEliminated.push({
						routeId: unreached.id,
						provider: unreached.provider,
						reason: 'not-attempted-terminal-outcome',
					});
				}
				throw withRoutesEliminated(lastFailure, routesEliminated);
			}
			if (preferFailover || (canFailover && result.executionProvenFalse)) break;
			if (canRetry) {
				retryIndex += 1;
				const delayMs = circuitBreaker.calculateBackoffDelay(retryIndex, {
					baseDelayMs: backoffBaseDelayMs,
					maxDelayMs: 10_000,
					jitter: options.backoffJitter ?? !isTestEnv,
				});
				const nextEligibleRetryAt = new Date(now().getTime() + delayMs).toISOString();
				circuitBreaker.recordRetrySchedule(request.operationId, nextEligibleRetryAt, retryIndex);
				await sleep(delayMs, options.signal);
				circuitBreaker.clearRetrySchedule(request.operationId);
				continue;
			}
			break;
		}
	}
	const finalError =
		lastFailure ??
		new ModelUsageError('ERR_ALL_ALLOWED_ROUTES_EXHAUSTED', 'All allowed model routes exhausted', {
			operationId: request.operationId,
			runId: request.runId,
		});
	const finalErrorWithRoutes = asModelUsageError(
		withRoutesEliminated(finalError, routesEliminated),
		'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
		'All allowed model routes exhausted',
	);
	ledger.finalizeFailure(request.runId, request.operationId, finalErrorWithRoutes);
	throw finalErrorWithRoutes;
}
