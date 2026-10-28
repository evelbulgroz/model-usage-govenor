/**
 * Pure budget totals, admission, and reconciled charge assembly.
 * The ledger facade calls these between lock acquisitions. No I/O.
 */
import { ModelUsageError, type ModelUsageErrorCode } from '../policy/errors.ts';
import type {
	LedgerAttemptRecord,
	LedgerCharge,
	LedgerEnvelope,
	LedgerReservationRecord,
	LedgerTokenDetails,
	RemainingRunBudget,
	RunLimitSnapshot,
} from './ledger-attempt-validation.ts';
import type { EffectiveProfile, NormalizedOperationRequest } from '../policy/operation-request.ts';
import type { PolicyRoute } from '../policy/policy-route-catalog.ts';
import type { ModelUsagePolicy } from '../policy/policy-validation.ts';
import { calculatePrice } from '../routing/pricing.ts';

export type LedgerUsageRecord = LedgerAttemptRecord | LedgerReservationRecord;

export interface LedgerAggregateTotals {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	physicalCalls: number;
	costMicrousd: number | 'unknown';
	knownCostMicrousd: number;
	premiumRequestUnits: number;
	concurrency: number;
}

export interface EnforcementLimits {
	maxTotalTokens?: number;
	maxPhysicalCalls?: number;
	maxCostMicrousd?: number;
	maxPremiumRequestUnits?: number;
}

export function clone<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

export function addCharge(total: LedgerAggregateTotals, charge: LedgerCharge): LedgerAggregateTotals {
	for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'physicalCalls', 'premiumRequestUnits'] as const) {
		total[key] += charge[key];
		if (!Number.isSafeInteger(total[key])) throw new RangeError('Ledger aggregate overflow');
	}
	if (charge.costMicrousd === 'unknown') {
		total.costMicrousd = 'unknown';
	} else {
		total.knownCostMicrousd += charge.costMicrousd;
		if (!Number.isSafeInteger(total.knownCostMicrousd)) {
			throw new RangeError('Ledger cost aggregate overflow');
		}
		if (total.costMicrousd !== 'unknown') total.costMicrousd = total.knownCostMicrousd;
	}
	return total;
}

export function totals<T extends { charge: LedgerCharge }>(
	records: readonly T[],
	predicate: (record: T) => boolean = () => true,
): LedgerAggregateTotals {
	const total: LedgerAggregateTotals = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		physicalCalls: 0,
		costMicrousd: 0,
		knownCostMicrousd: 0,
		premiumRequestUnits: 0,
		concurrency: 0,
	};
	for (const record of records) {
		if (predicate(record)) addCharge(total, record.charge);
	}
	return total;
}

export function recordsForRunProfile<T extends { profile: string }>(
	records: readonly T[],
	profile: string,
): T[] {
	return records.filter((record) => record.profile === profile);
}

export function projectRemainingRunBudget(
	records: readonly { charge: LedgerCharge }[],
	limits: RunLimitSnapshot,
): RemainingRunBudget {
	const total = totals(records);
	return {
		totalTokens: Math.max(0, limits.maxTotalTokens - total.totalTokens),
		physicalCalls: Math.max(0, limits.maxPhysicalCalls - total.physicalCalls),
		costMicrousd:
			total.costMicrousd === 'unknown'
				? 'unknown'
				: Math.max(0, limits.maxCostMicrousd - total.costMicrousd),
		premiumRequestUnits: Math.max(
			0,
			limits.maxPremiumRequestUnits - total.premiumRequestUnits,
		),
	};
}

export function errorForDimension(
	dimension: string,
	limit: number,
	requested: number | 'unknown',
	metadata: Record<string, unknown> = {},
): ModelUsageError {
	const code: ModelUsageErrorCode =
		dimension === 'totalTokens'
			? 'ERR_TOKEN_BUDGET_EXCEEDED'
			: dimension === 'physicalCalls'
				? 'ERR_CALL_BUDGET_EXCEEDED'
				: dimension === 'costMicrousd'
					? 'ERR_COST_BUDGET_EXCEEDED'
					: dimension === 'concurrency'
						? 'ERR_CONCURRENCY_LIMIT'
						: 'ERR_BUDGET_RESERVATION_DENIED';
	return new ModelUsageError(code, `Budget reservation exceeds ${dimension}`, {
		dimension,
		limit,
		requested,
		...metadata,
	});
}

