import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPOSITORY_ROOT = path.resolve(ROOT, '../..');

export function isNavigabilityExempt(fileName) {
	return (
		fileName === 'ledger-child.mjs' ||
		fileName === 'ledger-success-child.mjs' ||
		fileName === 'test-support.mjs' ||
		fileName.endsWith('-test-support.mjs')
	);
}

export function sourceSize(source) {
	const lines = source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
	return { lines, bytes: Buffer.byteLength(source) };
}

export function navigabilityViolations(fileName, source) {
	if (isNavigabilityExempt(fileName)) return [];
	const size = sourceSize(source);
	const violations = [];
	if (size.lines > 500) violations.push({ file: fileName, limit: 'lines', ...size });
	if (size.bytes > 20480) violations.push({ file: fileName, limit: 'bytes', ...size });
	return violations;
}

function walk(directory) {
	const files = [];
	let entries;
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch (error) {
		if (error.code === 'ENOENT') return files;
		throw error;
	}
	for (const entry of entries) {
		if (entry.name === '.test-state' || entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...walk(full));
		else if ((entry.name.endsWith('.mjs') || entry.name.endsWith('.ts')) && !entry.name.endsWith('.d.ts')) {
			files.push(full);
		}
	}
	return files;
}

test('@ac AC-05 @case AC-05.1 every in-scope model-usage file is within 500 lines and 20480 bytes', () => {
	const files = walk(ROOT);
	assert.equal(files.some((file) => file.endsWith(`${path.sep}governor.ts`)), true);
	assert.equal(files.some((file) => file.endsWith(`${path.sep}ledger.ts`)), true);
	const violations = [];
	for (const file of files) {
		const source = fs.readFileSync(file, 'utf8');
		violations.push(...navigabilityViolations(path.basename(file), source));
	}
	assert.deepEqual(violations, []);
});

test('@ac AC-05 @case AC-05.2 a synthetic 501-line source is reported over the line limit', () => {
	const over = navigabilityViolations('synthetic.ts', `${'const value = 1;\n'.repeat(501)}`);
	assert.equal(over.some((item) => item.file === 'synthetic.ts' && item.limit === 'lines'), true);
	assert.deepEqual(navigabilityViolations('synthetic.ts', `${'const value = 1;\n'.repeat(500)}`), []);
});

test('@ac AC-05 @case AC-05.3 a synthetic 20481-byte source is reported over the byte limit', () => {
	const over = navigabilityViolations('synthetic.ts', 'a'.repeat(20481));
	assert.equal(over.some((item) => item.file === 'synthetic.ts' && item.limit === 'bytes'), true);
	assert.deepEqual(navigabilityViolations('synthetic.ts', 'a'.repeat(20480)), []);
});

test('@ac AC-05 @case AC-05.4 only child scripts and test-support files are excluded', () => {
	const oversized = `${'const value = 1;\n'.repeat(501)}`;
	for (const name of ['ledger-child.mjs', 'ledger-success-child.mjs', 'test-support.mjs', 'ledger-test-support.mjs']) {
		assert.deepEqual(navigabilityViolations(name, oversized), []);
	}
	for (const name of ['ledger.ts', 'governor.spec.mjs', 'not-a-support.ts']) {
		assert.equal(navigabilityViolations(name, oversized).length > 0, true, name);
	}
});

function directoryListingPaths(readme) {
	const fence = readme.match(/```text\n([\s\S]*?)```/);
	assert.ok(fence, 'directory listing fence');
	const directories = [];
	const files = [];
	for (const line of fence[1].split('\n')) {
		if (line.trim() === '' || line.includes('*')) continue;
		const matched = line.match(/^([│├└─\s]*)(.*)$/);
		if (!matched) continue;
		const prefix = matched[1];
		const entry = matched[2].split('#')[0].trim();
		if (!entry) continue;
		const depth = /[├└│]/.test(prefix) ? (prefix.match(/│/g) || []).length + 1 : 0;
		if (entry.endsWith('/')) {
			let dirPath = depth === 0 ? path.join(REPOSITORY_ROOT, entry) : path.join(directories[depth - 1], entry);
			if (depth === 0 && !fs.existsSync(dirPath)) {
				dirPath = ROOT;
			}
			directories[depth] = dirPath;
			continue;
		}
		if (!entry.endsWith('.mjs') && !entry.endsWith('.ts')) continue;
		const parent = depth === 0 ? REPOSITORY_ROOT : directories[depth - 1];
		files.push(path.join(parent, entry));
	}
	return files;
}

test('@ac AC-06 @case AC-06.1 the README states the internal-module rule', () => {
	const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
	assert.match(
		readme,
		/`governor-\*\.ts` and `ledger-\*\.ts` are internal parts of the governor that only `governor\.ts` and `ledger\.ts` import/,
	);
	assert.match(readme, /Retry, failover, and accounting stay in the governor/);
});

test('@ac AC-06 @case AC-06.2 the README says ledger files contain zero await', () => {
	const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
	assert.match(readme, /`ledger\*\.ts` contains zero `await`/);
	assert.doesNotMatch(readme, /`ledger\.ts` contains zero `await`/);
});

test('@ac AC-06 @case AC-06.3 every module path named in the directory listing exists', () => {
	const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
	const files = directoryListingPaths(readme);
	assert.ok(files.some((file) => file.endsWith(`${path.sep}governor.ts`)));
	assert.ok(files.some((file) => file.endsWith(`${path.sep}atomic-file-state.ts`)));
	for (const file of files) assert.equal(fs.existsSync(file), true, file);
});
