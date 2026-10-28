/**
 * Route selection and reservation sizing shared by execute and assess.
 * assessReservation writes no reservation. This module does not import governor.ts.
 */
import crypto from 'node:crypto';
import { ModelUsageError } from '../policy/errors.ts';
import { calculateCounterfactualTier2Cost } from './governor-result.ts';
import {
	type LedgerCharge,
	type LedgerOperationRecord,
	ModelUsageLedger,
} from '../ledger/ledger.ts';
import {
	type EffectiveProfile,
	type ModelUsagePolicy,
	type NormalizedOperationRequest,
	type RoutingStrategy,
	effectiveProfile,
	loadPolicy,
	normalizedOperationInput,
	operationInputHash,
	validateOperationRequest,
} from '../policy/policy.ts';
import type { PolicyRoute } from '../policy/policy-route-catalog.ts';
import { calculateReservationPrice } from '../routing/pricing.ts';
import { selectRoutes } from '../routing/routing.ts';
import { matchesSchema, validateSchemaDefinition } from './structured-output-schema.ts';
import { type PromptTokenEstimate, estimatePromptTokens } from '../routing/tokenizer.ts';

export interface GovernorOptions {
	policyPath?: string;
	localPolicyPath?: string | null;
	defaultLocalPolicyPath?: string;
	machineLocalPolicyPath?: string | null;
	defaultMachineLocalPolicyPath?: string;
	stateRoot?: string;
	now?: () => Date;
	signal?: AbortSignal;
	backoffBaseDelayMs?: number;
	backoffJitter?: boolean;
}

export function beginGovernedRequest(
	requestInput: unknown,
	options: GovernorOptions,
): {
	request: NormalizedOperationRequest;
	policy: Readonly<ModelUsagePolicy>;
	profile: EffectiveProfile;
	inputHash: string;
	now: () => Date;
	ledger: ModelUsageLedger;
} {
	const request = normalizedOperationInput(validateOperationRequest(requestInput));
	validateSchemaDefinition(request.structuredOutputSchema);
	const policy = loadPolicy({
		policyPath: options.policyPath,
		localPolicyPath: options.localPolicyPath,
		defaultLocalPolicyPath: options.defaultLocalPolicyPath,
		machineLocalPolicyPath: options.machineLocalPolicyPath,
		defaultMachineLocalPolicyPath: options.defaultMachineLocalPolicyPath,
	});
	const profile = effectiveProfile(policy, request);
	const inputHash = operationInputHash(request);
	const now = options.now ?? (() => new Date());
	const ledger = new ModelUsageLedger({
		stateRoot: options.stateRoot,
		now,
	});
	return { request, policy, profile, inputHash, now, ledger };
}

export function readDurableOperation(
	ledger: ModelUsageLedger,
	request: NormalizedOperationRequest,
	inputHash: string,
): LedgerOperationRecord | undefined {
	try {
		return ledger.getOperation(request.runId, request.operationId, inputHash);
	} catch (error) {
		if (error instanceof ModelUsageError) throw error;
		throw new ModelUsageError(
			'ERR_USAGE_RECONCILIATION_FAILED',
			'Persisted model usage state failed validation',
			{ runId: request.runId, operationId: request.operationId, reason: 'invalid-ledger' },
			{ cause: error },
		);
	}
}

