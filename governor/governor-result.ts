/**
 * GovernorResult assembly, including replayed and fresh success results.
 * Schema version stays 1.0.0. Counterfactual Tier-2 cost is null when no Tier-2 route fits.
 */
import type { LedgerRouteRef } from '../ledger/ledger-attempt-validation.ts';
import type { LedgerEnvelopeSummary, LedgerOperationRecord } from '../ledger/ledger.ts';
import type { EffectiveProfile, NormalizedOperationRequest } from '../policy/operation-request.ts';
import type { ModelUsagePolicy } from '../policy/policy-validation.ts';
import { calculatePrice } from '../routing/pricing.ts';

export interface RemainingBudgetSnapshot {
	remainingOperationTokens: number;
	remainingRunTokens: number;
	remainingOperationPhysicalAttempts: number;
	remainingOperationDurationMs: number;
	remainingRunDurationMs: number;
	remainingRunCostMicrousd?: number;
	remainingRunPremiumRequestUnits: number;
}

export interface GovernorResult {
	readonly schemaVersion: '1.0.0';
	readonly status: 'succeeded';
	readonly replayed: boolean;
	readonly operationId: string;
	readonly runId: string;
	readonly consumer: string;
	readonly profile: string;
	readonly output: unknown;
	readonly route: Readonly<LedgerRouteRef>;
	readonly attempts: number;
	readonly attemptedRoutes: readonly Readonly<LedgerRouteRef>[];
	readonly usageRecordIds: readonly string[];
	readonly remainingBudget: Readonly<RemainingBudgetSnapshot>;
	readonly effectiveStrategy: string;
	readonly selectedQualityTier?: number;
	readonly counterfactualTier2CostMicrousd?: number;
}

export function remainingResult(
	profile: EffectiveProfile,
	summary: LedgerEnvelopeSummary,
	now: Date,
): Readonly<RemainingBudgetSnapshot> {
	const operationTokens = summary.operationTotal.totalTokens;
	const runTokens = summary.runTotal.totalTokens;
	const operationCalls = summary.operationTotal.physicalCalls;
	const result: RemainingBudgetSnapshot = {
		remainingOperationTokens: Math.max(0, profile.limits.maxTotalTokens - operationTokens),
		remainingRunTokens: Math.max(0, profile.limits.runMaxTotalTokens - runTokens),
		remainingOperationPhysicalAttempts: Math.max(
			0,
			profile.limits.maxPhysicalAttempts - operationCalls,
		),
		remainingOperationDurationMs: Math.max(
			0,
			Date.parse(summary.operationDeadlineAt ?? '') - now.getTime(),
		),
		remainingRunDurationMs: Math.max(0, Date.parse(summary.runDeadlineAt) - now.getTime()),
		remainingRunPremiumRequestUnits: Math.max(
			0,
			profile.limits.runMaxPremiumRequestUnits - summary.runTotal.premiumRequestUnits,
		),
	};
	if (summary.runTotal.costMicrousd !== 'unknown') {
		result.remainingRunCostMicrousd = Math.max(
			0,
			profile.limits.runMaxCostMicrousd - summary.runTotal.costMicrousd,
		);
	}
	return Object.freeze(result);
}

export function calculateCounterfactualTier2Cost({
	policy,
	profile,
	request,
	estPromptTokens,
}: {
	policy: Readonly<ModelUsagePolicy>;
	profile: EffectiveProfile;
	request: NormalizedOperationRequest;
	estPromptTokens: number;
}): number | undefined {
	const required = new Set(request.routingConstraints?.requiredCapabilities ?? []);
	const excluded = new Set(
		(request.routingConstraints?.excludedVendors ?? []).map((v) => v.toLowerCase()),
	);
	const allowed = new Set(profile.routeIds);

	const tier2Candidates = policy.routes.filter((route) => {
		if (!allowed.has(route.id)) return false;
		if (!route.enabled) return false;
		if (['disabled', 'external-best-effort'].includes(route.classification)) return false;
		if (excluded.has(route.canonicalVendor.toLowerCase())) return false;
		if (![...required].every((cap) => route.capabilities.includes(cap))) return false;
		if (route.qualityTier !== 2) return false;

		// Token ceilings (AC-20)
		if (route.limits.maxPromptTokens < estPromptTokens) return false;
		if (route.limits.maxCompletionTokens < profile.limits.maxCompletionTokens) return false;
		const totalNeeded = estPromptTokens + profile.limits.maxCompletionTokens;
		const maxAllowedTotal = Math.min(
			profile.limits.maxTotalTokens,
			route.limits.maxTotalTokens,
		);
		if (totalNeeded > maxAllowedTotal) return false;

		return true;
	});

	if (tier2Candidates.length === 0) return undefined;

	let minCost: number | undefined;
	for (const route of tier2Candidates) {
		const price = calculatePrice({
			promptTokens: estPromptTokens,
			completionTokens: profile.limits.maxCompletionTokens,
			pricing: route.pricing,
			premiumRequestUnits: route.premiumRequestUnits,
			metered: route.metered,
		});
		if (price.costMicrousd === 'unknown') return undefined;
		if (minCost === undefined || price.costMicrousd < minCost) {
			minCost = price.costMicrousd;
		}
	}
	return minCost;
}

export function governorResult(
	request: NormalizedOperationRequest,
	operation: LedgerOperationRecord,
	summary: LedgerEnvelopeSummary,
	profile: EffectiveProfile,
	replayed: boolean,
	now: Date,
): GovernorResult {
	return Object.freeze({
		schemaVersion: '1.0.0',
		status: 'succeeded',
		replayed,
		operationId: request.operationId,
		runId: request.runId,
		consumer: request.consumer,
		profile: request.profile,
		output: structuredClone(operation.output),
		route: Object.freeze({
			routeId: operation.route?.routeId ?? '',
			provider: operation.route?.provider ?? '',
			model: operation.route?.model ?? '',
			canonicalVendor: operation.route?.canonicalVendor ?? '',
		}),
		attempts: summary.operationTotal.physicalCalls,
		attemptedRoutes: Object.freeze(
			summary.attemptedRoutes.map((route) => Object.freeze({ ...route })),
		),
		usageRecordIds: Object.freeze([...operation.usageRecordIds]),
		remainingBudget: remainingResult(profile, summary, now),
		effectiveStrategy: operation.effectiveStrategy ?? 'balanced',
		...(operation.selectedQualityTier !== undefined && operation.selectedQualityTier !== null
			? { selectedQualityTier: operation.selectedQualityTier }
			: {}),
		...(operation.counterfactualTier2CostMicrousd !== undefined &&
		operation.counterfactualTier2CostMicrousd !== null
			? { counterfactualTier2CostMicrousd: operation.counterfactualTier2CostMicrousd }
			: {}),
	});
}
