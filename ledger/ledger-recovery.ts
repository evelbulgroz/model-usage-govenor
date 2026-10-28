/**
 * Synchronous recovery of abandoned reservations.
 * The owner liveness check is an argument, so this file does not touch the lock.
 */
import { ModelUsageError } from '../policy/errors.ts';
import type { LedgerEnvelope, LedgerReservationRecord } from './ledger-attempt-validation.ts';
import {
	clone,
	projectRemainingRunBudget,
	recordsForRunProfile,
} from './ledger-budget.ts';

export function recoverEnvelope(
	envelope: LedgerEnvelope,
	nowMs: number,
	isOwnerAlive: (pid: number) => boolean,
): boolean {
	let changed = false;
	const survivors: LedgerReservationRecord[] = [];
	for (const reservation of envelope.reservations) {
		const operation = envelope.operations[reservation.operationId];
		const stale =
			!isOwnerAlive(reservation.ownerPid) ||
			Date.parse(operation.operationDeadlineAt) <= nowMs;
		if (!stale) {
			survivors.push(reservation);
			continue;
		}
		changed = true;
		const completedAt = new Date(nowMs).toISOString();
		const usageRecordId = `usage-${reservation.attemptId}`;
		envelope.attempts.push({
			id: reservation.attemptId,
			usageRecordId,
			reservationId: reservation.id,
			attemptId: reservation.attemptId,
			operationId: reservation.operationId,
			routeId: reservation.routeId,
			provider: reservation.provider,
			model: reservation.model,
			canonicalVendor: reservation.canonicalVendor,
			routeClass: reservation.routeClass,
			consumer: reservation.consumer,
			profile: reservation.profile,
			retryIndex: reservation.retryIndex,
			failoverIndex: reservation.failoverIndex,
			...(reservation.qualityTier !== undefined ? { qualityTier: reservation.qualityTier } : {}),
			...(reservation.effectiveStrategy !== undefined
				? { effectiveStrategy: reservation.effectiveStrategy }
				: {}),
			startedAt: reservation.reservedAt,
			completedAt,
			durationMs: Math.max(0, nowMs - Date.parse(reservation.reservedAt)),
			outcome: 'recovery_charged',
			reservationCharge: clone(reservation.charge),
			estimator: clone(reservation.estimator),
			executionProvenFalse: false,
			charge: clone(reservation.charge),
			usageSource: 'estimated',
			pricingVersion: envelope.pricingVersion,
			runLimitSnapshot: clone(reservation.runLimitSnapshot),
			remainingRunBudget: projectRemainingRunBudget(
				recordsForRunProfile(
					[
						...envelope.attempts,
						...envelope.reservations.filter(
							(item) =>
								item.id !== reservation.id &&
								!envelope.attempts.some(
									(attempt) => attempt.reservationId === item.id,
								),
						),
					],
					reservation.profile,
				),
				reservation.runLimitSnapshot,
			),
		});
		operation.state = 'recovery_charged';
		operation.selectedQualityTier = reservation.qualityTier ?? null;
		operation.failure = new ModelUsageError(
			'ERR_USAGE_RECONCILIATION_FAILED',
			'An abandoned provider attempt was conservatively recovered',
			{ operationId: reservation.operationId, attemptId: reservation.attemptId },
		).toJSON();
		operation.usageRecordIds.push(usageRecordId);
	}
	envelope.reservations = survivors;
	for (const [operationId, operation] of Object.entries(envelope.operations)) {
		if (
			operation.state === 'reserved' &&
			(!isOwnerAlive(operation.ownerPid) ||
				Date.parse(operation.operationDeadlineAt) <= nowMs)
		) {
			changed = true;
			operation.state = 'recovery_charged';
			operation.failure = new ModelUsageError(
				'ERR_USAGE_RECONCILIATION_FAILED',
				'An abandoned retry transition was conservatively recovered',
				{ operationId },
			).toJSON();
		}
	}
	return changed;
}
