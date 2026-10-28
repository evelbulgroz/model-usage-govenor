import { ModelUsageError } from '../policy/errors.ts';

export interface RoutePricing {
	status: 'known' | 'unknown';
	inputMicrousdPerMillionTokens?: number;
	outputMicrousdPerMillionTokens?: number;
	cacheReadMicrousdPerMillionTokens?: number;
	cacheWrite5mMicrousdPerMillionTokens?: number;
	fixedRequestMicrousd?: number;
	premiumRequestUnits?: number;
	effectiveDate?: string;
	citationUrl?: string;
}

export interface PriceComponents {
	readonly inputMicrousd: number;
	readonly outputMicrousd: number;
	readonly fixedMicrousd: number;
	readonly cacheReadMicrousd?: number;
	readonly cacheWriteMicrousd?: number;
}

export interface PriceResult {
	readonly costMicrousd: number | 'unknown';
	readonly premiumRequestUnits: number;
	readonly components?: PriceComponents;
}

function integer(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative safe integer`);
	}
	return value;
}

function checkedAdd(left: number, right: number): number {
	const value = left + right;
	if (!Number.isSafeInteger(value)) throw new RangeError('Pricing arithmetic overflow');
	return value;
}

function roundedComponent(tokens: unknown, rate: unknown): number {
	const t = integer(tokens, 'tokens');
	const r = integer(rate, 'rate');
	if (t === 0 || r === 0) return 0;
	const product = BigInt(t) * BigInt(r);
	const rounded = (product + 999_999n) / 1_000_000n;
	if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Pricing arithmetic overflow');
	return Number(rounded);
}

export function calculatePrice({
	promptTokens,
	completionTokens,
	cacheReadTokens = 0,
	cacheWriteTokens = 0,
	pricing,
	premiumRequestUnits,
	metered = false,
	hardCostCeiling = false,
}: {
	promptTokens: number;
	completionTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	pricing?: RoutePricing | null;
	premiumRequestUnits?: number;
	metered?: boolean;
	hardCostCeiling?: boolean;
}): PriceResult {
	void metered;
	const validPrompt = integer(promptTokens, 'promptTokens');
	const validCompletion = integer(completionTokens, 'completionTokens');
	const validCacheRead = integer(cacheReadTokens, 'cacheReadTokens');
	const validCacheWrite = integer(cacheWriteTokens, 'cacheWriteTokens');
	const units = integer(
		premiumRequestUnits ?? pricing?.premiumRequestUnits ?? 0,
		'premiumRequestUnits',
	);
	if (!pricing || pricing.status === 'unknown') {
		if (hardCostCeiling) {
			throw new ModelUsageError(
				'ERR_COST_BUDGET_EXCEEDED',
				'Route has no calculable price under an active monetary ceiling',
				{ reason: 'unknown-pricing' },
			);
		}
		return Object.freeze({ costMicrousd: 'unknown', premiumRequestUnits: units });
	}
	const output = roundedComponent(
		validCompletion,
		integer(pricing.outputMicrousdPerMillionTokens, 'outputMicrousdPerMillionTokens'),
	);
	const fixed = integer(pricing.fixedRequestMicrousd ?? 0, 'fixedRequestMicrousd');
	let billedPromptTokens = validPrompt;
	let cacheRead = 0;
	let cacheWrite = 0;
	if (validCacheRead > 0 || validCacheWrite > 0) {
		const readRate = pricing.cacheReadMicrousdPerMillionTokens;
		if (validCacheWrite > 0) {
			cacheWrite = roundedComponent(
				validCacheWrite,
				integer(pricing.cacheWrite5mMicrousdPerMillionTokens, 'cacheWrite5mMicrousdPerMillionTokens'),
			);
		}
		// A missing read rate must not invent a discount. Those tokens stay on the input rate.
		if (validCacheRead > 0 && readRate === undefined) {
			billedPromptTokens = checkedAdd(billedPromptTokens, validCacheRead);
		} else if (readRate !== undefined) {
			cacheRead = roundedComponent(
				validCacheRead,
				integer(readRate, 'cacheReadMicrousdPerMillionTokens'),
			);
		}
	}
	const input = roundedComponent(
		billedPromptTokens,
		integer(pricing.inputMicrousdPerMillionTokens, 'inputMicrousdPerMillionTokens'),
	);
	return Object.freeze({
		costMicrousd: checkedAdd(checkedAdd(checkedAdd(input, output), fixed), checkedAdd(cacheRead, cacheWrite)),
		premiumRequestUnits: units,
		components: Object.freeze({
			inputMicrousd: input,
			outputMicrousd: output,
			fixedMicrousd: fixed,
			...(validCacheRead > 0 && pricing.cacheReadMicrousdPerMillionTokens !== undefined
				? { cacheReadMicrousd: cacheRead }
				: {}),
			...(validCacheWrite > 0 ? { cacheWriteMicrousd: cacheWrite } : {}),
		}),
	});
}

/**
 * A cold prompt-cache prefix is billed at the 5-minute write rate, above the base input rate.
 * Reserve that write so a cache miss still reconciles.
 */
export function calculateReservationPrice({
	promptTokens,
	completionTokens,
	pricing,
	cacheWriteEligible = false,
	premiumRequestUnits,
	metered = false,
	hardCostCeiling = false,
}: {
	promptTokens: number;
	completionTokens: number;
	pricing?: RoutePricing | null;
	cacheWriteEligible?: boolean;
	premiumRequestUnits?: number;
	metered?: boolean;
	hardCostCeiling?: boolean;
}): PriceResult {
	if (cacheWriteEligible === true) {
		return calculatePrice({
			promptTokens: 0,
			cacheWriteTokens: promptTokens,
			completionTokens,
			pricing,
			premiumRequestUnits,
			metered,
			hardCostCeiling,
		});
	}
	return calculatePrice({
		promptTokens,
		completionTokens,
		pricing,
		premiumRequestUnits,
		metered,
		hardCostCeiling,
	});
}
