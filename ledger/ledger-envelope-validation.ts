/**
 * Envelope shape, schema versions 1.0.0 through 1.2.0, and cross-record links.
 * Pure and synchronous. Callers pass ids through operation-request.ts.
 */
import { ModelUsageError } from '../policy/errors.ts';
import {
	type LedgerAttemptRecord,
	type LedgerEnvelope,
	type LedgerOperationRecord,
	type LedgerReservationRecord,
	closed,
	nonnegative,
	required,
	timestamp,
	validateCharge,
	validateEstimator,
	validateRemainingRunBudget,
	validateRouteRef,
	validateRunLimitSnapshot,
	validateTokenDetails,
} from './ledger-attempt-validation.ts';
import { validateOperationId, validateRunId } from '../policy/operation-request.ts';

const ENVELOPE_KEYS = new Set([
	'schemaVersion',
	'runId',
	'policyVersion',
	'pricingVersion',
	'createdAt',
	'runDeadlineAt',
	'operations',
	'reservations',
	'attempts',
]);

const OPERATION_STATES = new Set(['reserved', 'active', 'succeeded', 'failed', 'recovery_charged']);

export function applyProfileRunDeadline(
	envelope: LedgerEnvelope,
	profile: { limits?: { runTimeoutMs?: number } } | null | undefined,
): boolean {
	const timeoutMs = profile?.limits?.runTimeoutMs;
	if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
		throw new TypeError('profile.limits.runTimeoutMs invalid');
	}
	const candidateMs = Date.parse(envelope.createdAt) + timeoutMs;
	if (candidateMs > Date.parse(envelope.runDeadlineAt)) {
		envelope.runDeadlineAt = new Date(candidateMs).toISOString();
		return true;
	}
	return false;
}

export function emptyEnvelope(
	runId: string,
	policy: { schemaVersion: string; pricingVersion: string },
	now: string,
	runDeadlineAt: string,
): LedgerEnvelope {
	return {
		schemaVersion: '1.2.0',
		runId,
		policyVersion: policy.schemaVersion,
		pricingVersion: policy.pricingVersion,
		createdAt: now,
		runDeadlineAt,
		operations: {},
		reservations: [],
		attempts: [],
	};
}

