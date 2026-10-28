/**
 * Operation request validation, prompt normalization, and input hashing.
 * Ledger modules take canonicalJson and the id checks from here, not from policy.ts.
 */
import crypto from 'node:crypto';
import { ModelUsageError } from './errors.ts';
import {
	IDENTIFIER,
	OPERATION_IDENTIFIER,
	closed,
	deepFreeze,
	ensureLower,
	object,
	safeInteger,
	string,
	stringArray,
} from './policy-field-validators.ts';
import type { StructuredOutputSchema } from '../governor/structured-output-schema.ts';

export type RoutingStrategy = 'min-cost' | 'balanced' | 'quality-first';

export interface OperationAttribution {
	taskId?: string;
	nodeId?: string;
	roleId?: string;
	generation?: number;
	nodeAttempt?: number;
	phase?: string;
	scope?: string;
	[key: string]: string | number | undefined;
}

export interface RoutingConstraints {
	excludedVendors?: readonly string[];
	requiredCapabilities?: readonly string[];
	preferredRouteIds?: readonly string[];
	strategy?: RoutingStrategy;
	minQualityTier?: 1 | 2 | 3;
}

export interface RequestedLimits {
	maxPromptTokens?: number;
	maxCompletionTokens?: number;
	timeoutMs?: number;
	maxCostMicrousd?: number;
	maxPremiumRequestUnits?: number;
	maxPhysicalAttempts?: number;
	maxRetriesPerRoute?: number;
	maxFailovers?: number;
}

export interface OperationRequest {
	schemaVersion: '1.0.0';
	operationId: string;
	runId: string;
	consumer: string;
	profile: string;
	attribution?: OperationAttribution;
	prompt: string;
	promptBlocks?: readonly string[];
	promptCacheBreakpoint?: number;
	structuredOutputSchema: StructuredOutputSchema;
	routingConstraints?: RoutingConstraints;
	requestedLimits?: RequestedLimits;
	taskId?: string;
}

export interface NormalizedOperationRequest {
	readonly schemaVersion: '1.0.0';
	readonly operationId: string;
	readonly runId: string;
	readonly consumer: string;
	readonly profile: string;
	readonly attribution: Readonly<OperationAttribution>;
	readonly prompt: string;
	readonly promptBlocks?: readonly string[];
	readonly promptCacheBreakpoint?: number;
	readonly structuredOutputSchema: StructuredOutputSchema;
	readonly routingConstraints: {
		readonly excludedVendors: readonly string[];
		readonly requiredCapabilities: readonly string[];
		readonly preferredRouteIds: readonly string[];
		readonly strategy?: RoutingStrategy;
		readonly minQualityTier?: 1 | 2 | 3;
	};
	readonly requestedLimits: Readonly<RequestedLimits>;
	readonly taskId?: string;
}

export interface ProfileLimits {
	maxPromptTokens: number;
	maxCompletionTokens: number;
	maxTotalTokens: number;
	maxPhysicalAttempts: number;
	maxRetriesPerRoute: number;
	maxFailovers: number;
	maxConcurrentOperations: number;
	operationTimeoutMs: number;
	runTimeoutMs: number;
	runMaxTotalTokens: number;
	runMaxPhysicalCalls: number;
	runMaxCostMicrousd: number;
	runMaxPremiumRequestUnits: number;
}

export interface EffectiveProfile {
	readonly id: string;
	readonly consumer: string;
	readonly routeIds: readonly string[];
	readonly limits: Readonly<ProfileLimits>;
}

const REQUEST_KEYS = new Set([
	'schemaVersion',
	'operationId',
	'runId',
	'consumer',
	'profile',
	'attribution',
	'prompt',
	'promptBlocks',
	'promptCacheBreakpoint',
	'structuredOutputSchema',
	'routingConstraints',
	'requestedLimits',
]);

const ATTRIBUTION_KEYS = new Set([
	'taskId',
	'nodeId',
	'roleId',
	'generation',
	'nodeAttempt',
	'phase',
	'scope',
]);

const ROUTING_KEYS = new Set([
	'excludedVendors',
	'requiredCapabilities',
	'preferredRouteIds',
	'strategy',
	'minQualityTier',
]);

const REQUEST_LIMIT_KEYS = new Set([
	'maxPromptTokens',
	'maxCompletionTokens',
	'timeoutMs',
	'maxCostMicrousd',
	'maxPremiumRequestUnits',
	'maxPhysicalAttempts',
	'maxRetriesPerRoute',
	'maxFailovers',
]);

