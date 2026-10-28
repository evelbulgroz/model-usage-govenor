import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { auditPricing } from '../scripts/audit-pricing.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

const NAVIGABILITY_LINE_CEILING = 500;
const NAVIGABILITY_BYTE_CEILING = 20_480;

const MODULE_README_FOLDERS = Object.freeze([
	'governor',
	'ledger',
	'policy',
	'routing',
	'adapters',
	'scripts',
	'testing',
]);

const CHECKED_PACKAGE_DOCS = Object.freeze([
	'README.md',
	'ARCHITECTURE.md',
	'AGENTS.md',
	'PROVIDER-CAPABILITIES.md',
	...MODULE_README_FOLDERS.map((folder) => `${folder}/README.md`),
]);

const MODEL_USAGE_MODULE_PATH =
	/(?:tools|packages)\/model-usage\/((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:mjs|ts))/g;

function countNewlines(buffer) {
	let count = 0;
	for (let i = 0; i < buffer.length; i += 1) {
		if (buffer[i] === 10) count += 1;
	}
	return count;
}

function missingModelUsagePaths(relFromPackageRoot) {
	const text = fs.readFileSync(path.join(ROOT, relFromPackageRoot), 'utf8');
	const missing = [];
	for (const line of text.split('\n')) {
		for (const match of line.matchAll(MODEL_USAGE_MODULE_PATH)) {
			const innerRel = match[1];
			if (!fs.existsSync(path.join(ROOT, innerRel))) {
				missing.push(match[0]);
			}
		}
	}
	return missing;
}

test('@ac AC-01 @case AC-01.1 PROVIDER-CAPABILITIES.md exists inside packages/model-usage and passes auditPricing', () => {
	const capabilitiesPath = path.join(ROOT, 'PROVIDER-CAPABILITIES.md');
	assert.equal(fs.existsSync(capabilitiesPath), true);
	const result = auditPricing();
	assert.equal(result.ok, true, result.errors.join('; '));
	assert.ok(result.routesChecked > 0);
});

test('@ac AC-01 @case AC-01.2 scripts/audit-pricing.ts contains no handbook or ../../../ traversal', () => {
	const source = fs.readFileSync(path.join(ROOT, 'scripts/audit-pricing.ts'), 'utf8');
	const forbiddenHandbook = `${'docs'}/handbook/`;
	assert.equal(source.includes(forbiddenHandbook), false);
	assert.equal(source.includes('../../..'), false);
});

test('@ac AC-03 root packages/model-usage/README.md and ARCHITECTURE.md stay within navigability ceilings and README links all seven module READMEs', () => {
	for (const relPath of ['README.md', 'ARCHITECTURE.md', 'PROVIDER-CAPABILITIES.md']) {
		const rawDoc = fs.readFileSync(path.join(ROOT, relPath));
		assert.ok(
			countNewlines(rawDoc) <= NAVIGABILITY_LINE_CEILING,
			`${relPath} exceeds line ceiling: ${countNewlines(rawDoc)}`,
		);
		assert.ok(
			rawDoc.length <= NAVIGABILITY_BYTE_CEILING,
			`${relPath} exceeds byte ceiling: ${rawDoc.length}`,
		);
	}
	const raw = fs.readFileSync(path.join(ROOT, 'README.md'));
	const text = raw.toString('utf8');
	assert.equal(
		text.includes('(./ARCHITECTURE.md)'),
		true,
		'root README missing link to ./ARCHITECTURE.md',
	);
	for (const folder of MODULE_README_FOLDERS) {
		assert.equal(
			text.includes(`(./${folder}/README.md)`),
			true,
			`root README missing link to ./${folder}/README.md`,
		);
	}
	for (const heading of [
		'## 1. Package Layout & Module Documentation',
		'## 2. Installation, Configuration & Public API',
		'## 3. Development, Testing & Maintenance Commands',
	]) {
		assert.equal(text.includes(heading), true, `root README missing heading: ${heading}`);
	}
	const archText = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
	for (const heading of [
		'## 1. Architectural Intent, Rationale & Core Guarantees',
		'## 2. Two-Phase Execution & Subsystem Boundaries',
	]) {
		assert.equal(
			archText.includes(heading),
			true,
			`ARCHITECTURE.md missing heading: ${heading}`,
		);
	}
});

test('@ac AC-04 capability subfolder READMEs exist within navigability limits and are indexed in packages/model-usage/AGENTS.md', () => {
	const agentsMd = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
	for (const folder of MODULE_README_FOLDERS) {
		const relPath = `${folder}/README.md`;
		const absPath = path.join(ROOT, relPath);
		assert.equal(fs.existsSync(absPath), true, `missing ${relPath}`);
		const raw = fs.readFileSync(absPath);
		assert.ok(
			countNewlines(raw) <= NAVIGABILITY_LINE_CEILING,
			`${relPath} exceeds line ceiling: ${countNewlines(raw)}`,
		);
		assert.ok(
			raw.length <= NAVIGABILITY_BYTE_CEILING,
			`${relPath} exceeds byte ceiling: ${raw.length}`,
		);
		assert.equal(
			agentsMd.includes(`./${folder}/README.md`),
			true,
			`packages/model-usage/AGENTS.md missing ./${folder}/README.md`,
		);
	}
});

test('@ac AC-04 @case AC-04.1 no .md, .ts, or .spec.mjs file under packages/model-usage references monorepo-only paths or root scripts', () => {
	const forbiddenNeedles = [
		`${'tools'}/quality/`,
		`${'apps'}/services/conditioning`,
		`pnpm run ${'test:model-usage'}`,
		`pnpm run ${'agent:typecheck-factory'}`,
		`pnpm run ${'check:model-provider-boundary'}`,
	];
	function walk(dir) {
		const files = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.test-state' || entry.name.startsWith('.')) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) files.push(...walk(full));
			else if (
				entry.name.endsWith('.md') ||
				(entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) ||
				entry.name.endsWith('.spec.mjs')
			) {
				files.push(full);
			}
		}
		return files;
	}
	const files = walk(ROOT);
	assert.ok(files.length > 0);
	for (const file of files) {
		const content = fs.readFileSync(file, 'utf8');
		for (const needle of forbiddenNeedles) {
			assert.equal(
				content.includes(needle),
				false,
				`${path.relative(ROOT, file)} contains forbidden monorepo reference '${needle}'`,
			);
		}
	}
});

test('@ac AC-05 checked package docs reference existing packages/model-usage paths and contain no legacy tools/model-usage paths', () => {
	const legacyPathPattern = /tools\/model-usage(?:\/|\b)/;
	for (const relPath of CHECKED_PACKAGE_DOCS) {
		const missing = missingModelUsagePaths(relPath);
		assert.deepEqual(missing, [], `${relPath} has missing paths: ${missing.join(', ')}`);
		const text = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
		assert.equal(
			legacyPathPattern.test(text),
			false,
			`${relPath} contains legacy tools/model-usage path`,
		);
	}
});
