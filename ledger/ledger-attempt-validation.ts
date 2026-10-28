/**
 * Synchronous checks for ledger charges, attempts, and reservations.
 * Envelope validation imports this module. It never imports ledger.ts.
 */
import type { SerializedModelUsageError } from '../policy/errors.ts';

export interface LedgerCharge {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	physicalCalls: number;
	costMicrousd: number | 'unknown';
	premiumRequestUnits: number;
}

export interface LedgerTokenDetails {
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	reasoningTokens: number | null;
}

export interface LedgerEstimator {
	name: string;
	version: string;
}

export interface RunLimitSnapshot {
	maxTotalTokens: number;
	maxPhysicalCalls: number;
	maxCostMicrousd: number;
	maxPremiumRequestUnits: number;
}

export interface RemainingRunBudget {
	totalTokens: number;
	physicalCalls: number;
	costMicrousd: number | 'unknown';
	premiumRequestUnits: number;
}

export interface LedgerRouteRef {
	routeId: string;
	provider: string;
	model: string;
	canonicalVendor: string;
}

export interface LedgerReservationRecord {
	id: string;
	attemptId: string;
	operationId: string;
	ownerToken: string;
	ownerPid: number;
	routeId: string;
	provider: string;
	model: string;
	canonicalVendor: string;
	routeClass: string;
	consumer: string;
	profile: string;
	reservedAt: string;
	deadlineAt: string;
	charge: LedgerCharge;
	estimator: LedgerEstimator;
	runLimitSnapshot: RunLimitSnapshot;
	retryIndex: number;
	failoverIndex: number;
	qualityTier?: number;
	effectiveStrategy?: string;
}

export interface LedgerAttemptRecord {
	id: string;
	usageRecordId: string;
	reservationId: string;
	attemptId: string;
	operationId: string;
	routeId: string;
	provider: string;
	model: string;
	canonicalVendor: string;
	routeClass: string;
	consumer: string;
	profile: string;
	retryIndex: number;
	failoverIndex: number;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	outcome: string;
	providerRequestId?: string;
	providerModelVersion?: string;
	reservationCharge: LedgerCharge;
	estimator: LedgerEstimator;
	executionProvenFalse: boolean;
	charge: LedgerCharge;
	usageSource: string;
	tokenDetails?: LedgerTokenDetails;
	pricingVersion: string;
	runLimitSnapshot: RunLimitSnapshot;
	remainingRunBudget: RemainingRunBudget;
	qualityTier?: number;
	effectiveStrategy?: string;
}

export interface LedgerOperationRecord {
	operationId?: string;
	inputHash: string;
	state: 'reserved' | 'active' | 'succeeded' | 'failed' | 'recovery_charged';
	consumer: string;
	profile: string;
	attribution: Record<string, unknown>;
	ownerToken: string;
	ownerPid: number;
	firstReservedAt: string;
	operationDeadlineAt: string;
	route?: LedgerRouteRef;
	output?: unknown;
	failure?: SerializedModelUsageError;
	usageRecordIds: string[];
	effectiveStrategy?: string;
	selectedQualityTier?: number | null;
	counterfactualTier2CostMicrousd?: number | null;
}

export interface LedgerEnvelope {
	schemaVersion: '1.0.0' | '1.1.0' | '1.2.0';
	runId: string;
	policyVersion: string;
	pricingVersion: string;
	createdAt: string;
	runDeadlineAt: string;
	operations: Record<string, LedgerOperationRecord>;
	reservations: LedgerReservationRecord[];
	attempts: LedgerAttemptRecord[];
}

const ESTIMATOR_KEYS = new Set(['name', 'version']);

const RUN_LIMIT_KEYS = new Set([
	'maxTotalTokens',
	'maxPhysicalCalls',
	'maxCostMicrousd',
	'maxPremiumRequestUnits',
]);

const REMAINING_RUN_BUDGET_KEYS = new Set([
	'totalTokens',
	'physicalCalls',
	'costMicrousd',
	'premiumRequestUnits',
]);