export function enforce(
	total: Pick<
		LedgerAggregateTotals,
		'totalTokens' | 'physicalCalls' | 'costMicrousd' | 'knownCostMicrousd' | 'premiumRequestUnits'
	>,
	charge: LedgerCharge,
	limits: EnforcementLimits,
	metadata: Record<string, unknown>,
): void {
	const dimensions: ReadonlyArray<
		[
			'totalTokens' | 'physicalCalls' | 'costMicrousd' | 'premiumRequestUnits',
			number | undefined,
		]
	> = [
		['totalTokens', limits.maxTotalTokens],
		['physicalCalls', limits.maxPhysicalCalls],
		['costMicrousd', limits.maxCostMicrousd],
		['premiumRequestUnits', limits.maxPremiumRequestUnits],
	];
	for (const [dimension, limit] of dimensions) {
		if (limit === undefined) continue;
		const current = total[dimension];
		const requested = charge[dimension];
		if (requested === 'unknown') {
			if (dimension === 'costMicrousd' && metadata.allowUnknownCost === true) continue;
			throw errorForDimension(dimension, limit, requested, {
				...metadata,
				reason: 'unknown-pricing',
				remaining: Math.max(0, limit - total.knownCostMicrousd),
			});
		}
		const enforceableCurrent =
			dimension === 'costMicrousd' || current === 'unknown' ? total.knownCostMicrousd : current;
		if (enforceableCurrent + requested > limit) {
			throw errorForDimension(dimension, limit, enforceableCurrent + requested, {
				...metadata,
				remaining: Math.max(0, limit - enforceableCurrent),
			});
		}
	}
}

export function assertReservationAdmissible({
	envelopes,
	envelope,
	request,
	profile,
	route,
	reservation,
	policy,
}: {
	envelopes: readonly LedgerEnvelope[];
	envelope: LedgerEnvelope;
	request: NormalizedOperationRequest;
	profile: EffectiveProfile;
	route: PolicyRoute;
	reservation: LedgerCharge;
	policy: Readonly<ModelUsagePolicy>;
}): void {
	const allRecords = envelopes.flatMap((candidate) => [...candidate.attempts, ...candidate.reservations]);
	const runRecords = [...envelope.attempts, ...envelope.reservations];
	const operationRecords = runRecords.filter((record) => record.operationId === request.operationId);
	const routeRecords = allRecords.filter((record) => record.routeId === route.id);
	const modelRecords = allRecords.filter(
		(record) => record.provider === route.provider && record.model === route.model,
	);
	const providerRecords = allRecords.filter((record) => record.provider === route.provider);
	const profileRecords = runRecords.filter((record) => record.profile === request.profile);
	const budgetMetadata = {
		allowUnknownCost: !route.metered,
		...(request.operationId ? { operationId: request.operationId } : {}),
		...(request.attribution?.taskId ? { taskId: request.attribution.taskId } : {}),
		...(request.taskId ? { taskId: request.taskId } : {}),
	};
	enforce(totals(operationRecords), reservation, {
		maxTotalTokens: profile.limits.maxTotalTokens,
		maxPhysicalCalls: profile.limits.maxPhysicalAttempts,
		maxCostMicrousd: profile.limits.runMaxCostMicrousd,
		maxPremiumRequestUnits: profile.limits.runMaxPremiumRequestUnits,
	}, { operationId: request.operationId, ...budgetMetadata });
	// This ceiling counts the requesting profile. The instance enforce below caps every profile.
	enforce(totals(profileRecords), reservation, {
		maxTotalTokens: profile.limits.runMaxTotalTokens,
		maxPhysicalCalls: profile.limits.runMaxPhysicalCalls,
		maxCostMicrousd: profile.limits.runMaxCostMicrousd,
		maxPremiumRequestUnits: profile.limits.runMaxPremiumRequestUnits,
	}, { profile: request.profile, runId: request.runId, ...budgetMetadata });
	for (const [records, dimension] of [
		[routeRecords, 'route'],
		[modelRecords, 'model'],
		[providerRecords, 'provider'],
	] as const) {
		const cumulative = totals(records);
		enforce(
			{
				totalTokens: 0,
				physicalCalls: cumulative.physicalCalls,
				costMicrousd: cumulative.costMicrousd,
				knownCostMicrousd: cumulative.knownCostMicrousd,
				premiumRequestUnits: cumulative.premiumRequestUnits,
			},
			reservation,
			route.limits,
			{
				routeId: route.id,
				provider: route.provider,
				model: route.model,
				reason: dimension,
				...budgetMetadata,
			},
		);
	}
	enforce(totals(allRecords), reservation, policy.instance, {
		reason: 'instance',
		...budgetMetadata,
	});
	const activeRun = runRecords.filter((record) => 'deadlineAt' in record).length;
	if (activeRun + 1 > profile.limits.maxConcurrentOperations) {
		throw errorForDimension('concurrency', profile.limits.maxConcurrentOperations, activeRun + 1, {
			runId: request.runId,
			remaining: Math.max(0, profile.limits.maxConcurrentOperations - activeRun),
		});
	}
	for (const [active, reason] of [
		[routeRecords.filter((record) => 'deadlineAt' in record).length, 'route'],
		[modelRecords.filter((record) => 'deadlineAt' in record).length, 'model'],
		[providerRecords.filter((record) => 'deadlineAt' in record).length, 'provider'],
	] as const) {
		if (active + 1 > route.limits.maxConcurrentReservations) {
			throw errorForDimension(
				'concurrency',
				route.limits.maxConcurrentReservations,
				active + 1,
				{
					routeId: route.id,
					reason,
					remaining: Math.max(0, route.limits.maxConcurrentReservations - active),
				},
			);
		}
	}
	const activeInstance = allRecords.filter((record) => 'deadlineAt' in record).length;
	if (activeInstance + 1 > policy.instance.maxConcurrentReservations) {
		throw errorForDimension(
			'concurrency',
			policy.instance.maxConcurrentReservations,
			activeInstance + 1,
			{
				reason: 'instance',
				remaining: Math.max(
					0,
					policy.instance.maxConcurrentReservations - activeInstance,
				),
			},
		);
	}
}

