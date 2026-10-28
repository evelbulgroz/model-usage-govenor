/**
 * Read-only operation summaries and cumulative route exhaustion.
 * Totals come from ledger-budget.ts. This module does not lock or write.
 */
import type { LedgerEnvelope, LedgerRouteRef } from './ledger-attempt-validation.ts';
import { type LedgerAggregateTotals, totals } from './ledger-budget.ts';
import type { ModelUsagePolicy } from '../policy/policy-validation.ts';

export interface LedgerEnvelopeSummary {
	usageRecordIds: string[];
	attemptedRoutes: LedgerRouteRef[];
	operationTotal: LedgerAggregateTotals;
	runTotal: LedgerAggregateTotals;
	operationDeadlineAt: string | undefined;
	runDeadlineAt: string;
}

export function summarizeEnvelope(
	envelope: LedgerEnvelope,
	operationId: string,
): LedgerEnvelopeSummary {
	const operation = envelope.operations?.[operationId];
	const records = [...(envelope.attempts ?? []), ...(envelope.reservations ?? [])];
	const attemptedRoutes = (envelope.attempts ?? [])
		.filter((attempt) => attempt.operationId === operationId)
		.map((attempt) => ({
			routeId: attempt.routeId,
			provider: attempt.provider,
			model: attempt.model,
			canonicalVendor: attempt.canonicalVendor,
		}));
	const operationTotal = totals(records, (record) => record.operationId === operationId);
	const runTotal = totals(records);
	return {
		usageRecordIds: operation ? [...operation.usageRecordIds] : [],
		attemptedRoutes,
		operationTotal,
		runTotal,
		operationDeadlineAt: operation?.operationDeadlineAt,
		runDeadlineAt: envelope.runDeadlineAt,
	};
}

export function listExhaustedRouteIds(
	policy: Readonly<ModelUsagePolicy>,
	envelopes: readonly LedgerEnvelope[],
): string[] {
	const allRecords = envelopes.flatMap((candidate) => [...candidate.attempts, ...candidate.reservations]);
	const exhausted: string[] = [];
	for (const route of policy.routes) {
		if (!route.enabled || !route.limits) continue;
		const routeRecords = allRecords.filter((record) => record.routeId === route.id);
		const modelRecords = allRecords.filter(
			(record) => record.provider === route.provider && record.model === route.model,
		);
		const providerRecords = allRecords.filter((record) => record.provider === route.provider);
		for (const records of [routeRecords, modelRecords, providerRecords]) {
			const cumulative = totals(records);
			if (
				(route.limits.maxPhysicalCalls !== undefined && cumulative.physicalCalls + 1 > route.limits.maxPhysicalCalls) ||
				(route.limits.maxPremiumRequestUnits !== undefined && cumulative.premiumRequestUnits + (route.premiumRequestUnits ?? 0) > route.limits.maxPremiumRequestUnits) ||
				(route.limits.maxCostMicrousd !== undefined && cumulative.knownCostMicrousd > route.limits.maxCostMicrousd)
			) {
				exhausted.push(route.id);
				break;
			}
		}
	}
	return exhausted;
}
