import { canonicalJson } from '../policy/policy.ts';

export interface TokenEstimatorRef {
	readonly name: string;
	readonly version: string;
}

export interface PromptTokenEstimate {
	readonly promptTokens: number;
	readonly serializedByteLength: number;
	readonly unicodeCodePointCount: number;
	readonly estimator: TokenEstimatorRef;
}

export const TOKEN_ESTIMATOR: TokenEstimatorRef = Object.freeze({
	name: 'conservative-unicode-bytes',
	version: '2',
});

/** Covers role/message wrapping and structured-output envelope tokens providers count but we do not serialize. */
const DEFAULT_REQUEST_ENVELOPE_TOKENS = 64;

function requirePositiveSafeInteger(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer`);
	}
	return value;
}

export function buildCanonicalPromptInput(
	prompt: unknown,
	structuredOutputSchema: unknown,
	framing: unknown = '',
): string {
	if (typeof prompt !== 'string') throw new TypeError('prompt must be a string');
	if (typeof framing !== 'string') throw new TypeError('framing must be a string');
	return `${framing}${prompt}\n<structured-output-schema>${canonicalJson(
		structuredOutputSchema,
	)}</structured-output-schema>`;
}

export function estimatePromptTokens({
	prompt,
	structuredOutputSchema,
	routeFraming = '',
	routeFramingTokens = 0,
	requestEnvelopeTokens = DEFAULT_REQUEST_ENVELOPE_TOKENS,
	bytesPerTokenFloor = 1,
	codePointsPerTokenFloor = 1,
}: {
	prompt: unknown;
	structuredOutputSchema: unknown;
	routeFraming?: unknown;
	routeFramingTokens?: number;
	requestEnvelopeTokens?: number;
	bytesPerTokenFloor?: number;
	codePointsPerTokenFloor?: number;
}): PromptTokenEstimate {
	const byteFloor = requirePositiveSafeInteger(bytesPerTokenFloor, 'bytesPerTokenFloor');
	const cpFloor = requirePositiveSafeInteger(codePointsPerTokenFloor, 'codePointsPerTokenFloor');
	if (!Number.isSafeInteger(routeFramingTokens) || routeFramingTokens < 0) {
		throw new TypeError('routeFramingTokens must be a non-negative safe integer');
	}
	if (!Number.isSafeInteger(requestEnvelopeTokens) || requestEnvelopeTokens < 0) {
		throw new TypeError('requestEnvelopeTokens must be a non-negative safe integer');
	}
	const serialized = buildCanonicalPromptInput(prompt, structuredOutputSchema, routeFraming);
	const byteEstimate = Math.ceil(Buffer.byteLength(serialized, 'utf8') / byteFloor);
	const codePointEstimate = Math.ceil([...serialized].length / cpFloor);
	const tokens =
		Math.max(byteEstimate, codePointEstimate) + routeFramingTokens + requestEnvelopeTokens;
	if (!Number.isSafeInteger(tokens)) throw new RangeError('Prompt token estimate overflow');
	return Object.freeze({
		promptTokens: tokens,
		serializedByteLength: Buffer.byteLength(serialized, 'utf8'),
		unicodeCodePointCount: [...serialized].length,
		estimator: TOKEN_ESTIMATOR,
	});
}
