/**
 * Route shape, provider mapping, pricing, and reasoning rules.
 * Imported by policy validation and local merge, never by policy.ts consumers.
 */
import {
	closed,
	object,
	repositoryPathArray,
	required,
	safeInteger,
} from './policy-field-validators.ts';
import type { RoutePricing } from '../routing/pricing.ts';

export interface RouteLimits {
	maxPromptTokens: number;
	maxCompletionTokens: number;
	maxTotalTokens: number;
	maxPhysicalCalls: number;
	maxCostMicrousd: number;
	maxPremiumRequestUnits: number;
	maxConcurrentReservations: number;
	attemptTimeoutMs: number;
}

export interface RouteReasoning {
	effort: string;
}

export interface PolicyRoute {
	id: string;
	provider: string;
	model: string;
	canonicalVendor: string;
	classification: string;
	qualityTier: number;
	enabled: boolean;
	metered: boolean;
	capabilities: string[];
	credentialEnv: string | null;
	baseUrl: string | null;
	requestUnitName: string;
	premiumRequestUnits: number;
	framing: string;
	limits: RouteLimits;
	pricing: RoutePricing;
	reasoning?: RouteReasoning;
}

export interface ProviderBoundaryConfig {
	registeredConsumerRoots: string[];
	allowedAdapterRoots: string[];
	allowedSetupFiles: string[];
}

export const PROVIDER_BOUNDARY_KEYS = new Set([
	'registeredConsumerRoots',
	'allowedAdapterRoots',
	'allowedSetupFiles',
]);

export const ROUTE_KEYS = new Set([
	'id',
	'provider',
	'model',
	'canonicalVendor',
	'classification',
	'qualityTier',
	'enabled',
	'metered',
	'capabilities',
	'credentialEnv',
	'baseUrl',
	'requestUnitName',
	'premiumRequestUnits',
	'framing',
	'limits',
	'pricing',
	'reasoning',
]);

export const REQUIRED_ROUTE_KEYS = new Set([...ROUTE_KEYS].filter((key) => key !== 'reasoning'));

export const REASONING_KEYS = new Set(['effort']);

const GOOGLE_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

const XAI_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
// Responses reasoning.effort is documented for these models only.
// grok-4.20 stays on the xAI chat-completions path and rejects the field.

const XAI_REASONING_MODELS = new Set(['grok-4.5', 'grok-4.6', 'grok-4.7']);
// gpt-6.1-sol accepts low, medium, and high. none, minimal, xhigh, and max are not sent.

const OPENAI_REASONING_MODELS = new Set(['gpt-6.1-sol']);

const OPENAI_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

export const EFFORT_RANK = new Map([
	['minimal', 0],
	['low', 1],
	['medium', 2],
	['high', 3],
]);

export const ROUTE_LIMIT_KEYS = new Set([
	'maxPromptTokens',
	'maxCompletionTokens',
	'maxTotalTokens',
	'maxPhysicalCalls',
	'maxCostMicrousd',
	'maxPremiumRequestUnits',
	'maxConcurrentReservations',
	'attemptTimeoutMs',
]);

const PRICING_KEYS = new Set([
	'status',
	'inputMicrousdPerMillionTokens',
	'outputMicrousdPerMillionTokens',
	'cacheReadMicrousdPerMillionTokens',
	'cacheWrite5mMicrousdPerMillionTokens',
	'fixedRequestMicrousd',
	'effectiveDate',
	'citationUrl',
]);

const CACHE_RATE_KEYS = [
	'cacheReadMicrousdPerMillionTokens',
	'cacheWrite5mMicrousdPerMillionTokens',
] as const;

export const CLASSIFICATIONS = new Set([
	'governed',
	'governed-conservative',
	'test-only',
	'disabled',
	'external-best-effort',
]);

export const PROVIDER_VENDOR = new Map([
	['anthropic', 'anthropic'],
	['fake', 'fake'],
	['google', 'google'],
	['openai-compatible', 'openai'],
	['xai', 'xai'],
	['copilot', 'github'],
]);

export function validateProviderBoundary(
	providerBoundary: unknown,
	name: string,
	{ partial = false }: { partial?: boolean } = {},
): void {
	const rec = object(providerBoundary, name);
	closed(rec, PROVIDER_BOUNDARY_KEYS, name);
	if (!partial) required(rec, PROVIDER_BOUNDARY_KEYS, name);
	for (const key of PROVIDER_BOUNDARY_KEYS) {
		if (rec[key] !== undefined) {
			repositoryPathArray(rec[key], `${name}.${key}`);
		}
	}
}

