import fs from 'node:fs';
import path from 'node:path';
import { durableReplaceSync, withLockSync } from '../atomic-file-state.ts';
import { loadPolicy } from '../policy/policy.ts';

export const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
export const CIRCUIT_STATE_SCHEMA_VERSION = '1.0.0';

export interface ProviderCircuitRecord {
	unavailableUntil?: string;
	reason?: string;
	failureCount?: number;
	lastFailureAt?: string;
}

export interface RetryScheduleRecord {
	nextEligibleRetryAt: string;
	retryIndex: number;
	updatedAt: string;
}

export interface CircuitState {
	schemaVersion: string;
	providers: Record<string, ProviderCircuitRecord>;
	retrySchedules: Record<string, RetryScheduleRecord>;
}

export class ProviderCircuitBreaker {
	readonly stateRoot: string;
	readonly circuitFile: string;
	readonly lockFile: string;
	readonly cooldownMs: number;

	constructor({
		stateRoot,
		cooldownMs = DEFAULT_CIRCUIT_COOLDOWN_MS,
	}: { stateRoot?: string; cooldownMs?: number } = {}) {
		this.stateRoot = path.resolve(stateRoot ?? loadPolicy.resolveDefaultStateRoot());
		this.circuitFile = path.join(this.stateRoot, 'provider-circuit.json');
		this.lockFile = path.join(this.stateRoot, '.circuit.lock');
		this.cooldownMs = cooldownMs;
	}

	readState(): CircuitState {
		try {
			if (!fs.existsSync(this.circuitFile)) {
				return {
					schemaVersion: CIRCUIT_STATE_SCHEMA_VERSION,
					providers: {},
					retrySchedules: {},
				};
			}
			const parsed = JSON.parse(fs.readFileSync(this.circuitFile, 'utf8')) as Partial<CircuitState>;
			return {
				schemaVersion: parsed.schemaVersion ?? CIRCUIT_STATE_SCHEMA_VERSION,
				providers: parsed.providers ?? {},
				retrySchedules: parsed.retrySchedules ?? {},
			};
		} catch {
			return {
				schemaVersion: CIRCUIT_STATE_SCHEMA_VERSION,
				providers: {},
				retrySchedules: {},
			};
		}
	}

	writeState(state: CircuitState): void {
		fs.mkdirSync(this.stateRoot, { recursive: true, mode: 0o700 });
		durableReplaceSync(this.circuitFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	}

	withLock<T>(fn: () => T): T {
		fs.mkdirSync(this.stateRoot, { recursive: true, mode: 0o700 });
		return withLockSync(this.lockFile, () => fn());
	}

	isProviderAvailable(provider: string | null | undefined, nowMs = Date.now()): boolean {
		if (!provider) return true;
		const state = this.readState();
		const record = state.providers[provider];
		if (!record?.unavailableUntil) return true;
		const untilMs = Date.parse(record.unavailableUntil);
		return nowMs >= untilMs;
	}

	getProviderCooldownUntil(provider: string | null | undefined): string | null {
		if (!provider) return null;
		const state = this.readState();
		return state.providers[provider]?.unavailableUntil ?? null;
	}

	recordProviderFailure(
		provider: string | null | undefined,
		outcome: string,
		nowMs = Date.now(),
		customCooldownMs: number | null = null,
	): void {
		if (!provider) return;
		this.withLock(() => {
			const state = this.readState();
			const existing = state.providers[provider] ?? {};
			const cooldown = customCooldownMs ?? this.cooldownMs;
			const unavailableUntil = new Date(nowMs + cooldown).toISOString();
			state.providers[provider] = {
				unavailableUntil,
				reason: outcome,
				failureCount: (existing.failureCount ?? 0) + 1,
				lastFailureAt: new Date(nowMs).toISOString(),
			};
			this.writeState(state);
		});
	}

	recordProviderSuccess(provider: string | null | undefined): void {
		if (!provider) return;
		this.withLock(() => {
			const state = this.readState();
			if (state.providers[provider]) {
				delete state.providers[provider];
				this.writeState(state);
			}
		});
	}

	getRetrySchedule(operationId: string | null | undefined): RetryScheduleRecord | null {
		if (!operationId) return null;
		const state = this.readState();
		return state.retrySchedules[operationId] ?? null;
	}

	recordRetrySchedule(
		operationId: string | null | undefined,
		nextEligibleRetryAt: string,
		retryIndex = 0,
	): void {
		if (!operationId) return;
		this.withLock(() => {
			const state = this.readState();
			state.retrySchedules[operationId] = {
				nextEligibleRetryAt,
				retryIndex,
				updatedAt: new Date().toISOString(),
			};
			this.writeState(state);
		});
	}

	clearRetrySchedule(operationId: string | null | undefined): void {
		if (!operationId) return;
		this.withLock(() => {
			const state = this.readState();
			if (state.retrySchedules[operationId]) {
				delete state.retrySchedules[operationId];
				this.writeState(state);
			}
		});
	}

	calculateBackoffDelay(
		retryIndex: number,
		{
			baseDelayMs = 1000,
			maxDelayMs = 10_000,
			jitter = true,
		}: { baseDelayMs?: number; maxDelayMs?: number; jitter?: boolean } = {},
	): number {
		const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, retryIndex));
		const jitterOffset = jitter ? Math.floor(Math.random() * 200) : 0;
		return exponential + jitterOffset;
	}
}
