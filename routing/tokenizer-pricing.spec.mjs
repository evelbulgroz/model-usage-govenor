import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import { calculatePrice, calculateReservationPrice } from './pricing.ts';
import { buildCanonicalPromptInput, estimatePromptTokens } from './tokenizer.ts';

test('tokenizer includes canonical schema and framing for empty and unicode prompts', () => {
	const schema = { properties: { café: { type: 'string' } }, type: 'object' };
	const serialized = buildCanonicalPromptInput('', schema, 'FRAME\n');
	assert.match(serialized, /^FRAME/);
	assert.match(serialized, /structured-output-schema/);
	const estimate = estimatePromptTokens({
		prompt: '😀',
		structuredOutputSchema: schema,
		routeFraming: 'FRAME\n',
		routeFramingTokens: 3,
	});
	assert.equal(estimate.promptTokens, estimate.serializedByteLength + 3 + 64);
	assert.equal(estimate.estimator.version, '2');
});

test('tokenizer rejects unsafe floors and integer overflow inputs', () => {
	assert.throws(
		() => estimatePromptTokens({ prompt: '', structuredOutputSchema: {}, bytesPerTokenFloor: 0 }),
		/positive safe integer/,
	);
	assert.throws(
		() =>
			estimatePromptTokens({
				prompt: '',
				structuredOutputSchema: {},
				routeFramingTokens: Number.MAX_SAFE_INTEGER,
			}),
		/overflow/,
	);
});

test('pricing rounds each known component upward and preserves premium units', () => {
	assert.deepEqual(
		calculatePrice({
			promptTokens: 1,
			completionTokens: 1,
			pricing: {
				status: 'known',
				inputMicrousdPerMillionTokens: 1,
				outputMicrousdPerMillionTokens: 1,
				fixedRequestMicrousd: 2,
			},
			premiumRequestUnits: 3,
		}),
		{
			costMicrousd: 4,
			premiumRequestUnits: 3,
			components: { inputMicrousd: 1, outputMicrousd: 1, fixedMicrousd: 2 },
		},
	);
});

test('unknown pricing is allowed only without a monetary ceiling and never treated as zero', () => {
	assert.deepEqual(
		calculatePrice({
			promptTokens: 1,
			completionTokens: 1,
			pricing: { status: 'unknown' },
			premiumRequestUnits: 2,
			hardCostCeiling: false,
		}),
		{ costMicrousd: 'unknown', premiumRequestUnits: 2 },
	);
	assert.throws(
		() =>
			calculatePrice({
				promptTokens: 1,
				completionTokens: 1,
				pricing: { status: 'unknown' },
				hardCostCeiling: true,
			}),
		(error) => error instanceof ModelUsageError && error.code === 'ERR_COST_BUDGET_EXCEEDED',
	);
});

const sonnetCachePricing = {
	status: 'known',
	inputMicrousdPerMillionTokens: 2_000_000,
	outputMicrousdPerMillionTokens: 10_000_000,
	cacheReadMicrousdPerMillionTokens: 100_000,
	cacheWrite5mMicrousdPerMillionTokens: 2_500_000,
	fixedRequestMicrousd: 0,
};

test('cache reads and 5-minute writes are priced apart from uncached input', () => {
	assert.deepEqual(
		calculatePrice({
			promptTokens: 1_000,
			cacheReadTokens: 100_000,
			cacheWriteTokens: 5_000,
			completionTokens: 10,
			pricing: sonnetCachePricing,
		}),
		{
			costMicrousd: 24_600,
			premiumRequestUnits: 0,
			components: {
				inputMicrousd: 2_000,
				outputMicrousd: 100,
				fixedMicrousd: 0,
				cacheReadMicrousd: 10_000,
				cacheWriteMicrousd: 12_500,
			},
		},
	);
	const fullInput = calculatePrice({
		promptTokens: 106_000,
		completionTokens: 10,
		pricing: sonnetCachePricing,
	});
	assert.equal(fullInput.costMicrousd, 212_100);
	assert.ok(24_600 < fullInput.costMicrousd);
});

test('a cache write reservation prices the whole prompt at the 5-minute write rate', () => {
	const reserved = calculateReservationPrice({
		promptTokens: 1_000_000,
		completionTokens: 0,
		pricing: sonnetCachePricing,
		cacheWriteEligible: true,
	});
	assert.equal(reserved.costMicrousd, 2_500_000);
	const base = calculateReservationPrice({
		promptTokens: 1_000_000,
		completionTokens: 0,
		pricing: sonnetCachePricing,
		cacheWriteEligible: false,
	});
	assert.equal(base.costMicrousd, 2_000_000);
});

test('cache reads without a read rate stay on the input rate, and a write without a write rate fails closed', () => {
	const pricing = {
		status: 'known',
		inputMicrousdPerMillionTokens: 2_000_000,
		outputMicrousdPerMillionTokens: 1,
		fixedRequestMicrousd: 0,
	};
	const folded = calculatePrice({
		promptTokens: 100,
		cacheReadTokens: 50,
		completionTokens: 0,
		pricing,
	});
	const asInput = calculatePrice({ promptTokens: 150, completionTokens: 0, pricing });
	assert.equal(folded.costMicrousd, asInput.costMicrousd);
	assert.equal(folded.components.cacheReadMicrousd, undefined);
	assert.equal(folded.components.inputMicrousd, asInput.components.inputMicrousd);
	assert.throws(() =>
		calculatePrice({
			promptTokens: 0,
			cacheWriteTokens: 1,
			completionTokens: 0,
			pricing,
		}),
	);
	assert.throws(() => calculatePrice({ promptTokens: 0, cacheReadTokens: -1, completionTokens: 0 }));
});

test('a cache read rate without a write rate prices the read and leaves the reservation on input', () => {
	const pricing = {
		status: 'known',
		inputMicrousdPerMillionTokens: 750_000,
		outputMicrousdPerMillionTokens: 3_750_000,
		cacheReadMicrousdPerMillionTokens: 75_000,
		fixedRequestMicrousd: 0,
	};
	const priced = calculatePrice({
		promptTokens: 1_000,
		cacheReadTokens: 1_000_000,
		completionTokens: 0,
		pricing,
	});
	assert.equal(priced.costMicrousd, 75_750);
	assert.equal(priced.components.cacheReadMicrousd, 75_000);
	assert.equal(priced.components.cacheWriteMicrousd, undefined);
	const reserved = calculateReservationPrice({
		promptTokens: 1_000_000,
		completionTokens: 0,
		pricing,
		cacheWriteEligible: false,
	});
	assert.equal(reserved.costMicrousd, 750_000);
});

test('pricing rejects negative, fractional and overflowing arithmetic', () => {
	assert.throws(() => calculatePrice({ promptTokens: -1, completionTokens: 0, pricing: null }));
	assert.throws(() =>
		calculatePrice({
			promptTokens: Number.MAX_SAFE_INTEGER,
			completionTokens: 0,
			pricing: {
				status: 'known',
				inputMicrousdPerMillionTokens: Number.MAX_SAFE_INTEGER,
				outputMicrousdPerMillionTokens: 0,
				fixedRequestMicrousd: 0,
			},
		}),
	);
});
