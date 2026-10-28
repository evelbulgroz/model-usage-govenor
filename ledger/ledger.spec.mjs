import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import { loadPolicy } from '../policy/policy.ts';
import { ModelUsageLedger } from './ledger.ts';
import { cleanupTestRoot } from '../testing/test-support.mjs';
import { setup, reserve } from '../testing/ledger-test-support.mjs';

test('uses a repository-anchored default state root', () => {
	const originalDirectory = process.cwd();
	try {
		process.chdir(import.meta.dirname);
		const ledger = new ModelUsageLedger();
		assert.equal(ledger.stateRoot, loadPolicy.resolveDefaultStateRoot());
	} finally {
		process.chdir(originalDirectory);
	}
});

test('rejects active duplicate owner, changed input and replays terminal typed failure', () => {
	const context = setup('ledger-idempotency');
	try {
		const reserved = reserve(context);
		assert.throws(
			() => reserve(context, { ownerToken: 'other' }),
			(error) => error.code === 'ERR_OPERATION_IN_PROGRESS',
		);
		assert.throws(
			() =>
				context.ledger.getOperation(
					context.request.runId,
					context.request.operationId,
					'a'.repeat(64),
				),
			(error) => error.code === 'ERR_OPERATION_ID_REUSED',
		);
		const failure = new ModelUsageError('ERR_OPERATION_TIMEOUT', 'timeout');
		const now = new Date().toISOString();
		context.ledger.recordAttemptAndReconcile({
			runId: context.request.runId,
			operationId: context.request.operationId,
			reservationId: reserved.reservation.id,
			result: { status: 'failed', outcome: 'timeout' },
			route: context.route,
			terminal: 'failed',
			failure,
			startedAt: now,
			completedAt: now,
		});
		assert.throws(
			() =>
				context.ledger.getOperation(
					context.request.runId,
					context.request.operationId,
					context.inputHash,
				),
			(error) => error instanceof ModelUsageError && error.code === 'ERR_OPERATION_TIMEOUT',
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('uses owner-only state permissions and never persists prompts, credentials or raw bodies', () => {
	const context = setup('ledger-privacy', { prompt: 'TOP SECRET PROMPT' });
	try {
		reserve(context);
		const file = context.ledger.runFile(context.request.runId);
		assert.equal(fs.statSync(context.stateRoot).mode & 0o777, 0o700);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		const text = fs.readFileSync(file, 'utf8');
		assert.doesNotMatch(text, /TOP SECRET PROMPT|API_KEY|rawBody/);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

const PUBLIC_LEDGER_METHODS = [
	'ensureStorage',
	'finalizeFailure',
	'getExhaustedRouteIds',
	'getOperation',
	'getRunBudgetSummary',
	'getRunSummary',
	'loadRunLedger',
	'readAllEnvelopes',
	'readEnvelope',
	'recordAttemptAndReconcile',
	'recoverEnvelope',
	'reserveAttempt',
	'runFile',
	'summarizeEnvelope',
	'withState',
	'writeEnvelope',
];

function productionLedgerModules(directory) {
	const excluded = new Set(['ledger-child.mjs', 'ledger-success-child.mjs', 'ledger-test-support.mjs']);
	return fs
		.readdirSync(directory)
		.filter((name) => name.endsWith('.ts'))
		.filter((name) => name === 'ledger.ts' || name.startsWith('ledger-'))
		.filter((name) => !name.endsWith('.spec.mjs'))
		.filter((name) => !excluded.has(name))
		.sort();
}

test('@ac AC-02 @case AC-02.1 ledger.ts exports the frozen names and keeps its public methods', async () => {
	const ledger = await import('./ledger.ts');
	assert.deepEqual(Object.keys(ledger).sort(), ['ModelUsageLedger', 'loadRunLedger']);
	const methods = Object.getOwnPropertyNames(ledger.ModelUsageLedger.prototype)
		.filter((name) => name !== 'constructor')
		.sort();
	assert.deepEqual(methods, PUBLIC_LEDGER_METHODS);
});

test('@ac AC-02 @case AC-02.2 production ledger modules do not import the ledger or policy facades', () => {
	const directory = import.meta.dirname;
	const files = productionLedgerModules(directory).filter((name) => name !== 'ledger.ts');
	assert.equal(files.includes('ledger-budget.ts'), true);
	for (const name of files) {
		const source = fs.readFileSync(path.join(directory, name), 'utf8');
		assert.equal(source.includes("from './ledger.ts'"), false, name);
		assert.equal(source.includes("from './policy.ts'"), false, name);
	}
});

test('@ac AC-02 @case AC-02.3 only ledger.ts takes the ledger lock', () => {
	const directory = import.meta.dirname;
	for (const name of productionLedgerModules(directory)) {
		const source = fs.readFileSync(path.join(directory, name), 'utf8');
		const locks = source.includes('withLockSync') || source.includes('durableReplaceSync');
		assert.equal(locks, name === 'ledger.ts', name);
	}
});
