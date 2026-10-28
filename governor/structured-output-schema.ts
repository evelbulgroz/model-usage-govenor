/**
 * Provider-portable structured-output schema checks and matching.
 * governor.ts re-exports the two validators. This module does not import it.
 */
import { isDeepStrictEqual } from 'node:util';

export interface StructuredOutputSchema {
	type?: string;
	required?: readonly string[];
	properties?: Readonly<Record<string, StructuredOutputSchema>>;
	additionalProperties?: boolean;
	items?: StructuredOutputSchema;
	enum?: readonly unknown[];
	const?: unknown;
	minimum?: number;
	description?: string;
	title?: string;
	anyOf?: readonly StructuredOutputSchema[];
	[key: string]: unknown;
}

const SUPPORTED_SCHEMA_KEYS = new Set([
	'type',
	'required',
	'properties',
	'additionalProperties',
	'items',
	'enum',
	'const',
	'minimum',
	'description',
	'title',
	'anyOf',
]);

/**
 * Validates a structured-output schema against the governed provider-portable
 * subset (see SUPPORTED_SCHEMA_KEYS). Exported so callers that author a
 * structuredOutputSchema (e.g. agent-sdlc scripts) can assert portability in a
 * unit test, without needing a live governed executeOperation() call.
 */
export function validateSchemaDefinition(schema: unknown, location = '$'): void {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
		throw new TypeError(`Structured output schema at ${location} must be an object`);
	}
	const node = schema as Record<string, unknown>;
	for (const key of Object.keys(node)) {
		if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
			throw new TypeError(`Unsupported structured output schema keyword '${key}' at ${location}`);
		}
	}
	if (
		node.type !== undefined &&
		(typeof node.type !== 'string' ||
			!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(node.type))
	) {
		throw new TypeError(`Unsupported schema type at ${location}`);
	}
	if (node.required !== undefined) {
		if (!Array.isArray(node.required) || node.required.some((key) => typeof key !== 'string')) {
			throw new TypeError(`Schema required at ${location} must be a string array`);
		}
	}
	if (node.properties !== undefined) {
		if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
			throw new TypeError(`Schema properties at ${location} must be an object`);
		}
		for (const [key, child] of Object.entries(node.properties as Record<string, unknown>)) {
			validateSchemaDefinition(child, `${location}.properties.${key}`);
		}
	}
	if (node.items !== undefined) validateSchemaDefinition(node.items, `${location}.items`);
	if (node.anyOf !== undefined) {
		if (!Array.isArray(node.anyOf) || node.anyOf.length === 0) {
			throw new TypeError(`Schema anyOf at ${location} must be a non-empty array`);
		}
		for (let i = 0; i < node.anyOf.length; i += 1) {
			validateSchemaDefinition(node.anyOf[i], `${location}.anyOf[${i}]`);
		}
	}
	if (node.enum !== undefined && !Array.isArray(node.enum)) {
		throw new TypeError(`Schema enum at ${location} must be an array`);
	}
	if (node.minimum !== undefined) {
		if (
			typeof node.type !== 'string' ||
			!['number', 'integer'].includes(node.type) ||
			typeof node.minimum !== 'number' ||
			!Number.isFinite(node.minimum)
		) {
			throw new TypeError(`Schema minimum at ${location} requires a finite numeric type`);
		}
	}
	if (
		node.additionalProperties !== undefined &&
		typeof node.additionalProperties !== 'boolean'
	) {
		throw new TypeError(`Only boolean additionalProperties is supported at ${location}`);
	}
}