const NON_NEGATIVE_REQUEST_LIMITS = new Set([
	'maxRetriesPerRoute',
	'maxFailovers',
	'maxCostMicrousd',
	'maxPremiumRequestUnits',
]);

export function validateRunId(value: unknown): string {
	return string(value, 'runId', IDENTIFIER);
}

export function validateOperationId(value: unknown): string {
	return string(value, 'operationId', OPERATION_IDENTIFIER);
}

export function validateOperationRequest(input: unknown): Readonly<OperationRequest> {
	const request = structuredClone(input) as OperationRequest & Record<string, unknown>;
	closed(request, REQUEST_KEYS, 'request');
	if (request.schemaVersion !== '1.0.0') throw new TypeError('Unsupported request schemaVersion');
	validateOperationId(request.operationId);
	validateRunId(request.runId);
	string(request.consumer, 'request.consumer', IDENTIFIER);
	string(request.profile, 'request.profile', IDENTIFIER);
	if (typeof request.prompt !== 'string' || request.prompt.length === 0) {
		throw new TypeError('request.prompt must be a non-empty string');
	}
	object(request.structuredOutputSchema, 'request.structuredOutputSchema');
	if (request.attribution !== undefined) {
		closed(request.attribution, ATTRIBUTION_KEYS, 'request.attribution');
		for (const [key, value] of Object.entries(request.attribution as Record<string, unknown>)) {
			if (['generation', 'nodeAttempt'].includes(key)) safeInteger(value, `attribution.${key}`);
			else string(value, `attribution.${key}`);
		}
	}
	if (request.routingConstraints !== undefined) {
		const rc = object(request.routingConstraints, 'request.routingConstraints');
		closed(rc, ROUTING_KEYS, 'request.routingConstraints');
		for (const key of ['excludedVendors', 'requiredCapabilities', 'preferredRouteIds']) {
			if (rc[key] !== undefined) {
				stringArray(rc[key], `routingConstraints.${key}`);
			}
		}
		if (rc.strategy !== undefined) {
			if (
				typeof rc.strategy !== 'string' ||
				!['min-cost', 'balanced', 'quality-first'].includes(rc.strategy)
			) {
				throw new TypeError('routingConstraints.strategy must be min-cost, balanced, or quality-first');
			}
		}
		if (rc.minQualityTier !== undefined) {
			const tier = safeInteger(rc.minQualityTier, 'routingConstraints.minQualityTier');
			if (![1, 2, 3].includes(tier)) {
				throw new TypeError('routingConstraints.minQualityTier must be 1, 2, or 3');
			}
		}
	}
	if (request.requestedLimits !== undefined) {
		closed(request.requestedLimits, REQUEST_LIMIT_KEYS, 'request.requestedLimits');
		for (const [key, value] of Object.entries(request.requestedLimits as Record<string, unknown>)) {
			safeInteger(value, `requestedLimits.${key}`, {
				positive: !NON_NEGATIVE_REQUEST_LIMITS.has(key),
			});
		}
	}
	if (request.promptBlocks !== undefined) {
		if (!Array.isArray(request.promptBlocks) || request.promptBlocks.length < 2) {
			throw new TypeError('request.promptBlocks must contain at least two strings');
		}
		for (let index = 0; index < request.promptBlocks.length; index += 1) {
			const block = request.promptBlocks[index];
			if (typeof block !== 'string' || block.length === 0) {
				throw new TypeError(`request.promptBlocks[${index}] must be a non-empty string`);
			}
		}
	}
	if (request.promptCacheBreakpoint !== undefined) {
		if (!Array.isArray(request.promptBlocks)) {
			throw new TypeError('request.promptCacheBreakpoint requires promptBlocks');
		}
		const bp = safeInteger(request.promptCacheBreakpoint, 'request.promptCacheBreakpoint');
		if (bp >= request.promptBlocks.length - 1) {
			throw new TypeError(
				'request.promptCacheBreakpoint must leave a trailing block outside the cache prefix',
			);
		}
	}
	return deepFreeze(request);
}

