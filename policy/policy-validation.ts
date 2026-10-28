/**
 * Committed policy schema checks and the built-in safety ceiling.
 * Local merge calls validatePolicy and does not import policy.ts.
 */
import { ModelUsageError } from './errors.ts';
import type { ProfileLimits } from './operation-request.ts';
import {
	IDENTIFIER,
	closed,
	deepFreeze,
	object,
	required,
	safeInteger,
	string,
	stringArray,
} from './policy-field-validators.ts';
import {
	CLASSIFICATIONS,
	PROVIDER_VENDOR,
	REQUIRED_ROUTE_KEYS,
	ROUTE_KEYS,
	ROUTE_LIMIT_KEYS,
	type PolicyRoute,
	type ProviderBoundaryConfig,
	validateLimits,
	validatePricing,
	validateProviderBoundary,
	validateRouteReasoning,
} from './policy-route-catalog.ts';

export interface InstanceLimits {
	maxTotalTokens: number;
	maxPhysicalCalls: number;
	maxCostMicrousd: number;
	maxPremiumRequestUnits: number;
	maxConcurrentReservations: number;
}

export interface PolicyProfile {
	consumer: string;
	routeIds: string[];
	limits: ProfileLimits;
}

export interface ModelUsagePolicy {
	schemaVersion: '1.0.0';
	pricingVersion: string;
	instance: InstanceLimits;
	profiles: Record<string, PolicyProfile>;
	routes: PolicyRoute[];
	retryableOutcomes: string[];
	providerBoundary: ProviderBoundaryConfig;
}

export const ROOT_KEYS = new Set([
	'schemaVersion',
	'pricingVersion',
	'instance',
	'profiles',
	'routes',
	'retryableOutcomes',
	'providerBoundary',
]);

export const INSTANCE_KEYS = new Set([
	'maxTotalTokens',
	'maxPhysicalCalls',
	'maxCostMicrousd',
	'maxPremiumRequestUnits',
	'maxConcurrentReservations',
]);

export const PROFILE_KEYS = new Set(['consumer', 'routeIds', 'limits']);

export const LIMIT_KEYS = new Set([
	'maxPromptTokens',
	'maxCompletionTokens',
	'maxTotalTokens',
	'maxPhysicalAttempts',
	'maxRetriesPerRoute',
	'maxFailovers',
	'maxConcurrentOperations',
	'operationTimeoutMs',
	'runTimeoutMs',
	'runMaxTotalTokens',
	'runMaxPhysicalCalls',
	'runMaxCostMicrousd',
	'runMaxPremiumRequestUnits',
]);

const OUTCOMES = new Set([
	'timeout',
	'cancelled',
	'quota',
	'transport',
	'http_4xx',
	'http_5xx',
	'malformed_output',
]);

export const BUILTIN_SAFETY = Object.freeze({
	maxPromptTokens: 1_000_000,
	maxCompletionTokens: 1_000_000,
	// Four reservations of the implementer ceiling: 968000 prompt plus 16000 completion.
	maxTotalTokens: 3_936_000,
	maxPhysicalAttempts: 10,
	maxRetriesPerRoute: 9,
	maxFailovers: 5,
	maxConcurrentOperations: 16,
	operationTimeoutMs: 3_600_000,
	runTimeoutMs: 86_400_000,
} as const);

function assertConsistentLimits(limits: ProfileLimits, name: string): void {
	if (limits.runMaxTotalTokens < limits.maxTotalTokens) {
		throw new TypeError(`${name} run token ceiling is below operation ceiling`);
	}
	if (limits.runMaxPhysicalCalls < limits.maxPhysicalAttempts) {
		throw new TypeError(`${name} run call ceiling is below operation attempt ceiling`);
	}
	if (limits.maxRetriesPerRoute >= limits.maxPhysicalAttempts) {
		throw new TypeError(`${name} retry ceiling must be below physical attempt ceiling`);
	}
	const conservativeReservation = limits.maxPromptTokens + limits.maxCompletionTokens;
	if (
		limits.maxPhysicalAttempts > 1 &&
		limits.maxTotalTokens < limits.maxPhysicalAttempts * conservativeReservation
	) {
		throw new TypeError(
			`${name} operation token ceiling cannot fund ${limits.maxPhysicalAttempts} conservative maximum reservations`,
		);
	}
}