export function resolveRoutesForReservation(
	request: NormalizedOperationRequest,
	policy: Readonly<ModelUsagePolicy>,
	profile: EffectiveProfile,
	ledger: ModelUsageLedger,
): {
	routes: readonly Readonly<PolicyRoute>[];
	effectiveStrategy: RoutingStrategy;
	counterfactualTier2CostMicrousd: number | undefined;
} {
	const runBudget = ledger.getRunBudgetSummary(request.runId);
	let remainingRunCostMicrousd: number;
	if (runBudget === undefined || runBudget.runTotal.costMicrousd === 'unknown') {
		remainingRunCostMicrousd = profile.limits.runMaxCostMicrousd;
	} else {
		remainingRunCostMicrousd = Math.max(
			0,
			profile.limits.runMaxCostMicrousd - runBudget.runTotal.costMicrousd,
		);
	}

	const initialEstimate = estimatePromptTokens({
		prompt: request.prompt,
		structuredOutputSchema: request.structuredOutputSchema,
		routeFraming: '',
	});
	const estPromptTokens = initialEstimate.promptTokens;

	if (estPromptTokens > profile.limits.maxPromptTokens) {
		throw new ModelUsageError(
			'ERR_TOKEN_BUDGET_EXCEEDED',
			'Prompt estimate exceeds profile ceiling',
			{
				dimension: 'maxPromptTokens',
				requested: estPromptTokens,
				limit: profile.limits.maxPromptTokens,
				operationId: request.operationId,
				...(request.attribution?.taskId ? { taskId: request.attribution.taskId } : {}),
			},
		);
	}

	const allowedRoutes = policy.routes.filter(
		(r) => profile.routeIds.includes(r.id) && r.enabled,
	);
	if (
		allowedRoutes.length > 0 &&
		allowedRoutes.every(
			(r) => r.limits.maxCompletionTokens < profile.limits.maxCompletionTokens,
		)
	) {
		const maxLimit = Math.max(...allowedRoutes.map((r) => r.limits.maxCompletionTokens));
		throw new ModelUsageError(
			'ERR_TOKEN_BUDGET_EXCEEDED',
			'Completion ceiling exceeds route ceiling',
			{
				dimension: 'maxCompletionTokens',
				requested: profile.limits.maxCompletionTokens,
				limit: maxLimit,
				operationId: request.operationId,
				...(request.attribution?.taskId ? { taskId: request.attribution.taskId } : {}),
			},
		);
	}
	if (
		allowedRoutes.length > 0 &&
		allowedRoutes.every((r) => r.limits.maxPromptTokens < estPromptTokens)
	) {
		const maxLimit = Math.max(...allowedRoutes.map((r) => r.limits.maxPromptTokens));
		throw new ModelUsageError(
			'ERR_TOKEN_BUDGET_EXCEEDED',
			'Prompt estimate exceeds route ceiling',
			{
				dimension: 'maxPromptTokens',
				requested: estPromptTokens,
				limit: maxLimit,
				operationId: request.operationId,
				...(request.attribution?.taskId ? { taskId: request.attribution.taskId } : {}),
			},
		);
	}

	const budgetContext = {
		estPromptTokens,
		remainingRunCostMicrousd,
	};
	const exhaustedRouteIds = ledger.getExhaustedRouteIds?.(policy) ?? [];
	const { routes, effectiveStrategy } = selectRoutes(
		policy,
		profile,
		request.routingConstraints,
		exhaustedRouteIds,
		budgetContext,
	);
	const counterfactualTier2CostMicrousd = calculateCounterfactualTier2Cost({
		policy,
		profile,
		request,
		estPromptTokens,
	});
	return { routes, effectiveStrategy, counterfactualTier2CostMicrousd };
}