export function effectiveProfile(
	policy: {
		profiles: Record<
			string,
			{ consumer: string; routeIds: readonly string[]; limits: ProfileLimits }
		>;
	},
	request: { profile: string; consumer: string; requestedLimits?: RequestedLimits },
): EffectiveProfile {
	const profile = policy.profiles[request.profile];
	if (!profile || profile.consumer !== request.consumer) {
		throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', 'Consumer is not registered for profile', {
			consumer: request.consumer,
			profile: request.profile,
		});
	}
	const limits = structuredClone(profile.limits);
	const requested = request.requestedLimits ?? {};
	const mapping: ReadonlyArray<[keyof RequestedLimits, keyof ProfileLimits]> = [
		['maxPromptTokens', 'maxPromptTokens'],
		['maxCompletionTokens', 'maxCompletionTokens'],
		['timeoutMs', 'operationTimeoutMs'],
		['maxCostMicrousd', 'runMaxCostMicrousd'],
		['maxPremiumRequestUnits', 'runMaxPremiumRequestUnits'],
		['maxPhysicalAttempts', 'maxPhysicalAttempts'],
		['maxRetriesPerRoute', 'maxRetriesPerRoute'],
		['maxFailovers', 'maxFailovers'],
	];
	for (const [requestKey, policyKey] of mapping) {
		if (requested[requestKey] !== undefined) {
			limits[policyKey] = ensureLower(
				requested[requestKey],
				profile.limits[policyKey],
				`requestedLimits.${requestKey}`,
			);
		}
		limits.maxRetriesPerRoute = Math.min(
			limits.maxRetriesPerRoute,
			Math.max(0, limits.maxPhysicalAttempts - 1),
		);
	}
	limits.maxTotalTokens = Math.min(
		limits.maxTotalTokens,
		limits.maxPhysicalAttempts * (limits.maxPromptTokens + limits.maxCompletionTokens),
	);
	return deepFreeze({
		id: request.profile,
		consumer: profile.consumer,
		routeIds: [...profile.routeIds],
		limits,
	});
}

export function canonicalJson(value: unknown): string {
	if (value === undefined) return 'null';
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
	const rec = value as Record<string, unknown>;
	const keys = Object.keys(rec).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(rec[key])}`).join(',')}}`;
}

export function normalizePrompt(prompt: unknown): string {
	if (typeof prompt !== 'string') throw new TypeError('prompt must be a string');
	return prompt.replace(/\r\n?/g, '\n').normalize('NFC');
}

function normalizedPromptBlocks(
	blocks: readonly string[] | undefined,
	prompt: string,
): string[] | undefined {
	if (blocks === undefined) return undefined;
	const normalized = blocks.map((block) => normalizePrompt(block));
	if (normalized.join('\n') !== prompt) {
		throw new TypeError('request.promptBlocks must join to prompt');
	}
	return normalized;
}

export function normalizedOperationInput(request: unknown): NormalizedOperationRequest {
	const validated = validateOperationRequest(request);
	const prompt = normalizePrompt(validated.prompt);
	const promptBlocks = normalizedPromptBlocks(validated.promptBlocks, prompt);
	return deepFreeze({
		schemaVersion: validated.schemaVersion,
		operationId: validated.operationId,
		runId: validated.runId,
		consumer: validated.consumer,
		profile: validated.profile,
		attribution: validated.attribution ?? {},
		prompt,
		...(promptBlocks ? { promptBlocks } : {}),
		...(validated.promptCacheBreakpoint !== undefined
			? { promptCacheBreakpoint: validated.promptCacheBreakpoint }
			: {}),
		structuredOutputSchema: validated.structuredOutputSchema,
		routingConstraints: {
			excludedVendors: [...(validated.routingConstraints?.excludedVendors ?? [])].sort(),
			requiredCapabilities: [...(validated.routingConstraints?.requiredCapabilities ?? [])].sort(),
			preferredRouteIds: [...(validated.routingConstraints?.preferredRouteIds ?? [])],
			...(validated.routingConstraints?.strategy !== undefined
				? { strategy: validated.routingConstraints.strategy }
				: {}),
			...(validated.routingConstraints?.minQualityTier !== undefined
				? { minQualityTier: validated.routingConstraints.minQualityTier }
				: {}),
		},
		requestedLimits: validated.requestedLimits ?? {},
	});
}

export function operationInputHash(request: unknown): string {
	return crypto
		.createHash('sha256')
		.update(canonicalJson(normalizedOperationInput(request)))
		.digest('hex');
}