export function validatePolicy(input: unknown): Readonly<ModelUsagePolicy> {
	const policy = structuredClone(input) as ModelUsagePolicy & Record<string, unknown>;
	closed(policy, ROOT_KEYS, 'policy');
	required(policy, ROOT_KEYS, 'policy');
	if (policy.schemaVersion !== '1.0.0') throw new TypeError('Unsupported policy schemaVersion');
	string(policy.pricingVersion, 'policy.pricingVersion');
	closed(policy.instance, INSTANCE_KEYS, 'policy.instance');
	required(policy.instance, INSTANCE_KEYS, 'policy.instance');
	for (const [key, value] of Object.entries(policy.instance)) {
		safeInteger(value, `policy.instance.${key}`);
	}
	object(policy.profiles, 'policy.profiles');
	if (Object.keys(policy.profiles).length === 0) throw new TypeError('policy.profiles must not be empty');
	const routes = new Map<string, PolicyRoute>();
	if (!Array.isArray(policy.routes) || policy.routes.length === 0) {
		throw new TypeError('policy.routes must not be empty');
	}
	for (const [index, rawRoute] of policy.routes.entries()) {
		const name = `policy.routes[${index}]`;
		const route = object(rawRoute, name) as PolicyRoute & Record<string, unknown>;
		closed(route, ROUTE_KEYS, name);
		required(route, REQUIRED_ROUTE_KEYS, name);
		string(route.id, `${name}.id`, IDENTIFIER);
		if (routes.has(route.id)) throw new TypeError(`Duplicate route id '${route.id}'`);
		string(route.provider, `${name}.provider`);
		string(route.model, `${name}.model`);
		string(route.canonicalVendor, `${name}.canonicalVendor`);
		if (PROVIDER_VENDOR.get(route.provider) !== route.canonicalVendor) {
			throw new TypeError(`${name} provider and canonicalVendor mapping is invalid`);
		}
		if (!CLASSIFICATIONS.has(route.classification)) throw new TypeError(`${name}.classification invalid`);
		safeInteger(route.qualityTier, `${name}.qualityTier`);
		if (route.qualityTier < 1) throw new TypeError(`${name}.qualityTier must be >= 1`);
		if (typeof route.enabled !== 'boolean' || typeof route.metered !== 'boolean') {
			throw new TypeError(`${name} enabled and metered must be booleans`);
		}
		if (route.enabled && ['disabled', 'external-best-effort'].includes(route.classification)) {
			throw new TypeError(`${name} classification cannot be enabled`);
		}
		stringArray(route.capabilities, `${name}.capabilities`);
		if (route.credentialEnv !== null && route.credentialEnv !== undefined) {
			if (typeof route.credentialEnv !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(route.credentialEnv)) {
				throw new TypeError(`${name}.credentialEnv must be an environment variable name`);
			}
		}
		if (route.baseUrl !== null) {
			const url = new URL(String(route.baseUrl));
			if (url.protocol !== 'https:') throw new TypeError(`${name}.baseUrl must use https`);
		}
		if (typeof route.framing !== 'string') {
			throw new TypeError(`${name}.framing must be a string`);
		}
		string(route.requestUnitName, `${name}.requestUnitName`);
		safeInteger(route.premiumRequestUnits, `${name}.premiumRequestUnits`);
		validateLimits(route.limits, ROUTE_LIMIT_KEYS, `${name}.limits`);
		validatePricing(route.pricing, `${name}.pricing`);
		if (route.enabled && route.metered) {
			if (route.pricing.status !== 'known') {
				throw new TypeError(`${name} enabled metered route requires known pricing`);
			}
			if (!route.pricing.effectiveDate) {
				throw new TypeError(`${name} enabled metered route requires effectiveDate`);
			}
			if (!route.pricing.citationUrl) {
				throw new TypeError(`${name} enabled metered route requires citationUrl`);
			}
		}
		validateRouteReasoning(route, name);
		routes.set(route.id, route);
	}
	const effectiveDates = policy.routes
		.map((r) => r.pricing?.effectiveDate)
		.filter((d): d is string => typeof d === 'string');
	if (effectiveDates.length > 0) {
		const maxEffectiveDate = effectiveDates.reduce((max, d) => (d > max ? d : max), effectiveDates[0]);
		if (policy.pricingVersion !== maxEffectiveDate) {
			throw new TypeError(
				`policy.pricingVersion '${policy.pricingVersion}' must equal maximum route pricing effectiveDate '${maxEffectiveDate}'`,
			);
		}
	}
	for (const [profileId, rawProfile] of Object.entries(policy.profiles)) {
		string(profileId, `policy profile id`, IDENTIFIER);
		const profile = object(rawProfile, `policy.profiles.${profileId}`) as PolicyProfile &
			Record<string, unknown>;
		closed(profile, PROFILE_KEYS, `policy.profiles.${profileId}`);
		required(profile, PROFILE_KEYS, `policy.profiles.${profileId}`);
		string(profile.consumer, `policy.profiles.${profileId}.consumer`, IDENTIFIER);
		stringArray(profile.routeIds, `policy.profiles.${profileId}.routeIds`);
		for (const routeId of profile.routeIds) {
			if (!routes.has(routeId)) throw new TypeError(`Profile '${profileId}' references unknown route '${routeId}'`);
		}
		validateLimits(profile.limits, LIMIT_KEYS, `policy.profiles.${profileId}.limits`);
		for (const key of Object.keys(BUILTIN_SAFETY) as Array<keyof typeof BUILTIN_SAFETY>) {
			const maximum = BUILTIN_SAFETY[key];
			if (profile.limits[key] > maximum) {
				throw new ModelUsageError(
					'ERR_LIMIT_ESCALATION_FORBIDDEN',
					`Committed policy exceeds built-in ${key}`,
					{ dimension: key, limit: maximum, requested: profile.limits[key] },
				);
			}
		}
		assertConsistentLimits(profile.limits, `policy.profiles.${profileId}.limits`);
	}
	stringArray(policy.retryableOutcomes, 'policy.retryableOutcomes');
	if (policy.retryableOutcomes.some((outcome) => !OUTCOMES.has(outcome))) {
		throw new TypeError('policy.retryableOutcomes contains an invalid outcome');
	}
	validateProviderBoundary(policy.providerBoundary, 'policy.providerBoundary');
	return deepFreeze(policy);
}
