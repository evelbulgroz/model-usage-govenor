export const MODEL_USAGE_ERROR_CODES = Object.freeze([
	'ERR_BUDGET_RESERVATION_DENIED',
	'ERR_TOKEN_BUDGET_EXCEEDED',
	'ERR_CALL_BUDGET_EXCEEDED',
	'ERR_COST_BUDGET_EXCEEDED',
	'ERR_CONCURRENCY_LIMIT',
	'ERR_OPERATION_TIMEOUT',
	'ERR_RUN_DEADLINE_EXPIRED',
	'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
	'ERR_LIMIT_ESCALATION_FORBIDDEN',
	'ERR_OPERATION_IN_PROGRESS',
	'ERR_OPERATION_ID_REUSED',
	'ERR_USAGE_RECONCILIATION_FAILED',
] as const);

export type ModelUsageErrorCode = (typeof MODEL_USAGE_ERROR_CODES)[number];

export interface RouteEliminationEntry {
	routeId: string;
	provider?: string | null;
	outcome?: string | null;
	reason?: string | null;
}

export type SafeMetadataScalar = string | number | boolean | null;
export type ModelUsageErrorMetadata = Record<
	string,
	SafeMetadataScalar | readonly RouteEliminationEntry[] | undefined
> & {
	dimension?: string;
	limit?: SafeMetadataScalar;
	requested?: SafeMetadataScalar;
	remaining?: number;
	operationId?: string;
	taskId?: string;
	runId?: string;
	runDeadlineAt?: string;
	consumer?: string;
	profile?: string;
	routeId?: string;
	provider?: string;
	model?: string;
	outcome?: string;
	attemptId?: string;
	usageRecordId?: string;
	reason?: string;
	routesEliminated?: readonly RouteEliminationEntry[];
	truncated?: boolean;
};

export interface SerializedModelUsageError {
	schemaVersion: '1.0.0';
	name: string;
	code: ModelUsageErrorCode;
	message: string;
	metadata: ModelUsageErrorMetadata;
}

const CODE_SET: ReadonlySet<string> = new Set(MODEL_USAGE_ERROR_CODES);
const SAFE_METADATA_KEYS = new Set([
	'dimension',
	'limit',
	'requested',
	'remaining',
	'operationId',
	'taskId',
	'runId',
	'runDeadlineAt',
	'consumer',
	'profile',
	'routeId',
	'provider',
	'model',
	'outcome',
	'attemptId',
	'usageRecordId',
	'reason',
	'routesEliminated',
	'truncated',
]);
const ROUTE_ELIMINATION_ENTRY_KEYS = new Set(['routeId', 'provider', 'outcome', 'reason']);

function isSafeRouteEliminationEntry(entry: unknown): entry is RouteEliminationEntry {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
	const rec = entry as Record<string, unknown>;
	if (typeof rec.routeId !== 'string' || !rec.routeId) return false;
	for (const [key, value] of Object.entries(rec)) {
		if (!ROUTE_ELIMINATION_ENTRY_KEYS.has(key)) return false;
		if (value !== null && typeof value !== 'string') return false;
	}
	return true;
}

function copySafeMetadata(metadata: unknown): Readonly<ModelUsageErrorMetadata> {
	if (metadata === undefined) return Object.freeze({});
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		throw new TypeError('ModelUsageError metadata must be an object');
	}
	const safe: ModelUsageErrorMetadata = {};
	for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
		if (!SAFE_METADATA_KEYS.has(key)) continue;
		if (key === 'routesEliminated') {
			if (Array.isArray(value) && value.every(isSafeRouteEliminationEntry)) {
				safe[key] = Object.freeze(value.map((entry) => Object.freeze({ ...entry })));
			}
			continue;
		}
		if (
			value === null ||
			typeof value === 'string' ||
			typeof value === 'boolean' ||
			(typeof value === 'number' && Number.isSafeInteger(value) && Number.isFinite(value))
		) {
			safe[key] = value;
		}
	}
	return Object.freeze(safe);
}

export class ModelUsageError extends Error {
	readonly code: ModelUsageErrorCode;
	readonly metadata: Readonly<ModelUsageErrorMetadata>;

	constructor(
		code: ModelUsageErrorCode | string,
		message?: string,
		metadata: unknown = {},
		options: ErrorOptions = {},
	) {
		if (!CODE_SET.has(code)) throw new TypeError(`Unsupported model usage error code: ${code}`);
		super(String(message || code), options);
		this.name = 'ModelUsageError';
		this.code = code as ModelUsageErrorCode;
		this.metadata = copySafeMetadata(metadata);
	}

	toJSON(): SerializedModelUsageError {
		return {
			schemaVersion: '1.0.0',
			name: this.name,
			code: this.code,
			message: this.message,
			metadata: { ...this.metadata },
		};
	}

	static fromJSON(value: unknown): ModelUsageError {
		if (!value || typeof value !== 'object') {
			throw new TypeError('Invalid serialized ModelUsageError');
		}
		const rec = value as Record<string, unknown>;
		if (rec.schemaVersion !== '1.0.0' || rec.name !== 'ModelUsageError') {
			throw new TypeError('Invalid serialized ModelUsageError');
		}
		return new ModelUsageError(String(rec.code ?? ''), String(rec.message ?? ''), rec.metadata);
	}
}

export function asModelUsageError(
	error: unknown,
	fallbackCode: ModelUsageErrorCode,
	fallbackMessage: string,
	metadata: unknown = {},
): ModelUsageError {
	if (error instanceof ModelUsageError) return error;
	return new ModelUsageError(fallbackCode, fallbackMessage, metadata, { cause: error });
}