export function reservationChargeForRoute(
	request: NormalizedOperationRequest,
	profile: EffectiveProfile,
	route: PolicyRoute,
): {
	estimate: PromptTokenEstimate;
	completionTokens: number;
	reservationCharge: LedgerCharge;
} {
	const estimate = estimatePromptTokens({
		prompt: request.prompt,
		structuredOutputSchema: request.structuredOutputSchema,
		routeFraming: route.framing ?? '',
	});
	const completionTokens = profile.limits.maxCompletionTokens;
	if (estimate.promptTokens > Math.min(profile.limits.maxPromptTokens, route.limits.maxPromptTokens)) {
		throw new ModelUsageError('ERR_TOKEN_BUDGET_EXCEEDED', 'Prompt estimate exceeds route ceiling', {
			dimension: 'maxPromptTokens',
			routeId: route.id,
			requested: estimate.promptTokens,
			limit: Math.min(profile.limits.maxPromptTokens, route.limits.maxPromptTokens),
			operationId: request.operationId,
			...(request.attribution?.taskId ? { taskId: request.attribution.taskId } : {}),
		});
	}
	if (completionTokens > route.limits.maxCompletionTokens) {
		throw new ModelUsageError(
			'ERR_TOKEN_BUDGET_EXCEEDED',
			'Requested completion ceiling exceeds route ceiling',
			{
				dimension: 'maxCompletionTokens',
				routeId: route.id,
				requested: completionTokens,
				limit: route.limits.maxCompletionTokens,
				operationId: request.operationId,
				...(request.attribution?.taskId ? { taskId: request.attribution.taskId } : {}),
			},
		);
	}
	const attemptTotalTokens = estimate.promptTokens + completionTokens;
	const totalTokenLimit = Math.min(profile.limits.maxTotalTokens, route.limits.maxTotalTokens);
	if (attemptTotalTokens > totalTokenLimit) {
		throw new ModelUsageError(
			'ERR_TOKEN_BUDGET_EXCEEDED',
			'Attempt token reservation exceeds route or operation ceiling',
			{
				dimension: 'maxTotalTokens',
				routeId: route.id,
				requested: attemptTotalTokens,
				limit: totalTokenLimit,
				operationId: request.operationId,
				...(request.attribution?.taskId ? { taskId: request.attribution.taskId } : {}),
			},
		);
	}
	const cacheWriteEligible =
		Array.isArray(request.promptBlocks) &&
		request.promptBlocks.length >= 2 &&
		Number.isSafeInteger(route.pricing?.cacheReadMicrousdPerMillionTokens) &&
		Number.isSafeInteger(route.pricing?.cacheWrite5mMicrousdPerMillionTokens);
	// A cold cache writes the whole prefix above the base input rate. Reserve the write.
	const price = calculateReservationPrice({
		promptTokens: estimate.promptTokens,
		completionTokens,
		pricing: route.pricing,
		cacheWriteEligible,
		premiumRequestUnits: route.premiumRequestUnits,
		metered: route.metered,
		hardCostCeiling: route.metered,
	});
	return {
		estimate,
		completionTokens,
		reservationCharge: {
			promptTokens: estimate.promptTokens,
			completionTokens,
			totalTokens: attemptTotalTokens,
			physicalCalls: 1,
			costMicrousd: price.costMicrousd,
			premiumRequestUnits: price.premiumRequestUnits,
		},
	};
}

/**
 * Decide whether one selected route can reserve this request.
 * Uses the same charge and ledger gates as executeOperation and writes nothing.
 */
export async function assessReservation(
	requestInput: unknown,
	options: GovernorOptions = {},
): Promise<{ schemaVersion: '1.0.0'; fits: true }> {
	const { request, policy, profile, inputHash, ledger } = beginGovernedRequest(requestInput, options);
	const existing = readDurableOperation(ledger, request, inputHash);
	if (existing) {
		if (!matchesSchema(existing.output, request.structuredOutputSchema)) {
			throw new ModelUsageError(
				'ERR_USAGE_RECONCILIATION_FAILED',
				'Persisted operation output no longer satisfies the requested schema',
				{ runId: request.runId, operationId: request.operationId, reason: 'invalid-replay-output' },
			);
		}
		return { schemaVersion: '1.0.0', fits: true };
	}
	const { routes, effectiveStrategy, counterfactualTier2CostMicrousd } = resolveRoutesForReservation(
		request,
		policy,
		profile,
		ledger,
	);
	let failovers = 0;
	let routeAttempted = false;
	let lastFailure: ModelUsageError | undefined;
	for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
		if (routeAttempted) {
			failovers += 1;
			routeAttempted = false;
			if (failovers > profile.limits.maxFailovers) break;
		}
		const route = routes[routeIndex];
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
				routeAttempted = true;
				continue;
			}
			throw preReserveError;
		}
		try {
			ledger.reserveAttempt({
				policy,
				profile,
				route,
				request,
				inputHash,
				ownerToken: crypto.randomUUID(),
				reservation: charged.reservationCharge,
				estimator: charged.estimate.estimator,
				retryIndex: 0,
				failoverIndex: failovers,
				attemptTimeoutMs: Math.min(route.limits.attemptTimeoutMs, profile.limits.operationTimeoutMs),
				effectiveStrategy,
				counterfactualTier2CostMicrousd,
				dryRun: true,
			});
			return { schemaVersion: '1.0.0', fits: true };
		} catch (error) {
			if (
				error instanceof ModelUsageError &&
				['route', 'model', 'provider'].includes(String(error.metadata?.reason ?? '')) &&
				routeIndex + 1 < routes.length &&
				failovers < profile.limits.maxFailovers
			) {
				lastFailure = error;
				routeAttempted = true;
				continue;
			}
			throw error;
		}
	}
	throw (
		lastFailure ??
		new ModelUsageError('ERR_ALL_ALLOWED_ROUTES_EXHAUSTED', 'All allowed model routes exhausted', {
			operationId: request.operationId,
			runId: request.runId,
		})
	);
}