export function closed(value: unknown, keys: ReadonlySet<string>, name: string): void {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} invalid`);
	for (const key of Object.keys(value as Record<string, unknown>)) {
		if (!keys.has(key)) throw new TypeError(`${name} contains unknown key '${key}'`);
	}
}

export function required(value: unknown, keys: Iterable<string>, name: string): void {
	const rec = value as Record<string, unknown>;
	for (const key of keys) {
		if (!Object.hasOwn(rec, key)) throw new TypeError(`${name}.${key} is required`);
	}
}

export function nonnegative(value: unknown, name: string): void {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${name} invalid`);
	}
}

export function timestamp(value: unknown, name: string): void {
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
		throw new TypeError(`${name} invalid`);
	}
}

// One clock per runId: createdAt plus the longest reserving profile ceiling.
// A later shorter profile does not move the deadline earlier.

export function validateCharge(charge: LedgerCharge, name: string): void {
	const keys = new Set([
		'promptTokens',
		'completionTokens',
		'totalTokens',
		'physicalCalls',
		'costMicrousd',
		'premiumRequestUnits',
	]);
	closed(charge, keys, name);
	required(charge, keys, name);
	for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'physicalCalls', 'premiumRequestUnits'] as const) {
		nonnegative(charge[key], `${name}.${key}`);
	}
	if (charge.promptTokens + charge.completionTokens !== charge.totalTokens) {
		throw new TypeError(`${name} token total inconsistent`);
	}
	if (charge.costMicrousd !== 'unknown') nonnegative(charge.costMicrousd, `${name}.costMicrousd`);
}

export function validateTokenDetails(
	details: LedgerTokenDetails,
	charge: LedgerCharge,
	name: string,
): void {
	const keys = new Set(['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const);
	closed(details, keys, name);
	required(details, keys, name);
	for (const key of keys) {
		if (details[key] !== null) nonnegative(details[key], `${name}.${key}`);
	}
	let cacheTokens = 0;
	if (details.cacheReadTokens !== null) cacheTokens += details.cacheReadTokens;
	if (details.cacheWriteTokens !== null) cacheTokens += details.cacheWriteTokens;
	if (cacheTokens > charge.promptTokens) {
		throw new TypeError(`${name} cache tokens exceed charge.promptTokens`);
	}
	if (details.reasoningTokens !== null && details.reasoningTokens > charge.completionTokens) {
		throw new TypeError(`${name} reasoning tokens exceed charge.completionTokens`);
	}
}

export function validateEstimator(estimator: LedgerEstimator, name: string): void {
	closed(estimator, ESTIMATOR_KEYS, name);
	required(estimator, ESTIMATOR_KEYS, name);
	for (const key of ['name', 'version'] as const) {
		if (typeof estimator[key] !== 'string' || estimator[key].length === 0) {
			throw new TypeError(`${name}.${key} invalid`);
		}
	}
}

export function validateRunLimitSnapshot(limits: RunLimitSnapshot, name: string): void {
	closed(limits, RUN_LIMIT_KEYS, name);
	required(limits, RUN_LIMIT_KEYS, name);
	for (const key of ['maxTotalTokens', 'maxPhysicalCalls', 'maxCostMicrousd', 'maxPremiumRequestUnits'] as const) {
		nonnegative(limits[key], `${name}.${key}`);
	}
}

export function validateRemainingRunBudget(remaining: RemainingRunBudget, name: string): void {
	closed(remaining, REMAINING_RUN_BUDGET_KEYS, name);
	required(remaining, REMAINING_RUN_BUDGET_KEYS, name);
	for (const key of ['totalTokens', 'physicalCalls', 'premiumRequestUnits'] as const) {
		nonnegative(remaining[key], `${name}.${key}`);
	}
	if (remaining.costMicrousd !== 'unknown') {
		nonnegative(remaining.costMicrousd, `${name}.costMicrousd`);
	}
}

export function validateRouteRef(route: LedgerRouteRef | undefined, name: string): void {
	const keys = new Set(['routeId', 'provider', 'model', 'canonicalVendor']);
	closed(route, keys, name);
	required(route, keys, name);
	const rec = route as LedgerRouteRef;
	for (const key of ['routeId', 'provider', 'model', 'canonicalVendor'] as const) {
		if (typeof rec[key] !== 'string' || rec[key].length === 0) {
			throw new TypeError(`${name}.${key} invalid`);
		}
	}
}
