import { ModelUsageError } from '../policy/errors.ts';
import type { EffectiveProfile, RoutingConstraints, RoutingStrategy } from '../policy/operation-request.ts';
import type { PolicyRoute } from '../policy/policy-route-catalog.ts';
import type { ModelUsagePolicy } from '../policy/policy-validation.ts';
import { calculatePrice } from './pricing.ts';

export interface RouteSelectionBudgetContext {
	estPromptTokens?: number;
	remainingRunCostMicrousd?: number;
}

export interface RouteSelectionResult {
	readonly routes: readonly Readonly<PolicyRoute>[];
	readonly effectiveStrategy: RoutingStrategy;
	readonly pressureActive: boolean;
}

export function selectRoutes(
	policy: Readonly<ModelUsagePolicy>,
	profile: EffectiveProfile,
	routingConstraints: RoutingConstraints = {},
	exhaustedRouteIds: readonly string[] = [],
	budgetContext: RouteSelectionBudgetContext = {},
): RouteSelectionResult {
	// Backward-compatible budget context normalization (AC-23)
	const estPromptTokens =
		typeof budgetContext?.estPromptTokens === 'number' &&
		Number.isSafeInteger(budgetContext.estPromptTokens) &&
		budgetContext.estPromptTokens >= 0
			? budgetContext.estPromptTokens
			: 0;

	const remainingRunCostMicrousd =
		typeof budgetContext?.remainingRunCostMicrousd === 'number' &&
		Number.isSafeInteger(budgetContext.remainingRunCostMicrousd) &&
		budgetContext.remainingRunCostMicrousd >= 0
			? budgetContext.remainingRunCostMicrousd
			: profile.limits.runMaxCostMicrousd;

	const required = new Set(routingConstraints?.requiredCapabilities ?? []);
	const excluded = new Set(
		(routingConstraints?.excludedVendors ?? []).map((value) => value.toLowerCase()),
	);
	const exhausted = new Set(exhaustedRouteIds ?? []);
	const allowed = new Set(profile.routeIds);

	// Step 1: Hard Invariant & Ceiling Filtering (Absolute — Never Bypassed)
	const candidates = policy.routes.filter((route) => {
		if (!allowed.has(route.id)) return false;
		if (!route.enabled) return false;
		if (['disabled', 'external-best-effort'].includes(route.classification)) return false;
		if (excluded.has(route.canonicalVendor.toLowerCase())) return false;
		if (exhausted.has(route.id)) return false;
		if (![...required].every((capability) => route.capabilities.includes(capability))) {
			return false;
		}

		// Quality tier floor
		if (
			routingConstraints?.minQualityTier !== undefined &&
			route.qualityTier < routingConstraints.minQualityTier
		) {
			return false;
		}

		// Ceiling Invariant (AC-20): exclude routes that cannot satisfy requested completion tokens
		if (route.limits.maxCompletionTokens < profile.limits.maxCompletionTokens) return false;

		return true;
	});

	if (candidates.length === 0) {
		throw new ModelUsageError(
			'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
			'No allowed model routes remain',
			{ reason: 'route-filtered-or-exhausted' },
		);
	}

	// Step 2: Affordability Gating (Hard Budget Invariant)
	const estimatedCosts = new Map<string, number>();
	for (const route of candidates) {
		const estPrice = calculatePrice({
			promptTokens: estPromptTokens,
			completionTokens: profile.limits.maxCompletionTokens,
			pricing: route.pricing,
			premiumRequestUnits: route.premiumRequestUnits,
			metered: route.metered,
		});
		const cost = estPrice.costMicrousd === 'unknown' ? 0 : estPrice.costMicrousd;
		estimatedCosts.set(route.id, cost);
	}

	const costOf = (routeId: string): number => estimatedCosts.get(routeId) ?? 0;

	const affordableRoutes = candidates.filter(
		(r) => costOf(r.id) <= remainingRunCostMicrousd,
	);

	let eligibleRoutes: PolicyRoute[];
	let minAffordableCost: number;
	let pressureActive: boolean;

	if (affordableRoutes.length > 0) {
		// Normal Case: Prune unaffordable routes (AC-07)
		eligibleRoutes = affordableRoutes;
		minAffordableCost = Math.min(...affordableRoutes.map((r) => costOf(r.id)));

		// Step 3: Runway State Classification
		const maxCost = profile.limits.runMaxCostMicrousd || 1;
		const runwayRatio = remainingRunCostMicrousd / maxCost;
		pressureActive =
			runwayRatio <= 0.3 || remainingRunCostMicrousd < 3 * minAffordableCost;
	} else {
		// No-Affordable-Route Case (AC-19): Retain candidates so governor denies with ERR_COST_BUDGET_EXCEEDED
		eligibleRoutes = candidates;
		minAffordableCost = Math.min(...candidates.map((r) => costOf(r.id)));
		pressureActive = true;
	}

	// Step 4: Deterministic Ordering & Effective Strategy Determination
	const policyRank = new Map(profile.routeIds.map((routeId, index) => [routeId, index]));
	const preferred = routingConstraints?.preferredRouteIds ?? [];
	const preferredRank = new Map(preferred.map((routeId, index) => [routeId, index]));

	const rankOf = (map: Map<string, number>, id: string): number => map.get(id) ?? 0;

	let effectiveStrategy: RoutingStrategy;

	if (pressureActive) {
		effectiveStrategy = 'min-cost';
		// Under runway pressure: sort strictly by ascending C_est; preferredRouteIds acts only as tie-breaker (AC-08)
		eligibleRoutes.sort((left, right) => {
			const costDiff = costOf(left.id) - costOf(right.id);
			if (costDiff !== 0) return costDiff;

			const leftPreferred = preferredRank.has(left.id);
			const rightPreferred = preferredRank.has(right.id);
			if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
			if (leftPreferred) return rankOf(preferredRank, left.id) - rankOf(preferredRank, right.id);

			return rankOf(policyRank, left.id) - rankOf(policyRank, right.id);
		});
	} else {
		effectiveStrategy = routingConstraints?.strategy ?? 'balanced';
		// Under healthy runway: preferredRouteIds rank first (AC-03)
		eligibleRoutes.sort((left, right) => {
			const leftPreferred = preferredRank.has(left.id);
			const rightPreferred = preferredRank.has(right.id);
			if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
			if (leftPreferred) return rankOf(preferredRank, left.id) - rankOf(preferredRank, right.id);

			if (effectiveStrategy === 'min-cost') {
				const costDiff = costOf(left.id) - costOf(right.id);
				if (costDiff !== 0) return costDiff;
				return rankOf(policyRank, left.id) - rankOf(policyRank, right.id);
			}

			if (effectiveStrategy === 'quality-first') {
				const tierDiff = (right.qualityTier ?? 1) - (left.qualityTier ?? 1);
				if (tierDiff !== 0) return tierDiff;
				const costDiff = costOf(left.id) - costOf(right.id);
				if (costDiff !== 0) return costDiff;
				return rankOf(policyRank, left.id) - rankOf(policyRank, right.id);
			}

			// Default 'balanced': policyRank order, tie-break by cost
			const rankDiff = rankOf(policyRank, left.id) - rankOf(policyRank, right.id);
			if (rankDiff !== 0) return rankDiff;
			return costOf(left.id) - costOf(right.id);
		});
	}

	return Object.freeze({
		routes: Object.freeze(
			eligibleRoutes.map((route) => Object.freeze(structuredClone(route))),
		),
		effectiveStrategy,
		pressureActive: pressureActive === true,
	});
}