export function validateLimits(
	limits: unknown,
	allowed: ReadonlySet<string>,
	name: string,
	{ partial = false }: { partial?: boolean } = {},
): void {
	const rec = object(limits, name);
	closed(rec, allowed, name);
	if (!partial) required(rec, allowed, name);
	for (const [key, value] of Object.entries(rec)) safeInteger(value, `${name}.${key}`);
}

export function validatePricing(pricing: unknown, name: string): void {
	const rec = object(pricing, name);
	closed(rec, PRICING_KEYS, name);
	required(rec, new Set(['status']), name);
	if (typeof rec.status !== 'string' || !['known', 'unknown'].includes(rec.status)) {
		throw new TypeError(`${name}.status is invalid`);
	}
	if (rec.status === 'known') {
		const knownKeys = [
			'inputMicrousdPerMillionTokens',
			'outputMicrousdPerMillionTokens',
			'fixedRequestMicrousd',
		];
		required(rec, new Set(knownKeys), name);
		for (const key of knownKeys) {
			safeInteger(rec[key], `${name}.${key}`);
		}
		const presentCacheRates = CACHE_RATE_KEYS.filter((key) => rec[key] !== undefined);
		if (
			rec.cacheWrite5mMicrousdPerMillionTokens !== undefined &&
			rec.cacheReadMicrousdPerMillionTokens === undefined
		) {
			throw new TypeError(`${name} cache write rate requires a cache read rate`);
		}
		for (const key of presentCacheRates) safeInteger(rec[key], `${name}.${key}`);
		if (rec.effectiveDate !== undefined) {
			if (
				typeof rec.effectiveDate !== 'string' ||
				!/^\d{4}-\d{2}-\d{2}$/.test(rec.effectiveDate) ||
				Number.isNaN(Date.parse(rec.effectiveDate))
			) {
				throw new TypeError(`${name}.effectiveDate must be a valid ISO date`);
			}
		}
		if (rec.citationUrl !== undefined) {
			if (typeof rec.citationUrl !== 'string' || !rec.citationUrl.startsWith('https://')) {
				throw new TypeError(`${name}.citationUrl must be an https URL`);
			}
		}
	} else if (Object.keys(rec).length !== 1) {
		throw new TypeError(`${name} unknown pricing must not contain rates`);
	}
}

function rejectReasoning(name: string, routeId: string, detail: string): never {
	throw new TypeError(`${name} route '${routeId}' ${detail}`);
}

export function validateRouteReasoning(route: PolicyRoute & Record<string, unknown>, name: string): void {
	const hasCapability = route.capabilities.includes('reasoning');
	const hasObject = Object.hasOwn(route, 'reasoning');
	if (!hasCapability && !hasObject) return;
	if (hasCapability !== hasObject) {
		rejectReasoning(
			name,
			route.id,
			'requires the reasoning capability and the reasoning object together',
		);
	}
	if (!route.reasoning || typeof route.reasoning !== 'object' || Array.isArray(route.reasoning)) {
		rejectReasoning(name, route.id, 'reasoning must be an object');
	}
	closed(route.reasoning, REASONING_KEYS, `${name} route '${route.id}' reasoning`);
	const effort = route.reasoning.effort;
	if (route.provider === 'google') {
		if (!GOOGLE_REASONING_EFFORTS.has(effort)) {
			rejectReasoning(name, route.id, 'google reasoning effort is not allowed');
		}
		return;
	}
	if (route.provider === 'xai') {
		if (!XAI_REASONING_MODELS.has(route.model)) {
			rejectReasoning(name, route.id, 'xai model does not accept reasoning_effort');
		}
		if (!XAI_REASONING_EFFORTS.has(effort)) {
			rejectReasoning(name, route.id, 'xai reasoning effort is not allowed');
		}
		return;
	}
	if (route.provider === 'openai-compatible') {
		if (!OPENAI_REASONING_MODELS.has(route.model)) {
			rejectReasoning(name, route.id, 'openai model does not accept reasoning_effort');
		}
		if (!OPENAI_REASONING_EFFORTS.has(effort)) {
			rejectReasoning(name, route.id, 'openai reasoning effort is not allowed');
		}
		return;
	}
	rejectReasoning(name, route.id, `provider '${route.provider}' does not accept reasoning`);
}
