/**
 * Public ledger facade. The instance lock and durable replace stay here.
 * Extracted ledger modules are synchronous internal parts of the governor.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { durableReplaceSync, isProcessAlive, withLockSync } from '../atomic-file-state.ts';
import { ModelUsageError } from '../policy/errors.ts';
import { type LedgerAttemptRecord, type LedgerCharge, type LedgerEnvelope, type LedgerEstimator, type LedgerOperationRecord, type LedgerReservationRecord, validateCharge } from './ledger-attempt-validation.ts';
import { type LedgerAggregateTotals, type ReconcileResultInput, assertReservationAdmissible, assembleReconciledCharge, clone, projectRemainingRunBudget, recordsForRunProfile, totals } from './ledger-budget.ts';
import { applyProfileRunDeadline, emptyEnvelope, validateEnvelope } from './ledger-envelope-validation.ts';
import { recoverEnvelope as recoverStoredEnvelope } from './ledger-recovery.ts';
import { type LedgerEnvelopeSummary, listExhaustedRouteIds, summarizeEnvelope as summarizeStoredEnvelope } from './ledger-summary.ts';
import { type EffectiveProfile, type NormalizedOperationRequest, canonicalJson, validateOperationId, validateRunId } from '../policy/operation-request.ts';
import { loadPolicy } from '../policy/policy.ts';
import type { PolicyRoute } from '../policy/policy-route-catalog.ts';
import type { ModelUsagePolicy } from '../policy/policy-validation.ts';

export type { LedgerAggregateTotals, LedgerAttemptRecord, LedgerCharge, LedgerEnvelope, LedgerEnvelopeSummary, LedgerEstimator, LedgerOperationRecord, LedgerReservationRecord, ReconcileResultInput };

export interface ReserveAttemptOutcome {
	replay?: LedgerOperationRecord;
	fits?: boolean;
	reservation?: LedgerReservationRecord;
	operationDeadlineAt?: string;
	runDeadlineAt?: string;
}

function terminalFailure(operation: LedgerOperationRecord): ModelUsageError {
	return operation.failure
		? ModelUsageError.fromJSON(operation.failure)
		: new ModelUsageError(
				'ERR_USAGE_RECONCILIATION_FAILED',
				'Operation has no replayable terminal failure',
				{ operationId: operation.operationId },
			);
}

export class ModelUsageLedger {
	readonly stateRoot: string;
	readonly runsRoot: string;
	readonly lockFile: string;
	readonly isOwnerAlive: (pid: number) => boolean;
	readonly now: () => Date;

	constructor({
		stateRoot,
		isOwnerAlive = isProcessAlive,
		now = () => new Date(),
	}: { stateRoot?: string; isOwnerAlive?: (pid: number) => boolean; now?: () => Date } = {}) {
		this.stateRoot = path.resolve(stateRoot ?? loadPolicy.resolveDefaultStateRoot());
		this.runsRoot = path.resolve(this.stateRoot, 'runs');
		if (!this.runsRoot.startsWith(`${this.stateRoot}${path.sep}`)) throw new TypeError('Invalid state root');
		this.lockFile = path.join(this.stateRoot, '.instance.lock');
		this.isOwnerAlive = isOwnerAlive;
		this.now = now;
	}

	ensureStorage(): void {
		fs.mkdirSync(this.runsRoot, { recursive: true, mode: 0o700 });
		fs.chmodSync(this.stateRoot, 0o700);
		fs.chmodSync(this.runsRoot, 0o700);
	}

	runFile(runId: string): string {
		validateRunId(runId);
		const file = path.resolve(this.runsRoot, `${runId}.json`);
		if (!file.startsWith(`${this.runsRoot}${path.sep}`)) throw new TypeError('Run path escapes state root');
		return file;
	}

	readEnvelope(runId: string): LedgerEnvelope | undefined {
		const file = this.runFile(runId);
		if (!fs.existsSync(file)) return undefined;
		return validateEnvelope(JSON.parse(fs.readFileSync(file, 'utf8')), runId);
	}

	writeEnvelope(envelope: LedgerEnvelope): void {
		if (envelope.schemaVersion === '1.1.0') envelope.schemaVersion = '1.2.0';
		validateEnvelope(envelope, envelope.runId);
		durableReplaceSync(this.runFile(envelope.runId), `${canonicalJson(envelope)}\n`, { mode: 0o600 });
		fs.chmodSync(this.runFile(envelope.runId), 0o600);
	}

	readAllEnvelopes(): LedgerEnvelope[] {
		if (!fs.existsSync(this.runsRoot)) return [];
		const envelopes: LedgerEnvelope[] = [];
		for (const entry of fs.readdirSync(this.runsRoot, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
			const runId = entry.name.slice(0, -5);
			envelopes.push(validateEnvelope(JSON.parse(fs.readFileSync(path.join(this.runsRoot, entry.name), 'utf8')), runId));
		}
		return envelopes;
	}

	recoverEnvelope(envelope: LedgerEnvelope, nowMs: number): boolean {
		return recoverStoredEnvelope(envelope, nowMs, this.isOwnerAlive);
	}

	withState<T>(fn: (envelopes: LedgerEnvelope[], now: Date) => T, { recover = true } = {}): T {
		this.ensureStorage();
		return withLockSync(this.lockFile, () => {
			const envelopes = this.readAllEnvelopes();
			const nowMs = this.now().getTime();
			if (recover) {
				for (const envelope of envelopes) {
					if (this.recoverEnvelope(envelope, nowMs)) this.writeEnvelope(envelope);
				}
			}
			const result = fn(envelopes, new Date(nowMs));
			if (result && typeof (result as { then?: unknown }).then === 'function') {
				throw new TypeError('Ledger lock callbacks must be synchronous');
			}
			return result;
		});
	}

	getOperation(runId: string, operationId: string, inputHash: string): LedgerOperationRecord | undefined {
		validateRunId(runId);
		validateOperationId(operationId);
		if (!fs.existsSync(this.runsRoot)) return undefined;
		return this.withState((envelopes) => {
			const envelope = envelopes.find((candidate) => candidate.runId === runId);
			const operation = envelope?.operations[operationId];
			if (!operation) return undefined;
			if (operation.inputHash !== inputHash) {
				throw new ModelUsageError('ERR_OPERATION_ID_REUSED', 'Operation ID was reused with different input', {
					runId,
					operationId,
				});
			}
			if (['reserved', 'active'].includes(operation.state)) {
				throw new ModelUsageError('ERR_OPERATION_IN_PROGRESS', 'Operation is already active', {
					runId,
					operationId,
				});
			}
			if (operation.state === 'succeeded') return clone(operation);
			throw terminalFailure(operation);
		});
	}

	reserveAttempt(params: {
		policy: Readonly<ModelUsagePolicy>;
		profile: EffectiveProfile;
		route: PolicyRoute;
		request: NormalizedOperationRequest;
		inputHash: string;
		ownerToken: string;
		reservation: LedgerCharge;
		estimator: LedgerEstimator;
		retryIndex: number;
		failoverIndex: number;
		attemptTimeoutMs: number;
		effectiveStrategy?: string;
		counterfactualTier2CostMicrousd?: number;
		dryRun?: boolean;
	}): ReserveAttemptOutcome {
		const {
			policy,
			profile,
			route,
			request,
			inputHash,
			ownerToken,
			reservation,
			estimator,
			retryIndex,
			failoverIndex,
			attemptTimeoutMs,
			effectiveStrategy,
			counterfactualTier2CostMicrousd,
			dryRun = false,
		} = params;
		return this.withState((liveEnvelopes, now) => {
			// Dry-run adds no reservation. withState may already have persisted recovery of stale reservations.
			const envelopes = dryRun ? clone(liveEnvelopes) : liveEnvelopes;
			let envelope = envelopes.find((candidate) => candidate.runId === request.runId);
			const operationDeadlineAt = new Date(now.getTime() + profile.limits.operationTimeoutMs).toISOString();
			const runDeadlineAt = new Date(now.getTime() + profile.limits.runTimeoutMs).toISOString();
			if (!envelope) {
				envelope = emptyEnvelope(request.runId, policy, now.toISOString(), runDeadlineAt);
				envelopes.push(envelope);
			}
			const deadlineExtended = applyProfileRunDeadline(envelope, profile);
			if (Date.parse(envelope.runDeadlineAt) <= now.getTime()) {
				if (deadlineExtended && !dryRun) this.writeEnvelope(envelope);
				throw new ModelUsageError('ERR_RUN_DEADLINE_EXPIRED', 'Run deadline has expired', {
					runId: request.runId,
					profile: request.profile,
					limit: profile.limits.runTimeoutMs,
					runDeadlineAt: envelope.runDeadlineAt,
				});
			}
			let operation = envelope.operations[request.operationId];
			if (operation) {
				if (operation.inputHash !== inputHash) {
					throw new ModelUsageError('ERR_OPERATION_ID_REUSED', 'Operation ID was reused with different input', {
						operationId: request.operationId,
						runId: request.runId,
					});
				}
				if (operation.ownerToken !== ownerToken && ['reserved', 'active'].includes(operation.state)) {
					throw new ModelUsageError('ERR_OPERATION_IN_PROGRESS', 'Operation is already active', {
						operationId: request.operationId,
						runId: request.runId,
					});
				}
				if (operation.state === 'succeeded') return { replay: clone(operation) };
				if (['failed', 'recovery_charged'].includes(operation.state)) throw terminalFailure(operation);
			} else {
				operation = {
					inputHash,
					state: 'reserved',
					consumer: request.consumer,
					profile: request.profile,
					attribution: clone(request.attribution ?? {}),
					ownerToken,
					ownerPid: process.pid,
					firstReservedAt: now.toISOString(),
					operationDeadlineAt,
					usageRecordIds: [],
					effectiveStrategy: effectiveStrategy ?? 'balanced',
					selectedQualityTier: null,
					counterfactualTier2CostMicrousd: counterfactualTier2CostMicrousd ?? null,
				};
				envelope.operations[request.operationId] = operation;
			}
			const remainingOperationMs = Date.parse(operation.operationDeadlineAt) - now.getTime();
			const remainingRunMs = Date.parse(envelope.runDeadlineAt) - now.getTime();
			const deadlineMs = Math.min(attemptTimeoutMs, remainingOperationMs, remainingRunMs);
			if (deadlineMs <= 0) {
				throw new ModelUsageError('ERR_OPERATION_TIMEOUT', 'No attempt time remains', {
					operationId: request.operationId,
					runId: request.runId,
				});
			}
			assertReservationAdmissible({ envelopes, envelope, request, profile, route, reservation, policy });
			const operationRecords = [...envelope.attempts, ...envelope.reservations].filter(
				(record) => record.operationId === request.operationId,
			);
			const attemptId = `${request.operationId}:p${operationRecords.length + 1}`;
			const runLimitSnapshot = {
				maxTotalTokens: profile.limits.runMaxTotalTokens,
				maxPhysicalCalls: profile.limits.runMaxPhysicalCalls,
				maxCostMicrousd: profile.limits.runMaxCostMicrousd,
				maxPremiumRequestUnits: profile.limits.runMaxPremiumRequestUnits,
			};
			const reservationRecord: LedgerReservationRecord = {
				id: crypto.randomUUID(),
				attemptId,
				operationId: request.operationId,
				ownerToken,
				ownerPid: process.pid,
				routeId: route.id,
				provider: route.provider,
				model: route.model,
				canonicalVendor: route.canonicalVendor,
				routeClass: route.classification,
				qualityTier: route.qualityTier,
				effectiveStrategy: effectiveStrategy ?? 'balanced',
				consumer: request.consumer,
				profile: request.profile,
				reservedAt: now.toISOString(),
				deadlineAt: new Date(now.getTime() + deadlineMs).toISOString(),
				charge: clone(reservation),
				estimator: clone(estimator),
				runLimitSnapshot,
				retryIndex,
				failoverIndex,
			};
			if (dryRun) return { fits: true };
			envelope.reservations.push(reservationRecord);
			operation.state = 'active';
			operation.route = {
				routeId: route.id,
				provider: route.provider,
				model: route.model,
				canonicalVendor: route.canonicalVendor,
			};
			this.writeEnvelope(envelope);
			return clone({
				reservation: reservationRecord,
				operationDeadlineAt: operation.operationDeadlineAt,
				runDeadlineAt: envelope.runDeadlineAt,
			});
		});
	}

	recordAttemptAndReconcile(params: {
		runId: string;
		operationId: string;
		reservationId: string;
		result: ReconcileResultInput;
		route: PolicyRoute;
		terminal?: 'succeeded' | 'failed';
		output?: unknown;
		failure?: ModelUsageError;
		startedAt: string;
		completedAt: string;
	}): { attempt: LedgerAttemptRecord; operation: LedgerOperationRecord; summary: LedgerEnvelopeSummary } {
		const { runId, operationId, reservationId, result, route, terminal, output, failure, startedAt, completedAt } =
			params;
		try {
			return this.withState((envelopes) => {
				const envelope = envelopes.find((candidate) => candidate.runId === runId);
				if (!envelope) throw new TypeError('Run ledger missing during reconciliation');
				const index = envelope.reservations.findIndex((item) => item.id === reservationId);
				if (index < 0) throw new TypeError('Reservation missing during reconciliation');
				const reservation = envelope.reservations[index];
				if (reservation.operationId !== operationId) throw new TypeError('Reservation operation mismatch');
				const operation = envelope.operations[operationId];
				const { charge, usageSource } = assembleReconciledCharge({ result, reservation, route });
				validateCharge(charge, 'reconciled charge');
				const storeTokenDetails =
					(envelope.schemaVersion === '1.1.0' || envelope.schemaVersion === '1.2.0') &&
					usageSource === 'provider' &&
					result.executionProvenFalse !== true &&
					result.usage?.tokenDetails !== undefined;
				const exceedsReservation =
					charge.promptTokens > reservation.charge.promptTokens ||
					charge.completionTokens > reservation.charge.completionTokens ||
					charge.totalTokens > reservation.charge.totalTokens ||
					charge.premiumRequestUnits > reservation.charge.premiumRequestUnits ||
					(typeof charge.costMicrousd === 'number' &&
						typeof reservation.charge.costMicrousd === 'number' &&
						charge.costMicrousd > reservation.charge.costMicrousd);
				const reconciliationFailure = exceedsReservation
					? new ModelUsageError(
							'ERR_USAGE_RECONCILIATION_FAILED',
							'Provider usage exceeded the durable reservation',
							{ runId, operationId, attemptId: reservation.attemptId },
						)
					: undefined;
				const usageRecordId = `usage-${reservation.attemptId}`;
				const runLimitSnapshot = clone(reservation.runLimitSnapshot);
				const remainingRecords = recordsForRunProfile(
					[
						...envelope.attempts,
						...envelope.reservations.filter((_, idx) => idx !== index),
						{ profile: reservation.profile, charge },
					],
					reservation.profile,
				);
				const attempt: LedgerAttemptRecord = {
					id: reservation.attemptId,
					usageRecordId,
					reservationId,
					attemptId: reservation.attemptId,
					operationId,
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
					...(reservation.effectiveStrategy !== undefined ? { effectiveStrategy: reservation.effectiveStrategy } : {}),
					startedAt,
					completedAt,
					durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
					outcome: result.status === 'succeeded' ? 'succeeded' : String(result.outcome ?? 'transport'),
					...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
					...(result.providerModelVersion ? { providerModelVersion: result.providerModelVersion } : {}),
					reservationCharge: clone(reservation.charge),
					estimator: clone(reservation.estimator),
					executionProvenFalse: result.executionProvenFalse === true,
					charge,
					usageSource,
					...(storeTokenDetails && result.usage?.tokenDetails ? { tokenDetails: clone(result.usage.tokenDetails) } : {}),
					pricingVersion: envelope.pricingVersion,
					runLimitSnapshot,
					remainingRunBudget: projectRemainingRunBudget(remainingRecords, runLimitSnapshot),
				};
				envelope.reservations.splice(index, 1);
				envelope.attempts.push(attempt);
				operation.usageRecordIds.push(usageRecordId);
				if (reconciliationFailure) {
					operation.state = 'failed';
					operation.failure = reconciliationFailure.toJSON();
					operation.selectedQualityTier = attempt.qualityTier ?? null;
				} else if (terminal === 'succeeded') {
					operation.state = 'succeeded';
					operation.output = clone(output);
					operation.selectedQualityTier = attempt.qualityTier ?? null;
				} else if (terminal === 'failed' && failure) {
					operation.state = 'failed';
					operation.failure = failure.toJSON();
					operation.selectedQualityTier = attempt.qualityTier ?? null;
				} else {
					operation.state = 'reserved';
				}
				this.writeEnvelope(envelope);
				if (reconciliationFailure) throw reconciliationFailure;
				return clone({ attempt, operation, summary: this.summarizeEnvelope(envelope, operationId) });
			}, { recover: false });
		} catch (error) {
			if (error instanceof ModelUsageError) throw error;
			throw new ModelUsageError(
				'ERR_USAGE_RECONCILIATION_FAILED',
				'Usage reconciliation failed closed',
				{ runId, operationId, reason: 'ledger-transition-failed' },
				{ cause: error },
			);
		}
	}

	finalizeFailure(runId: string, operationId: string, failure: ModelUsageError): boolean {
		return this.withState((envelopes) => {
			const envelope = envelopes.find((candidate) => candidate.runId === runId);
			const operation = envelope?.operations[operationId];
			if (!operation || !envelope) return false;
			if (operation.state === 'succeeded') return false;
			operation.state = 'failed';
			operation.failure = failure.toJSON();
			if (operation.selectedQualityTier === null || operation.selectedQualityTier === undefined) {
				const lastAttempt = [...envelope.attempts].filter((a) => a.operationId === operationId).pop();
				if (lastAttempt?.qualityTier) operation.selectedQualityTier = lastAttempt.qualityTier;
			}
			this.writeEnvelope(envelope);
			return true;
		});
	}

	summarizeEnvelope(envelope: LedgerEnvelope, operationId: string): LedgerEnvelopeSummary {
		return summarizeStoredEnvelope(envelope, operationId);
	}

	getRunBudgetSummary(runId: string): { runTotal: LedgerAggregateTotals; runDeadlineAt: string } | undefined {
		if (!fs.existsSync(this.runsRoot)) return undefined;
		return this.withState((envelopes) => {
			const envelope = envelopes.find((candidate) => candidate.runId === runId);
			if (!envelope) return undefined;
			const records = [...envelope.attempts, ...envelope.reservations];
			return clone({ runTotal: totals(records), runDeadlineAt: envelope.runDeadlineAt });
		});
	}

	getExhaustedRouteIds(policy: Readonly<ModelUsagePolicy>): string[] {
		if (!fs.existsSync(this.runsRoot)) return [];
		return this.withState((envelopes) => listExhaustedRouteIds(policy, envelopes));
	}

	getRunSummary(runId: string, operationId: string): LedgerEnvelopeSummary | undefined {
		return this.withState((envelopes) => {
			const envelope = envelopes.find((candidate) => candidate.runId === runId);
			return envelope ? clone(this.summarizeEnvelope(envelope, operationId)) : undefined;
		});
	}

	loadRunLedger(runId: string): LedgerEnvelope | undefined {
		return this.readEnvelope(runId);
	}
}

export function loadRunLedger(envelopeOrPath: unknown, expectedRunId?: string): LedgerEnvelope {
	if (typeof envelopeOrPath === 'string') {
		const raw = JSON.parse(fs.readFileSync(envelopeOrPath, 'utf8')) as { runId?: string };
		return validateEnvelope(raw, expectedRunId ?? String(raw.runId ?? ''));
	}
	const obj = envelopeOrPath as { runId?: string } | null | undefined;
	return validateEnvelope(envelopeOrPath, expectedRunId ?? String(obj?.runId ?? ''));
}