export function validateEnvelope(input: unknown, expectedRunId: string): LedgerEnvelope {
	closed(input, ENVELOPE_KEYS, 'ledger envelope');
	required(input, ENVELOPE_KEYS, 'ledger envelope');
	const envelope = input as LedgerEnvelope;
	if (!['1.0.0', '1.1.0', '1.2.0'].includes(envelope.schemaVersion)) {
		throw new TypeError('Unsupported ledger schemaVersion');
	}
	validateRunId(envelope.runId);
	if (envelope.runId !== expectedRunId) throw new TypeError('Ledger runId does not match filename');
	if (typeof envelope.policyVersion !== 'string' || typeof envelope.pricingVersion !== 'string') {
		throw new TypeError('Ledger policy versions invalid');
	}
	timestamp(envelope.createdAt, 'ledger.createdAt');
	timestamp(envelope.runDeadlineAt, 'ledger.runDeadlineAt');
	if (!envelope.operations || typeof envelope.operations !== 'object' || Array.isArray(envelope.operations)) {
		throw new TypeError('Ledger operations invalid');
	}
	for (const [operationId, rawOp] of Object.entries(envelope.operations)) {
		validateOperationId(operationId);
		const operation = rawOp as LedgerOperationRecord & Record<string, unknown>;
		const operationKeys = new Set([
			'inputHash',
			'state',
			'consumer',
			'profile',
			'attribution',
			'ownerToken',
			'ownerPid',
			'firstReservedAt',
			'operationDeadlineAt',
			'route',
			'output',
			'failure',
			'usageRecordIds',
			'effectiveStrategy',
			'selectedQualityTier',
			'counterfactualTier2CostMicrousd',
		]);
		closed(operation, operationKeys, `operation ${operationId}`);
		required(
			operation,
			new Set([
				'inputHash',
				'state',
				'consumer',
				'profile',
				'attribution',
				'ownerToken',
				'ownerPid',
				'firstReservedAt',
				'operationDeadlineAt',
				'usageRecordIds',
			]),
			`operation ${operationId}`,
		);
		if (!/^[a-f0-9]{64}$/.test(operation.inputHash)) throw new TypeError('Operation inputHash invalid');
		if (!OPERATION_STATES.has(operation.state)) throw new TypeError('Operation state invalid');
		if (typeof operation.consumer !== 'string' || typeof operation.profile !== 'string') {
			throw new TypeError('Operation attribution invalid');
		}
		if (
			!operation.attribution ||
			typeof operation.attribution !== 'object' ||
			Array.isArray(operation.attribution) ||
			typeof operation.ownerToken !== 'string' ||
			operation.ownerToken.length === 0
		) {
			throw new TypeError('Operation ownership invalid');
		}
		nonnegative(operation.ownerPid, 'operation.ownerPid');
		timestamp(operation.firstReservedAt, 'operation.firstReservedAt');
		timestamp(operation.operationDeadlineAt, 'operation.operationDeadlineAt');
		if (!Array.isArray(operation.usageRecordIds)) throw new TypeError('Operation usage IDs invalid');
		if (new Set(operation.usageRecordIds).size !== operation.usageRecordIds.length) {
			throw new TypeError('Operation usage IDs contain duplicates');
		}
		if (operation.route !== undefined) validateRouteRef(operation.route, `operation ${operationId}.route`);
		if (operation.effectiveStrategy !== undefined) {
			if (!['min-cost', 'balanced', 'quality-first'].includes(operation.effectiveStrategy)) {
				throw new TypeError('Operation effectiveStrategy invalid');
			}
		}
		if (operation.selectedQualityTier !== undefined && operation.selectedQualityTier !== null) {
			if (![1, 2, 3].includes(operation.selectedQualityTier)) {
				throw new TypeError('Operation selectedQualityTier invalid');
			}
		}
		if (
			operation.counterfactualTier2CostMicrousd !== undefined &&
			operation.counterfactualTier2CostMicrousd !== null
		) {
			nonnegative(operation.counterfactualTier2CostMicrousd, 'operation.counterfactualTier2CostMicrousd');
		}

		// Backward compatibility normalization for schemaVersion 1.0.0 (AC-22)
		if (envelope.schemaVersion === '1.0.0') {
			if (operation.effectiveStrategy === undefined) {
				operation.effectiveStrategy = 'balanced';
			}
			if (operation.selectedQualityTier === undefined) {
				operation.selectedQualityTier = undefined;
			}
			if (operation.counterfactualTier2CostMicrousd === undefined) {
				operation.counterfactualTier2CostMicrousd = undefined;
			}
		}
	}
	if (!Array.isArray(envelope.reservations) || !Array.isArray(envelope.attempts)) {
		throw new TypeError('Ledger records invalid');
	}
	const reservationIds = new Set<string>();
	for (const rawRes of envelope.reservations) {
		const reservation = rawRes as LedgerReservationRecord & Record<string, unknown>;
		const reservationKeys = new Set([
			'id',
			'attemptId',
			'operationId',
			'ownerToken',
			'ownerPid',
			'routeId',
			'provider',
			'model',
			'canonicalVendor',
			'routeClass',
			'consumer',
			'profile',
			'reservedAt',
			'deadlineAt',
			'charge',
			'estimator',
			'runLimitSnapshot',
			'retryIndex',
			'failoverIndex',
			'qualityTier',
			'effectiveStrategy',
		]);
		closed(reservation, reservationKeys, 'reservation');
		required(
			reservation,
			new Set(
				[...reservationKeys].filter(
					(key) => !['qualityTier', 'effectiveStrategy'].includes(key),
				),
			),
			'reservation',
		);
		if (reservationIds.has(reservation.id)) throw new TypeError('Duplicate reservation id');
		reservationIds.add(reservation.id);
		validateOperationId(reservation.operationId);
		for (const key of ['id', 'attemptId', 'ownerToken', 'routeId', 'provider', 'model', 'canonicalVendor', 'routeClass', 'consumer', 'profile'] as const) {
			if (typeof reservation[key] !== 'string' || reservation[key].length === 0) {
				throw new TypeError(`reservation.${key} invalid`);
			}
		}
		nonnegative(reservation.ownerPid, 'reservation.ownerPid');
		nonnegative(reservation.retryIndex, 'reservation.retryIndex');
		nonnegative(reservation.failoverIndex, 'reservation.failoverIndex');
		timestamp(reservation.reservedAt, 'reservation.reservedAt');
		timestamp(reservation.deadlineAt, 'reservation.deadlineAt');
		validateCharge(reservation.charge, 'reservation.charge');
		validateEstimator(reservation.estimator, 'reservation.estimator');
		validateRunLimitSnapshot(reservation.runLimitSnapshot, 'reservation.runLimitSnapshot');
		if (reservation.qualityTier !== undefined) {
			nonnegative(reservation.qualityTier, 'reservation.qualityTier');
		}
		if (reservation.effectiveStrategy !== undefined) {
			if (!['min-cost', 'balanced', 'quality-first'].includes(reservation.effectiveStrategy)) {
				throw new TypeError('reservation.effectiveStrategy invalid');
			}
		}
	}
	const attemptIds = new Set<string>();
	const attemptReservationIds = new Set<string>();
	const usageRecordIds = new Set<string>();
	for (const rawAttempt of envelope.attempts) {
		const attempt = rawAttempt as LedgerAttemptRecord & Record<string, unknown>;
		const attemptKeys = new Set([
			'id',
			'usageRecordId',
			'reservationId',
			'attemptId',
			'operationId',
			'routeId',
			'provider',
			'model',
			'canonicalVendor',
			'routeClass',
			'consumer',
			'profile',
			'retryIndex',
			'failoverIndex',
			'startedAt',
			'completedAt',
			'durationMs',
			'outcome',
			'providerRequestId',
			'providerModelVersion',
			'reservationCharge',
			'estimator',
			'executionProvenFalse',
			'charge',
			'usageSource',
			'pricingVersion',
			'runLimitSnapshot',
			'remainingRunBudget',
			'qualityTier',
			'effectiveStrategy',
		]);
		if (envelope.schemaVersion === '1.2.0') attemptKeys.add('tokenDetails');
		closed(attempt, attemptKeys, 'attempt');
		required(
			attempt,
			new Set(
				[...attemptKeys].filter(
					(key) =>
						![
							'providerRequestId',
							'providerModelVersion',
							'qualityTier',
							'effectiveStrategy',
							'tokenDetails',
						].includes(key),
				),
			),
			'attempt',
		);
		if (attemptIds.has(attempt.id)) throw new TypeError('Duplicate attempt id');
		attemptIds.add(attempt.id);
		if (attemptReservationIds.has(attempt.reservationId)) {
			throw new TypeError('Duplicate attempt reservation id');
		}
		attemptReservationIds.add(attempt.reservationId);
		if (usageRecordIds.has(attempt.usageRecordId)) throw new TypeError('Duplicate usage record id');
		usageRecordIds.add(attempt.usageRecordId);
		for (const key of ['id', 'usageRecordId', 'reservationId', 'attemptId', 'operationId', 'routeId', 'provider', 'model', 'canonicalVendor', 'routeClass', 'consumer', 'profile', 'outcome', 'usageSource', 'pricingVersion'] as const) {
			if (typeof attempt[key] !== 'string' || attempt[key].length === 0) {
				throw new TypeError(`attempt.${key} invalid`);
			}
		}
		validateOperationId(attempt.operationId);
		nonnegative(attempt.retryIndex, 'attempt.retryIndex');
		nonnegative(attempt.failoverIndex, 'attempt.failoverIndex');
		timestamp(attempt.startedAt, 'attempt.startedAt');
		timestamp(attempt.completedAt, 'attempt.completedAt');
		nonnegative(attempt.durationMs, 'attempt.durationMs');
		if (typeof attempt.executionProvenFalse !== 'boolean') {
			throw new TypeError('attempt.executionProvenFalse invalid');
		}
		validateCharge(attempt.reservationCharge, 'attempt.reservationCharge');
		validateEstimator(attempt.estimator, 'attempt.estimator');
		validateCharge(attempt.charge, 'attempt.charge');
		validateRunLimitSnapshot(attempt.runLimitSnapshot, 'attempt.runLimitSnapshot');
		validateRemainingRunBudget(attempt.remainingRunBudget, 'attempt.remainingRunBudget');
		if (attempt.qualityTier !== undefined) {
			nonnegative(attempt.qualityTier, 'attempt.qualityTier');
		}
		if (attempt.effectiveStrategy !== undefined) {
			if (!['min-cost', 'balanced', 'quality-first'].includes(attempt.effectiveStrategy)) {
				throw new TypeError('attempt.effectiveStrategy invalid');
			}
		}
		if (attempt.tokenDetails !== undefined) {
			if (attempt.usageSource !== 'provider' || attempt.executionProvenFalse === true) {
				throw new TypeError('attempt.tokenDetails requires provider usage');
			}
			validateTokenDetails(attempt.tokenDetails, attempt.charge, 'attempt.tokenDetails');
		}
		if (
			attempt.providerModelVersion !== undefined &&
			(typeof attempt.providerModelVersion !== 'string' ||
				!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attempt.providerModelVersion))
		) {
			throw new TypeError('attempt.providerModelVersion invalid');
		}
	}
	const referenced = new Set(envelope.attempts.map((attempt) => attempt.reservationId));
	for (const reservationId of referenced) {
		if (reservationIds.has(reservationId)) {
			throw new TypeError('Reconciled reservation remains active');
		}
	}
	for (const reservation of envelope.reservations) {
		const operation = envelope.operations[reservation.operationId];
		if (!operation) throw new TypeError('Reservation references missing operation');
		if (reservation.consumer !== operation.consumer || reservation.profile !== operation.profile) {
			throw new TypeError('Reservation operation attribution mismatch');
		}
	}
	for (const attempt of envelope.attempts) {
		const operation = envelope.operations[attempt.operationId];
		if (!operation) throw new TypeError('Attempt references missing operation');
		if (attempt.consumer !== operation.consumer || attempt.profile !== operation.profile) {
			throw new TypeError('Attempt operation attribution mismatch');
		}
		if (attempt.usageRecordId !== `usage-${attempt.attemptId}`) {
			throw new TypeError('Attempt usage record id inconsistent');
		}
	}
	for (const [operationId, operation] of Object.entries(envelope.operations)) {
		const reservations = envelope.reservations.filter((item) => item.operationId === operationId);
		const attempts = envelope.attempts.filter((item) => item.operationId === operationId);
		for (const usageRecordId of operation.usageRecordIds) {
			const attempt = envelope.attempts.find((item) => item.usageRecordId === usageRecordId);
			if (!attempt || attempt.operationId !== operationId) {
				throw new TypeError('Operation usage record relationship invalid');
			}
		}
		if (operation.usageRecordIds.length !== attempts.length) {
			throw new TypeError('Operation usage record count inconsistent');
		}
		if (['active', 'reserved'].includes(operation.state)) {
			const expectedReservations = operation.state === 'active' ? 1 : 0;
			if (
				reservations.length !== expectedReservations ||
				operation.failure !== undefined ||
				operation.output !== undefined
			) {
				throw new TypeError('Active operation reservation state inconsistent');
			}
			validateRouteRef(operation.route, `operation ${operationId}.route`);
			const reservation = reservations[0] ?? attempts.at(-1);
			if (!reservation || !operation.route) throw new TypeError('Active operation has no attempt relationship');
			if (
				operation.route.routeId !== reservation.routeId ||
				operation.route.provider !== reservation.provider ||
				operation.route.model !== reservation.model ||
				operation.route.canonicalVendor !== reservation.canonicalVendor
			) {
				throw new TypeError('Active operation route mismatch');
			}
			continue;
		}
		if (reservations.length !== 0) throw new TypeError('Terminal operation retains reservation');
		if (operation.state === 'succeeded') {
			if (
				!Object.hasOwn(operation, 'output') ||
				operation.failure !== undefined ||
				attempts.length === 0 ||
				attempts.at(-1)?.outcome !== 'succeeded'
			) {
				throw new TypeError('Succeeded operation state inconsistent');
			}
		} else {
			if (operation.output !== undefined || !Object.hasOwn(operation, 'failure')) {
				throw new TypeError('Failed operation state inconsistent');
			}
			ModelUsageError.fromJSON(operation.failure);
		}
		validateRouteRef(operation.route, `operation ${operationId}.route`);
		const latest = attempts.at(-1);
		if (
			!latest ||
			!operation.route ||
			operation.route.routeId !== latest.routeId ||
			operation.route.provider !== latest.provider ||
			operation.route.model !== latest.model ||
			operation.route.canonicalVendor !== latest.canonicalVendor
		) {
			throw new TypeError('Terminal operation route mismatch');
		}
	}
	return envelope;
}
