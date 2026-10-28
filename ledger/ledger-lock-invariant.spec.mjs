import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const EXCLUDED = new Set(['ledger-child.mjs', 'ledger-success-child.mjs', 'ledger-test-support.mjs']);

export function productionLedgerFiles(directory) {
	return fs
		.readdirSync(directory)
		.filter((name) => name.endsWith('.ts'))
		.filter((name) => name === 'ledger.ts' || name.startsWith('ledger-'))
		.filter((name) => !name.endsWith('.spec.mjs'))
		.filter((name) => !EXCLUDED.has(name))
		.sort();
}

export function asynchronousViolations(fileName, source) {
	const violations = [];
	const lines = source.split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (/\basync\b/.test(line) || /\bawait\b/.test(line) || line.includes('.then(')) {
			violations.push({ file: fileName, line: index + 1 });
		}
	}
	return violations;
}

export function scanLedgerDirectory(directory) {
	const files = productionLedgerFiles(directory);
	if (files.length === 0) return [{ file: directory, reason: 'no production ledger files' }];
	const violations = [];
	for (const name of files) {
		const source = fs.readFileSync(path.join(directory, name), 'utf8');
		violations.push(...asynchronousViolations(name, source));
	}
	return violations;
}

test('@ac AC-01 @case AC-01.1 every production ledger file contains no async, await, or .then(', () => {
	const violations = scanLedgerDirectory(import.meta.dirname);
	assert.deepEqual(violations, []);
});

test('@ac AC-01 @case AC-01.2 a fixture source containing await is reported with its file name', () => {
	const found = asynchronousViolations('fixture.mjs', 'export const value = await Promise.resolve(1);\n');
	assert.equal(found.length, 1);
	assert.equal(found[0].file, 'fixture.mjs');
	assert.equal(found[0].line, 1);
	assert.deepEqual(asynchronousViolations('fixture.mjs', 'const result = value.then;\n'), []);
});

test('@ac AC-01 @case AC-01.3 child scripts and ledger test support are not scanned', () => {
	const found = productionLedgerFiles(import.meta.dirname);
	assert.equal(found.includes('ledger-child.mjs'), false);
	assert.equal(found.includes('ledger-success-child.mjs'), false);
	assert.equal(found.includes('ledger-test-support.mjs'), false);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-excluded-'));
	try {
		fs.writeFileSync(path.join(directory, 'ledger-child.mjs'), 'await 1;\n');
		fs.writeFileSync(path.join(directory, 'ledger-success-child.mjs'), 'await 1;\n');
		fs.writeFileSync(path.join(directory, 'ledger-test-support.mjs'), 'await 1;\n');
		fs.writeFileSync(path.join(directory, 'ledger.ts'), 'export const ready = true;\n');
		assert.deepEqual(scanLedgerDirectory(directory), []);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.4 the scanned list is computed from the directory', () => {
	const found = productionLedgerFiles(import.meta.dirname);
	for (const name of [
		'ledger.ts',
		'ledger-attempt-validation.ts',
		'ledger-budget.ts',
		'ledger-envelope-validation.ts',
		'ledger-recovery.ts',
		'ledger-summary.ts',
	]) {
		assert.equal(found.includes(name), true, name);
	}
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-empty-'));
	const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-extra-'));
	try {
		assert.deepEqual(productionLedgerFiles(empty), []);
		assert.equal(scanLedgerDirectory(empty)[0].reason, 'no production ledger files');
		fs.writeFileSync(path.join(extra, 'ledger-extra.ts'), 'export const ok = 1;\n');
		fs.writeFileSync(path.join(extra, 'ledger-child.mjs'), 'await 1;\n');
		assert.deepEqual(productionLedgerFiles(extra), ['ledger-extra.ts']);
		assert.deepEqual(scanLedgerDirectory(extra), []);
	} finally {
		fs.rmSync(empty, { recursive: true, force: true });
		fs.rmSync(extra, { recursive: true, force: true });
	}
});