function strictConstError(schema: Record<string, unknown>, location: string): string | null {
	if (!Object.prototype.hasOwnProperty.call(schema, 'const')) return null;
	if (schema.type === undefined) {
		return `OpenAI strict mode requires a type beside const at ${location}`;
	}
	const value = schema.const;
	const primitive =
		(schema.type === 'string' && typeof value === 'string') ||
		(schema.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
		(schema.type === 'integer' && Number.isInteger(value)) ||
		(schema.type === 'boolean' && typeof value === 'boolean') ||
		(schema.type === 'null' && value === null);
	if (primitive) return null;
	return `OpenAI strict mode rejects a non-primitive const at ${location}`;
}

/**
 * Validates a structured-output schema against OpenAI structured-output
 * strict mode's completeness rules (see adapters/openai-compatible.ts,
 * `strict: true`), which are stricter than, and NOT enforced by,
 * validateSchemaDefinition()'s portable-keyword subset:
 *   - every 'object' node must set additionalProperties:false
 *   - every property declared on an 'object' node must also appear in
 *     'required' (optional semantics must be expressed via a nullable
 *     anyOf type, e.g. { anyOf: [{ type: 'string' }, { type: 'null' }] },
 *     never by omitting the property from 'required')
 *   - a const node must also have a type, and the value must be a string,
 *     finite number, integer, boolean, or null
 * A schema can pass validateSchemaDefinition() and this check and still be
 * rejected live by an OpenAI-compatible route, so callers authoring a
 * structuredOutputSchema should run both checks in a unit test rather than
 * relying on a live canary run to surface the next gap. Exported for reuse
 * by agent-sdlc schema regression tests.
 */
export function assertStrictModeSchemaCompleteness(schema: unknown, location = '$'): void {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
	const node = schema as Record<string, unknown>;
	const constError = strictConstError(node, location);
	if (constError) throw new TypeError(constError);
	const propertiesObj =
		node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)
			? (node.properties as Record<string, unknown>)
			: undefined;
	if (node.type === 'object') {
		if (node.additionalProperties !== false) {
			throw new TypeError(
				`OpenAI strict mode requires additionalProperties:false at ${location}`,
			);
		}
		const propertyKeys = Object.keys(propertiesObj ?? {});
		const requiredArr = Array.isArray(node.required) ? (node.required as string[]) : [];
		const required = new Set(requiredArr);
		const missing = propertyKeys.filter((key) => !required.has(key));
		if (missing.length > 0) {
			throw new TypeError(
				`OpenAI strict mode requires every property in required at ${location}: missing ${missing.join(', ')}`,
			);
		}
	}
	if (propertiesObj !== undefined) {
		for (const [key, child] of Object.entries(propertiesObj)) {
			assertStrictModeSchemaCompleteness(child, `${location}.properties.${key}`);
		}
	}
	if (node.items !== undefined) assertStrictModeSchemaCompleteness(node.items, `${location}.items`);
	if (Array.isArray(node.anyOf)) {
		node.anyOf.forEach((child, index) =>
			assertStrictModeSchemaCompleteness(child, `${location}.anyOf[${index}]`),
		);
	}
}

export function matchesSchema(value: unknown, schema: StructuredOutputSchema): boolean {
	if (
		schema.const !== undefined &&
		!isDeepStrictEqual(value, schema.const)
	) {
		return false;
	}
	if (
		schema.enum !== undefined &&
		!schema.enum.some((candidate) => isDeepStrictEqual(candidate, value))
	) {
		return false;
	}
	if (schema.anyOf !== undefined && !schema.anyOf.some((candidate) => matchesSchema(value, candidate))) return false;
	if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) return false;
	switch (schema.type) {
		case 'null':
			if (value !== null) return false;
			break;
		case 'object': {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
			const record = value as Record<string, unknown>;
			const properties = schema.properties ?? {};
			for (const key of schema.required ?? []) {
				if (key in record) continue;
				const prop = properties[key];
				const allowsNull = prop?.type === 'null' || prop?.anyOf?.some((entry) => entry?.type === 'null');
				if (!allowsNull) return false;
			}
			if (schema.additionalProperties === false) {
				for (const key of Object.keys(record)) if (!(key in properties)) return false;
			}
			for (const [key, child] of Object.entries(properties)) {
				if (key in record && !matchesSchema(record[key], child)) return false;
			}
			break;
		}
		case 'array':
			if (!Array.isArray(value)) return false;
			if (schema.items && value.some((item) => !matchesSchema(item, schema.items as StructuredOutputSchema))) return false;
			break;
		case 'string':
			if (typeof value !== 'string') return false;
			break;
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) return false;
			break;
		case 'integer':
			if (!Number.isSafeInteger(value)) return false;
			break;
		case 'boolean':
			if (typeof value !== 'boolean') return false;
			break;
		default:
			break;
	}
	return true;
}
