/**
 * Lower-only merge of a local policy over the committed ceiling.
 * Equal values pass. A value one above the parent ceiling is rejected.
 */
import { ModelUsageError } from './errors.ts';
import { canonicalJson, type ProfileLimits } from './operation-request.ts';
import {
	closed,
	ensureLower,
	object,
	stringArray,
} from './policy-field-validators.ts';
import {
	EFFORT_RANK,
	PROVIDER_BOUNDARY_KEYS,
	REASONING_KEYS,
	ROUTE_KEYS,
	ROUTE_LIMIT_KEYS,
	type ProviderBoundaryConfig,
	type RouteLimits,
	validateProviderBoundary,
} from './policy-route-catalog.ts';
import {
	INSTANCE_KEYS,
	LIMIT_KEYS,
	type InstanceLimits,
	type ModelUsagePolicy,
	PROFILE_KEYS,
	ROOT_KEYS,
	validatePolicy,
} from './policy-validation.ts';

export { ensureLower };

export function mergeLocalPolicy(
	committed: Readonly<ModelUsagePolicy>,
	localInput: unknown,
): Readonly<ModelUsagePolicy> {
	const local = object(localInput, 'localPolicy');
	closed(local, ROOT_KEYS, 'localPolicy');
	if (local.schemaVersion !== undefined && local.schemaVersion !== committed.schemaVersion) {
		throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', 'Local schema version differs');
	}
	const result = structuredClone(committed) as ModelUsagePolicy;
	if (local.pricingVersion !== undefined && local.pricingVersion !== committed.pricingVersion) {
		throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', 'Local pricing version differs');
	}
	if (local.providerBoundary !== undefined) {
		validateProviderBoundary(local.providerBoundary, 'localPolicy.providerBoundary', {
			partial: true,
		});
		const localBoundary = local.providerBoundary as Partial<ProviderBoundaryConfig>;
		for (const key of PROVIDER_BOUNDARY_KEYS as ReadonlySet<keyof ProviderBoundaryConfig>) {
			const entries = localBoundary[key];
			if (entries === undefined) continue;
			if (entries.some((entry) => !committed.providerBoundary[key].includes(entry))) {
				throw new ModelUsageError(
					'ERR_LIMIT_ESCALATION_FORBIDDEN',
					`Local policy broadens provider boundary ${key}`,
				);
			}
			result.providerBoundary[key] = [...entries];
		}
	}
	if (local.retryableOutcomes !== undefined) {
		const outcomes = stringArray(local.retryableOutcomes, 'localPolicy.retryableOutcomes');
		if (outcomes.some((outcome) => !committed.retryableOutcomes.includes(outcome))) {
			throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', 'Local policy broadens retries');
		}
		result.retryableOutcomes = outcomes;
	}
	if (local.instance !== undefined) {
		const localInstance = object(local.instance, 'localPolicy.instance');
		closed(localInstance, INSTANCE_KEYS, 'localPolicy.instance');
		for (const [key, value] of Object.entries(localInstance)) {
			const k = key as keyof InstanceLimits;
			result.instance[k] = ensureLower(value, committed.instance[k], `instance.${key}`);
		}
	}
	const explicitProfileRouteIds = new Set<string>();
	if (local.profiles !== undefined) {
		const localProfiles = object(local.profiles, 'localPolicy.profiles');
		for (const [profileId, rawOverride] of Object.entries(localProfiles)) {
			const parent = committed.profiles[profileId];
			if (!parent) throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', 'Local policy adds profile');
			const override = object(rawOverride, `localPolicy.profiles.${profileId}`);
			closed(override, PROFILE_KEYS, `localPolicy.profiles.${profileId}`);
			if (override.consumer !== undefined && override.consumer !== parent.consumer) {
				throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', 'Local policy changes consumer');
			}
			if (override.routeIds !== undefined) {
				const ids = stringArray(override.routeIds, `localPolicy.profiles.${profileId}.routeIds`);
				if (ids.some((id) => !parent.routeIds.includes(id))) {
					throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', 'Local policy adds profile route');
				}
				result.profiles[profileId].routeIds = ids;
				explicitProfileRouteIds.add(profileId);
			}
			if (override.limits !== undefined) {
				const overrideLimits = object(override.limits, `localPolicy.profiles.${profileId}.limits`);
				closed(overrideLimits, LIMIT_KEYS, `localPolicy.profiles.${profileId}.limits`);
				for (const [key, value] of Object.entries(overrideLimits)) {
					const k = key as keyof ProfileLimits;
					result.profiles[profileId].limits[k] = ensureLower(
						value,
						parent.limits[k],
						`profiles.${profileId}.${key}`,
					);
				}
				result.profiles[profileId].limits.maxRetriesPerRoute = Math.min(
					result.profiles[profileId].limits.maxRetriesPerRoute,
					Math.max(0, result.profiles[profileId].limits.maxPhysicalAttempts - 1),
				);
			}
		}
	}
	if (local.routes !== undefined) {
		if (!Array.isArray(local.routes)) throw new TypeError('localPolicy.routes must be an array');
		const parentRoutes = new Map(committed.routes.map((route) => [route.id, route]));
		for (const rawOverride of local.routes) {
			const override = object(rawOverride, 'localPolicy route');
			closed(override, ROUTE_KEYS, 'localPolicy route');
			const parent = typeof override.id === 'string' ? parentRoutes.get(override.id) : undefined;
			if (!parent) throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', 'Local policy adds route');
			const target = result.routes.find((route) => route.id === override.id);
			if (!target) throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', 'Local policy adds route');
			const immutableKeys = [
				'provider',
				'model',
				'canonicalVendor',
				'classification',
				'metered',
				'credentialEnv',
				'baseUrl',
				'requestUnitName',
				'premiumRequestUnits',
				'framing',
				'pricing',
			] as const;
			for (const immutable of immutableKeys) {
				if (
					override[immutable] !== undefined &&
					canonicalJson(override[immutable]) !== canonicalJson(parent[immutable])
				) {
					throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', `Local policy changes ${immutable}`);
				}
			}
			if (override.qualityTier !== undefined) {
				target.qualityTier = ensureLower(override.qualityTier, parent.qualityTier, `routes.${parent.id}.qualityTier`);
			}
			if (override.enabled !== undefined) {
				if (override.enabled && !parent.enabled) {
					throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', 'Local policy enables route');
				}
				target.enabled = Boolean(override.enabled);
			}
			if (override.capabilities !== undefined) {
				const capabilities = stringArray(override.capabilities, 'local route capabilities');
				if (capabilities.some((capability) => !parent.capabilities.includes(capability))) {
					throw new ModelUsageError('ERR_LIMIT_ESCALATION_FORBIDDEN', 'Local policy adds capability');
				}
				target.capabilities = capabilities;
			}
			if (override.reasoning !== undefined) {
				if (!parent.capabilities.includes('reasoning') || !Object.hasOwn(parent, 'reasoning') || !parent.reasoning) {
					throw new ModelUsageError(
						'ERR_LIMIT_ESCALATION_FORBIDDEN',
						`Local policy adds reasoning on route '${parent.id}'`,
						{ routeId: parent.id },
					);
				}
				if (
					!override.reasoning ||
					typeof override.reasoning !== 'object' ||
					Array.isArray(override.reasoning)
				) {
					throw new TypeError(`local policy route '${parent.id}' reasoning must be an object`);
				}
				const overrideReasoning = override.reasoning as Record<string, unknown>;
				closed(overrideReasoning, REASONING_KEYS, `local policy route '${parent.id}' reasoning`);
				const nextEffort = String(overrideReasoning.effort ?? '');
				const parentRank = EFFORT_RANK.get(parent.reasoning.effort);
				const nextRank = EFFORT_RANK.get(nextEffort);
				if (parentRank !== undefined && nextRank !== undefined && nextRank > parentRank) {
					throw new ModelUsageError(
						'ERR_LIMIT_ESCALATION_FORBIDDEN',
						`routes.${parent.id}.reasoning.effort cannot raise its parent ceiling`,
						{
							dimension: `routes.${parent.id}.reasoning.effort`,
							limit: parent.reasoning.effort,
							requested: nextEffort,
							routeId: parent.id,
						},
					);
				}
				target.reasoning = { effort: nextEffort };
			}
			if (!target.capabilities.includes('reasoning') && override.reasoning === undefined) {
				delete target.reasoning;
			}
			if (override.limits !== undefined) {
				const overrideLimits = object(override.limits, 'local route limits');
				closed(overrideLimits, ROUTE_LIMIT_KEYS, 'local route limits');
				for (const [key, value] of Object.entries(overrideLimits)) {
					const k = key as keyof RouteLimits;
					target.limits[k] = ensureLower(value, parent.limits[k], `routes.${parent.id}.${key}`);
				}
			}
		}
		const orderedIds: string[] = [];
		for (const rawOverride of local.routes) {
			const id = (rawOverride as { id: string }).id;
			if (!orderedIds.includes(id)) orderedIds.push(id);
		}
		if (orderedIds.length > 1) {
			const orderedSet = new Set(orderedIds);
			const orderedRoutes = orderedIds.map((id) => result.routes.find((r) => r.id === id)!);
			let nextIdx = 0;
			result.routes = result.routes.map((r) =>
				orderedSet.has(r.id) ? orderedRoutes[nextIdx++]! : r,
			);
			const routeRank = new Map(result.routes.map((r, index) => [r.id, index]));
			for (const [profileId, profile] of Object.entries(result.profiles)) {
				if (!explicitProfileRouteIds.has(profileId)) {
					profile.routeIds = [...profile.routeIds].sort(
						(a, b) => (routeRank.get(a) ?? 0) - (routeRank.get(b) ?? 0),
					);
				}
			}
		}
	}
	return validatePolicy(result);
}

export function resolvePolicy(committedInput: unknown, localInput?: unknown): Readonly<ModelUsagePolicy> {
	const committed = validatePolicy(committedInput);
	return localInput === undefined ? committed : mergeLocalPolicy(committed, localInput);
}
