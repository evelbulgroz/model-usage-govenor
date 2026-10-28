import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelUsageError } from './errors.ts';
import { DEFAULT_LOCAL_POLICY_PATH, loadPolicy } from './policy.ts';

test('loads the committed policy independently of the caller working directory', () => {
	const originalDirectory = process.cwd();
	try {
		process.chdir(import.meta.dirname);
		assert.equal(loadPolicy({ localPolicyPath: null }).schemaVersion, '1.0.0');
	} finally {
		process.chdir(originalDirectory);
	}
});

test('discovers conventional local policy tools/.model-usage/local-policy.json by default', () => {
	assert.ok(
		DEFAULT_LOCAL_POLICY_PATH.endsWith(path.join('tools', '.model-usage', 'local-policy.json')),
	);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-policy-'));
	const tempPolicyPath = path.join(tempDir, 'local-policy.json');
	try {
		fs.writeFileSync(
			tempPolicyPath,
			JSON.stringify({ instance: { maxTotalTokens: 50000 } }),
		);
		const policy = loadPolicy({ localPolicyPath: tempPolicyPath });
		assert.equal(policy.instance.maxTotalTokens, 50000);

		// Explicit null bypasses local policy
		const bypassed = loadPolicy({ localPolicyPath: null });
		assert.equal(bypassed.instance.maxTotalTokens, 80000000);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('conventional local policy discovery applies when default path exists on disk', () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-default-policy-'));
	const tempDefaultPath = path.join(tempDir, 'local-policy.json');
	try {
		fs.writeFileSync(
			tempDefaultPath,
			JSON.stringify({ instance: { maxTotalTokens: 42000 } }),
		);
		const discovered = loadPolicy({ defaultLocalPolicyPath: tempDefaultPath });
		assert.equal(discovered.instance.maxTotalTokens, 42000);

		// Passing null explicitly bypasses default discovery
		const bypassed = loadPolicy({ localPolicyPath: null, defaultLocalPolicyPath: tempDefaultPath });
		assert.equal(bypassed.instance.maxTotalTokens, 80000000);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('serializes and reconstitutes safe typed errors preserving identity', () => {
	const error = new ModelUsageError('ERR_CALL_BUDGET_EXCEEDED', 'calls', {
		limit: 1,
		requested: 2,
		secret: 'dropped',
	});
	const restored = ModelUsageError.fromJSON(error.toJSON());
	assert.ok(restored instanceof ModelUsageError);
	assert.equal(restored.code, error.code);
	assert.deepEqual(restored.metadata, { limit: 1, requested: 2 });
});

const POLICY_EXPORTS = [
	'BUILTIN_SAFETY',
	'DEFAULT_LOCAL_POLICY_PATH',
	'canonicalJson',
	'effectiveProfile',
	'loadPolicy',
	'normalizePrompt',
	'normalizedOperationInput',
	'operationInputHash',
	'resolvePolicy',
	'validateOperationId',
	'validateOperationRequest',
	'validatePolicy',
	'validateRunId',
];

test('@ac AC-04 @case AC-04.1 policy.ts exports the thirteen frozen names', async () => {
	const policy = await import('./policy.ts');
	assert.deepEqual(Object.keys(policy).sort(), [...POLICY_EXPORTS].sort());
});

test('@ac AC-04 @case AC-04.2 policy.ts does not star-export', () => {
	const source = fs.readFileSync(new URL('./policy.ts', import.meta.url), 'utf8');
	assert.equal(source.includes('export *'), false);
});

test('@ac AC-04 @case AC-04.3 policy submodules do not import the policy facade', () => {
	const names = fs.readdirSync(import.meta.dirname).filter((name) =>
		(name.startsWith('policy-') || name === 'operation-request.ts') &&
		name.endsWith('.ts') &&
		!name.includes('.spec.'),
	);
	assert.equal(names.includes('operation-request.ts'), true);
	assert.equal(names.includes('policy-validation.ts'), true);
	for (const name of names) {
		const source = fs.readFileSync(path.join(import.meta.dirname, name), 'utf8');
		assert.equal(source.includes("from './policy.ts'"), false, name);
	}
});

test('@ac AC-04 @case AC-04.4 validateExecutionCapacityEnvelope appears nowhere under tools/model-usage', () => {
	// This case title names the deleted symbol, so the scan skips this spec and still reads every other file.
	const needle = 'validateExecutionCapacityEnvelope';
	let scannedPolicy = false;
	function walk(directory) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.test-state') continue;
				walk(full);
				continue;
			}
			if (entry.name === 'policy.spec.mjs') continue;
			if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.ts') && !entry.name.endsWith('.md')) continue;
			if (entry.name === 'policy.ts') scannedPolicy = true;
			const source = fs.readFileSync(full, 'utf8');
			assert.equal(source.includes(needle), false, full);
		}
	}
	walk(path.resolve(import.meta.dirname, '..'));
	assert.equal(scannedPolicy, true);
});

test('@ac AC-09 @case AC-09.1 committed policy providerBoundary names packages/agent-sdlc and packages/model-usage/adapters', () => {
	const policy = loadPolicy({ localPolicyPath: null });
	assert.deepEqual(policy.providerBoundary, {
		registeredConsumerRoots: ['packages/agent-sdlc'],
		allowedAdapterRoots: ['packages/model-usage/adapters'],
		allowedSetupFiles: [],
	});
});

test('@ac AC-06 @case AC-06.1 loadPolicy discovers machine-local policy when repo-local policy is absent', () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-machine-policy-'));
	const machinePath = path.join(tempDir, 'machine-local-policy.json');
	const missingRepoPath = path.join(tempDir, 'nonexistent-repo-policy.json');
	try {
		fs.writeFileSync(
			machinePath,
			JSON.stringify({ instance: { maxCostMicrousd: 25000000, maxTotalTokens: 30000 } }),
		);
		const policy = loadPolicy({
			machineLocalPolicyPath: machinePath,
			localPolicyPath: missingRepoPath,
		});
		assert.equal(policy.instance.maxCostMicrousd, 25000000);
		assert.equal(policy.instance.maxTotalTokens, 30000);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-06 @case AC-06.2 loadPolicy merges 3 tiers monotonically (committed -> machine-local -> repo-local)', () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-3tier-policy-'));
	const machinePath = path.join(tempDir, 'machine.json');
	const repoPath = path.join(tempDir, 'repo.json');
	try {
		fs.writeFileSync(
			machinePath,
			JSON.stringify({ instance: { maxCostMicrousd: 25000000, maxTotalTokens: 40000 } }),
		);
		fs.writeFileSync(
			repoPath,
			JSON.stringify({ instance: { maxCostMicrousd: 10000000 } }),
		);
		const policy = loadPolicy({
			machineLocalPolicyPath: machinePath,
			localPolicyPath: repoPath,
		});
		assert.equal(policy.instance.maxCostMicrousd, 10000000);
		assert.equal(policy.instance.maxTotalTokens, 40000);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-06 @case AC-06.3 loadPolicy rejects machine-local or repo-local escalation above parent tier', () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-3tier-escalation-'));
	const machinePath = path.join(tempDir, 'machine.json');
	const repoPath = path.join(tempDir, 'repo.json');
	try {
		fs.writeFileSync(
			machinePath,
			JSON.stringify({ instance: { maxCostMicrousd: 25000000 } }),
		);
		fs.writeFileSync(
			repoPath,
			JSON.stringify({ instance: { maxCostMicrousd: 30000000 } }),
		);
		assert.throws(
			() =>
				loadPolicy({
					machineLocalPolicyPath: machinePath,
					localPolicyPath: repoPath,
				}),
			(err) => err instanceof ModelUsageError && err.code === 'ERR_LIMIT_ESCALATION_FORBIDDEN',
		);

		fs.writeFileSync(
			machinePath,
			JSON.stringify({ routes: [{ id: 'fake-governed', enabled: true }] }),
		);
		assert.throws(
			() =>
				loadPolicy({
					machineLocalPolicyPath: machinePath,
					localPolicyPath: null,
				}),
			(err) => err instanceof ModelUsageError && err.code === 'ERR_LIMIT_ESCALATION_FORBIDDEN',
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('loadPolicy discovers host project .agent-sdlc/local-policy.json in working directory', () => {
	const originalCwd = process.cwd();
	const tempHostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-host-sdlc-policy-'));
	const sdlcDir = path.join(tempHostDir, '.agent-sdlc');
	const machinePath = path.join(tempHostDir, 'machine.json');
	try {
		fs.mkdirSync(sdlcDir, { recursive: true });
		fs.writeFileSync(
			machinePath,
			JSON.stringify({ instance: { maxCostMicrousd: 20000000, maxTotalTokens: 45000 } }),
		);
		fs.writeFileSync(
			path.join(sdlcDir, 'local-policy.json'),
			JSON.stringify({ instance: { maxCostMicrousd: 8000000 } }),
		);
		process.chdir(tempHostDir);
		const policy = loadPolicy({ machineLocalPolicyPath: machinePath });
		assert.equal(policy.instance.maxCostMicrousd, 8000000);
		assert.equal(policy.instance.maxTotalTokens, 45000);
	} finally {
		process.chdir(originalCwd);
		fs.rmSync(tempHostDir, { recursive: true, force: true });
	}
});
