import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import { loadPolicy } from '../policy/policy.ts';
import { ModelUsageLedger } from '../ledger/ledger.ts';
import { ProviderCircuitBreaker } from './circuit-breaker.ts';
import { executeOperation } from './governor.ts';
import { FakeModelAdapter } from '../adapters/fake.ts';
import { baseRequest, cleanupTestRoot, enabledFakePolicy, readCommittedPolicy } from '../testing/test-support.mjs';
import { setup, run } from '../testing/governor-test-support.mjs';

test('returns exact governor result after durable reserve, usage reconciliation and schema validation', async () => {
	const context = setup('governor-success');
	try {
		const result = await run(context);
		assert.equal(result.schemaVersion, '1.0.0');
		assert.equal(result.status, 'succeeded');
		assert.equal(result.replayed, false);
		assert.deepEqual(result.output, { ok: true });
		assert.equal(result.route.routeId, 'fake-governed');
		assert.equal(result.attempts, 1);
		assert.equal(result.usageRecordIds.length, 1);
		assert.ok(result.remainingBudget.remainingOperationTokens > 0);
		const envelope = JSON.parse(
			fs.readFileSync(path.join(context.stateRoot, 'runs', `${context.request.runId}.json`), 'utf8'),
		);
		assert.equal(envelope.reservations.length, 0);
		assert.equal(envelope.attempts[0].charge.totalTokens, 3);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('replays successful operation with zero additional adapter calls and rejects changed input', async () => {
	const context = setup('governor-replay');
	try {
		const first = await run(context);
		const fake = context.adapters.get('fake-governed');
		const replay = await run(context);
		assert.equal(replay.replayed, true);
		assert.deepEqual(replay.output, first.output);
		assert.equal(fake.callCount, 1);
		await assert.rejects(
			run(context, { ...context.request, prompt: 'changed' }),
			(error) => error.code === 'ERR_OPERATION_ID_REUSED',
		);
		assert.equal(fake.callCount, 1);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('uses the normalized prompt consistently for hashing, estimation and provider dispatch', async () => {
	let dispatchedPrompt;
	const fake = new FakeModelAdapter('fake-governed', [
		{
			onCall(request) {
				dispatchedPrompt = request.prompt;
			},
			result: {
				status: 'succeeded',
				output: { ok: true },
			},
		},
	]);
	const context = setup('governor-normalized-prompt', {
		request: baseRequest({ prompt: 'cafe\u0301\r\n' }),
		adapters: new Map([['fake-governed', fake]]),
	});
	try {
		await run(context);
		assert.equal(dispatchedPrompt, 'café\n');
		const replay = await run(context, { ...context.request, prompt: 'café\n' });
		assert.equal(replay.replayed, true);
		assert.equal(fake.callCount, 1);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('replays persisted success before route selection when its route is later disabled', async () => {
	const context = setup('governor-replay-disabled-route');
	try {
		const first = await run(context);
		const policy = JSON.parse(fs.readFileSync(context.policyPath, 'utf8'));
		policy.routes.find((route) => route.id === 'fake-governed').enabled = false;
		fs.writeFileSync(context.policyPath, JSON.stringify(policy));
		const replay = await run(context);
		assert.equal(replay.replayed, true);
		assert.deepEqual(replay.output, first.output);
		assert.equal(context.adapters.get('fake-governed').callCount, 1);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('replays a persisted terminal typed failure without another adapter call', async () => {
	const fake = new FakeModelAdapter('fake-governed', [
		{ status: 'failed', outcome: 'http_4xx' },
	]);
	const context = setup('governor-failure-replay', {
		adapters: new Map([['fake-governed', fake]]),
	});
	try {
		await assert.rejects(run(context), (error) => error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED');
		await assert.rejects(run(context), (error) => error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED');
		assert.equal(fake.callCount, 1);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('denies over-budget prompt before dispatch', async () => {
	const request = baseRequest({ prompt: 'x'.repeat(21000) });
	const fake = new FakeModelAdapter('fake-governed');
	const context = setup('governor-denial', {
		request,
		adapters: new Map([['fake-governed', fake]]),
	});
	try {
		await assert.rejects(run(context), (error) => error.code === 'ERR_TOKEN_BUDGET_EXCEEDED');
		assert.equal(fake.callCount, 0);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('committed default keeps fake disabled and fails typed before state mutation when live vendors are excluded', async () => {
	const policy = readCommittedPolicy();
	assert.equal(policy.routes.find((route) => route.id === 'fake-governed').enabled, false);
	assert.equal(policy.routes.find((route) => route.id === 'google-gemini-conservative').enabled, true);
	assert.equal(policy.routes.find((route) => route.id === 'openai-compatible-conservative').enabled, true);
	assert.equal(policy.routes.find((route) => route.id === 'xai-grok-conservative').enabled, true);
	assert.equal(policy.routes.find((route) => route.id === 'anthropic-claude-quality').enabled, true);
	const context = setup('governor-default-no-fake', {
		policy,
		request: baseRequest({
			routingConstraints: {
				requiredCapabilities: ['structured-output'],
				excludedVendors: ['anthropic', 'google', 'openai', 'xai'],
			},
		}),
	});
	try {
		await assert.rejects(
			executeOperation(context.request, {
				policyPath: context.policyPath,
				stateRoot: context.stateRoot,
				localPolicyPath: null,
			}),
			(error) => error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
		);
		assert.equal(fs.existsSync(context.stateRoot), false);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('conservatively charges usage-less success and never persists prompt or provider body', async () => {
	const request = baseRequest({ prompt: 'PRIVATE PROMPT' });
	const fake = new FakeModelAdapter('fake-governed', [
		{ status: 'succeeded', output: { ok: true } },
	]);
	const context = setup('governor-usage-less', {
		request,
		adapters: new Map([['fake-governed', fake]]),
	});

	try {
		await run(context);
		const text = fs.readFileSync(
			path.join(context.stateRoot, 'runs', `${context.request.runId}.json`),
			'utf8',
		);
		assert.doesNotMatch(text, /PRIVATE PROMPT|provider-private|API_KEY/);
		const envelope = JSON.parse(text);
		assert.equal(envelope.attempts[0].usageSource, 'estimated');
		assert.ok(envelope.attempts[0].charge.totalTokens > 0);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('allows explicitly non-metered unknown pricing under premium-unit ceilings', async () => {
	const policy = enabledFakePolicy();
	policy.routes[0].pricing = { status: 'unknown' };
	policy.routes[0].metered = false;
	policy.routes[0].premiumRequestUnits = 1;
	const fake = new FakeModelAdapter('fake-governed', [
		{ status: 'succeeded', output: { ok: true } },
	]);
	const context = setup('governor-unpriced-non-metered', {
		policy,
		adapters: new Map([['fake-governed', fake]]),
	});
	try {
		const result = await run(context);
		assert.equal(result.status, 'succeeded');
		assert.equal(result.remainingBudget.remainingRunCostMicrousd, undefined);
		assert.equal(result.remainingBudget.remainingRunPremiumRequestUnits, 1249);
		const envelope = JSON.parse(
			fs.readFileSync(path.join(context.stateRoot, 'runs', `${context.request.runId}.json`), 'utf8'),
		);
		assert.equal(envelope.attempts[0].charge.costMicrousd, 'unknown');
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('fails closed on reconciliation and never returns provider output', async () => {
	const request = baseRequest();
	const context = setup('governor-reconcile-failure', { request });
	const runFile = path.join(context.stateRoot, 'runs', `${request.runId}.json`);
	context.adapters = new Map([
		[
			'fake-governed',
			new FakeModelAdapter('fake-governed', [
				{
					status: 'succeeded',
					output: { ok: true },
					onCall: async () => fs.writeFileSync(runFile, '{"corrupt":true}'),
				},
			]),
		],
	]);
	try {
		await assert.rejects(
			run(context),
			(error) => error instanceof ModelUsageError && error.code === 'ERR_USAGE_RECONCILIATION_FAILED',
		);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('revalidates persisted success output and ledger relationships before replay or dispatch', async (t) => {
	for (const [label, corrupt] of [
		['output', (envelope, operationId) => {
			envelope.operations[operationId].output = { wrong: true };
		}],
		['usage-relationship', (envelope, operationId) => {
			envelope.operations[operationId].usageRecordIds = ['usage-missing'];
		}],
		['route-relationship', (envelope, operationId) => {
			envelope.operations[operationId].route.routeId = 'other-route';
		}],
	]) {
		await t.test(label, async () => {
			const context = setup(`governor-corrupt-${label}`);
			try {
				await run(context);
				const fake = context.adapters.get('fake-governed');
				const file = path.join(context.stateRoot, 'runs', `${context.request.runId}.json`);
				const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
				corrupt(envelope, context.request.operationId);
				fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`);
				await assert.rejects(
					run(context),
					(error) => error.code === 'ERR_USAGE_RECONCILIATION_FAILED',
				);
				assert.equal(fake.callCount, 1);
			} finally {
				cleanupTestRoot(context.root);
			}
		});
	}
});

test('AC-09: idempotent replay returns calibration fields directly from persisted operation without dispatch', async () => {
	const context = setup('governor-ac09-replay');
	try {
		const res1 = await run(context);
		assert.equal(res1.status, 'succeeded');
		assert.equal(res1.replayed, false);
		assert.equal(res1.effectiveStrategy, 'balanced');
		assert.equal(res1.selectedQualityTier, 1);
		assert.equal(context.adapters.get('fake-governed').callCount, 1);

		// Second execution with identical request
		const res2 = await run(context);
		assert.equal(res2.status, 'succeeded');
		assert.equal(res2.replayed, true);
		assert.equal(res2.effectiveStrategy, 'balanced');
		assert.equal(res2.selectedQualityTier, 1);
		// Call count did not increase
		assert.equal(context.adapters.get('fake-governed').callCount, 1);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('@ac AC-03 @case AC-03.1 governor.ts exports the frozen names', async () => {
	const governor = await import('./governor.ts');
	assert.deepEqual(Object.keys(governor).sort(), [
		'assertStrictModeSchemaCompleteness',
		'assessReservation',
		'executeOperation',
		'validateSchemaDefinition',
	]);
});

test('@ac AC-03 @case AC-03.2 governor submodules do not import the governor facade', () => {
	const names = fs
		.readdirSync(import.meta.dirname)
		.filter(
			(name) =>
				name.startsWith('governor-') &&
				name.endsWith('.ts') &&
				!name.endsWith('.spec.mjs') &&
				!name.endsWith('-test-support.mjs'),
		);
	names.push('structured-output-schema.ts');
	assert.deepEqual(
		names.filter((name) => name.startsWith('governor-')).sort(),
		['governor-attempt.ts', 'governor-reservation.ts', 'governor-result.ts'],
	);
	for (const name of names) {
		const source = fs.readFileSync(path.join(import.meta.dirname, name), 'utf8');
		assert.equal(source.includes("from './governor.ts'"), false, name);
		assert.equal(source.includes("import('./governor.ts')"), false, name);
	}
});

test('@ac AC-03 @case AC-03.3 live adapter modules are imported only by governor.ts', () => {
	const pattern =
		/(?:from|import\()\s*['"](?:\.|\.\.)\/adapters\/(?:anthropic|google|openai-compatible|xai)\.(?:mjs|ts)['"]/;
	let scanned = 0;
	function walk(directory) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (
					entry.name === 'adapters' ||
					entry.name === 'node_modules' ||
					entry.name === 'dist' ||
					entry.name === '.test-state'
				) {
					continue;
				}
				walk(full);
				continue;
			}
			if (
				(!entry.name.endsWith('.mjs') && !entry.name.endsWith('.ts')) ||
				entry.name.endsWith('.d.ts') ||
				entry.name.endsWith('.spec.mjs') ||
				entry.name === 'governor.ts'
			) {
				continue;
			}
			scanned += 1;
			const source = fs.readFileSync(full, 'utf8');
			assert.equal(pattern.test(source), false, entry.name);
		}
	}
	walk(path.resolve(import.meta.dirname, '..'));
	assert.equal(scanned > 0, true);
});

test('@ac AC-02 @case AC-02.1 loadPolicy falls back to bundled policy/default-policy.json when host .agents/model-usage-policy.json is absent', () => {
	const originalCwd = process.cwd();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-usage-bundled-policy-'));
	try {
		process.chdir(tempDir);
		const policy = loadPolicy({ localPolicyPath: null, machineLocalPolicyPath: null });
		assert.equal(policy.schemaVersion, '1.0.0');
		assert.deepEqual(policy, readCommittedPolicy());
	} finally {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.2 MODEL_USAGE_STATE_DIR and resolveDefaultStateRoot resolve outside node_modules and no .ts file contains ../../..', () => {
	const tempState = fs.mkdtempSync(path.join(os.tmpdir(), 'model-usage-state-env-'));
	const prevStateDir = process.env.MODEL_USAGE_STATE_DIR;
	try {
		process.env.MODEL_USAGE_STATE_DIR = tempState;
		assert.equal(new ModelUsageLedger().stateRoot, tempState);
		assert.equal(new ProviderCircuitBreaker().stateRoot, tempState);
	} finally {
		if (prevStateDir === undefined) delete process.env.MODEL_USAGE_STATE_DIR;
		else process.env.MODEL_USAGE_STATE_DIR = prevStateDir;
		fs.rmSync(tempState, { recursive: true, force: true });
	}

	const simulatedNodeModulesCwd = '/tmp/host-repo/node_modules/@evelbulgroz/model-usage-govenor';
	const resolvedState = loadPolicy.resolveDefaultStateRoot(simulatedNodeModulesCwd, {});
	assert.equal(resolvedState, path.join('/tmp/host-repo', 'tools/.model-usage'));
	assert.equal(resolvedState.includes('node_modules'), false);

	const pkgRoot = path.resolve(import.meta.dirname, '..');
	const tsFiles = [];
	function walkTs(dir) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.test-state') continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walkTs(full);
			else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) tsFiles.push(full);
		}
	}
	walkTs(pkgRoot);
	for (const file of tsFiles) {
		const src = fs.readFileSync(file, 'utf8');
		assert.equal(src.includes('../../..'), false, `${path.relative(pkgRoot, file)} contains ../../..`);
	}
});
