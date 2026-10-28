/**
 * Scalar and closed-object checks shared inside policy loading.
 * Production callers outside this family use policy.ts.
 */
import path from 'node:path';
import { ModelUsageError } from './errors.ts';

export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const OPERATION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

const SMALL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/;

export function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

export function closed(value: unknown, allowed: ReadonlySet<string>, name: string): void {
	const rec = object(value, name);
	for (const key of Object.keys(rec)) {
		if (!allowed.has(key)) throw new TypeError(`${name} contains unknown key '${key}'`);
	}
}

export function required(value: unknown, keys: Iterable<string>, name: string): void {
	const rec = object(value, name);
	for (const key of keys) {
		if (!Object.hasOwn(rec, key)) throw new TypeError(`${name}.${key} is required`);
	}
}

export function safeInteger(
	value: unknown,
	name: string,
	{ positive = false }: { positive?: boolean } = {},
): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
		throw new TypeError(`${name} must be a ${positive ? 'positive' : 'non-negative'} safe integer`);
	}
	return value;
}

export function string(value: unknown, name: string, pattern: RegExp = SMALL_IDENTIFIER): string {
	if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${name} is invalid`);
	return value;
}

export function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
		throw new TypeError(`${name} must be an array of non-empty strings`);
	}
	const strings = value as string[];
	if (new Set(strings).size !== strings.length) throw new TypeError(`${name} contains duplicates`);
	return [...strings];
}

export function repositoryPathArray(value: unknown, name: string): string[] {
	const entries = stringArray(value, name);
	for (const entry of entries) {
		const segments = entry.split('/');
		if (
			path.posix.isAbsolute(entry) ||
			entry.includes('\\') ||
			entry.endsWith('/') ||
			path.posix.normalize(entry) !== entry ||
			segments.some((segment) => segment === '.' || segment === '..')
		) {
			throw new TypeError(`${name} contains a path outside the repository boundary`);
		}
	}
	return entries;
}

export function deepFreeze<T>(value: T): Readonly<T> {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

export function ensureLower(number: unknown, ceiling: number, name: string): number {
	const num = safeInteger(number, name);
	if (num > ceiling) {
		throw new ModelUsageError(
			'ERR_LIMIT_ESCALATION_FORBIDDEN',
			`${name} cannot raise its parent ceiling`,
			{ dimension: name, limit: ceiling, requested: num },
		);
	}
	return num;
}
