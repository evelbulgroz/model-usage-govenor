import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

const ALLOWED_CHILDREN = new Set([
	'.git',
	'.gitignore',
	'.agents',
	'pnpm-lock.yaml',
	'AGENTS.md',
	'ARCHITECTURE.md',
	'PROVIDER-CAPABILITIES.md',
	'README.md',
	'package.json',
	'tsconfig.json',
	'tsconfig.build.json',
	'dist',
	'docs',
	'node_modules',
	'.turbo',
	'.test-state',
	'governor.ts',
	'atomic-file-state.ts',
	'sanitize-failure-text.ts',
	'governor',
	'ledger',
	'policy',
	'routing',
	'adapters',
	'scripts',
	'testing',
]);

const EXPECTED_EXPORT_KEYS = [
	'.',
	'./adapters/fake',
	'./atomic-file-state',
	'./errors',
	'./ledger',
	'./policy',
	'./routing',
	'./sanitize-failure-text',
	'./test-support',
	'./tokenizer',
];

test('@ac AC-01 @case AC-01.1 packages/model-usage root contains only allowlisted entries and no .mjs files', () => {
	const children = fs.readdirSync(ROOT);
	for (const name of children) {
		assert.equal(ALLOWED_CHILDREN.has(name), true, `unexpected root child: ${name}`);
	}
	assert.equal(children.some((name) => name.endsWith('.mjs')), false);
});

test('@ac AC-03 @case AC-03.1 package.json declares build, typecheck, test:unit, audit:pricing, publishConfig, and conditional dist exports', async () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	assert.equal(pkg.version, '1.0.0');
	assert.equal(pkg.private, false);
	assert.deepEqual(pkg.publishConfig, { registry: 'https://npm.pkg.github.com/' });
	assert.deepEqual(pkg.files, [
		'dist',
		'policy/default-policy.json',
		'testing/test-support.mjs',
		'PROVIDER-CAPABILITIES.md',
	]);
	assert.equal(pkg.scripts?.typecheck, 'tsc --noEmit -p tsconfig.json');
	assert.equal(pkg.scripts?.['test:unit'], "node --test '**/*.spec.mjs'");
	assert.equal(pkg.scripts?.['audit:pricing'], 'node ./scripts/audit-pricing.ts --check');
	assert.equal(typeof pkg.scripts?.build, 'string');

	const buildRes = spawnSync('pnpm', ['run', 'build'], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 60_000,
	});
	assert.equal(buildRes.status, 0, `${buildRes.stdout ?? ''}\n${buildRes.stderr ?? ''}`);

	for (const scriptName of ['typecheck', 'audit:pricing']) {
		const res = spawnSync('pnpm', ['run', scriptName], {
			cwd: ROOT,
			encoding: 'utf8',
			timeout: 60_000,
		});
		assert.equal(res.status, 0, `${res.stdout ?? ''}\n${res.stderr ?? ''}`);
	}

	assert.equal(fs.existsSync(path.join(ROOT, 'dist/policy/default-policy.json')), true);
	assert.deepEqual(Object.keys(pkg.exports ?? {}).sort(), EXPECTED_EXPORT_KEYS);

	for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
		if (subpath === './test-support') {
			assert.equal(target, './testing/test-support.mjs');
			const resolved = path.resolve(ROOT, target);
			assert.equal(fs.existsSync(resolved), true);
			const mod = await import(pathToFileURL(resolved).href);
			assert.ok(Object.keys(mod).length > 0);
			continue;
		}
		assert.equal(typeof target, 'object', `${subpath} must map to conditional export object`);
		assert.equal(target.types.startsWith('./dist/'), true, `${subpath} types must point to ./dist/`);
		assert.equal(target.default.startsWith('./dist/'), true, `${subpath} default must point to ./dist/`);
		const resolvedTypes = path.resolve(ROOT, target.types);
		const resolvedDefault = path.resolve(ROOT, target.default);
		assert.equal(fs.existsSync(resolvedTypes), true, `missing ${resolvedTypes}`);
		assert.equal(fs.existsSync(resolvedDefault), true, `missing ${resolvedDefault}`);
		const mod = await import(pathToFileURL(resolvedDefault).href);
		assert.ok(Object.keys(mod).length > 0, `${subpath} exported no symbols`);
	}

	function walkDistJs(dir) {
		const results = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) results.push(...walkDistJs(full));
			else if (entry.name.endsWith('.js')) results.push(full);
		}
		return results;
	}
	const distJsFiles = walkDistJs(path.join(ROOT, 'dist'));
	assert.ok(distJsFiles.length > 0);
	for (const jsFile of distJsFiles) {
		const src = fs.readFileSync(jsFile, 'utf8');
		assert.equal(
			/(?:from|import)\s+['"]\.[^'"]*\.ts['"]/.test(src),
			false,
			`${path.relative(ROOT, jsFile)} still contains .ts relative specifier`,
		);
	}
});

test('@ac AC-03 @case AC-03.2 all 10 exported subpaths import cleanly from a temporary node_modules package directory', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-usage-nm-test-'));
	const pkgDir = path.join(tempDir, 'node_modules', ...pkg.name.split('/'));
	try {
		fs.mkdirSync(pkgDir, { recursive: true });
		fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(pkgDir, 'package.json'));
		fs.cpSync(path.join(ROOT, 'dist'), path.join(pkgDir, 'dist'), { recursive: true });
		fs.cpSync(path.join(ROOT, 'policy'), path.join(pkgDir, 'policy'), { recursive: true });
		fs.cpSync(path.join(ROOT, 'testing'), path.join(pkgDir, 'testing'), { recursive: true });

		const subpaths = EXPECTED_EXPORT_KEYS.map((sub) =>
			sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`,
		);
		const script = `
			const subpaths = ${JSON.stringify(subpaths)};
			for (const spec of subpaths) {
				const mod = await import(spec);
				if (Object.keys(mod).length === 0) throw new Error('Empty export: ' + spec);
			}
			const { loadPolicy } = await import('${pkg.name}/policy');
			const pol = loadPolicy({ localPolicyPath: null, machineLocalPolicyPath: null });
			if (pol.schemaVersion !== '1.0.0') throw new Error('Unexpected policy schema');
		`;
		const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
			cwd: tempDir,
			encoding: 'utf8',
			timeout: 30_000,
		});
		assert.equal(res.status, 0, `${res.stdout ?? ''}\n${res.stderr ?? ''}`);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