export interface ReconcileResultInput {
	status: 'succeeded' | 'failed';
	outcome?: string;
	output?: unknown;
	providerRequestId?: string;
	providerModelVersion?: string;
	executionProvenFalse?: boolean;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		premiumRequestUnits?: number;
		source: 'provider' | 'estimated';
		tokenDetails?: LedgerTokenDetails;
	};
}

export function assembleReconciledCharge({
	result,
	reservation,
	route,
}: {
	result: ReconcileResultInput;
	reservation: LedgerReservationRecord;
	route: PolicyRoute;
}): { charge: LedgerCharge; usageSource: string } {
	let charge: LedgerCharge;
	if (result.usage?.source === 'provider') {
		const cacheReadTokens = result.usage.cacheReadTokens ?? 0;
		const cacheWriteTokens = result.usage.cacheWriteTokens ?? 0;
		const promptTokens = result.usage.promptTokens + cacheReadTokens + cacheWriteTokens;
		const price = calculatePrice({
			promptTokens: result.usage.promptTokens,
			cacheReadTokens,
			cacheWriteTokens,
			completionTokens: result.usage.completionTokens,
			pricing: route.pricing,
			premiumRequestUnits:
				result.usage.premiumRequestUnits ?? reservation.charge.premiumRequestUnits,
			metered: route.metered,
			hardCostCeiling: route.metered,
		});
		charge = {
			promptTokens,
			completionTokens: result.usage.completionTokens,
			totalTokens: promptTokens + result.usage.completionTokens,
			physicalCalls: 1,
			costMicrousd: price.costMicrousd,
			premiumRequestUnits: price.premiumRequestUnits,
		};
	} else if (result.executionProvenFalse === true) {
		charge = {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			physicalCalls: 1,
			costMicrousd: 0,
			premiumRequestUnits: 0,
		};
	} else {
		charge = reservation.charge;
	}
	const usageSource = result.usage?.source ?? 'estimated';
	return { charge, usageSource };
}
