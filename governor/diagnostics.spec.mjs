import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
	MALFORMED_OUTPUT_DIAGNOSTIC_MAX_CHARS,
	MALFORMED_OUTPUT_DIAGNOSTIC_RETENTION_MS,
	pruneExpiredMalformedOutputDiagnostics,
	writeMalformedOutputDiagnostic,
} from './diagnostics.ts';
import { cleanupTestRoot, makeTestRoot } from '../testing/test-support.mjs';

test('writes redacted capped malformed-output diagnostics outside the ledger', () => {
	const root = makeTestRoot('malformed-diagnostic');
	try {
		const diagnosticRef = writeMalformedOutputDiagnostic({
			stateRoot: root,
			runId: 'run-1',
			operationId: 'operation-1',
			attemptId: 'attempt-1',
			route: { id: 'xai-quality', provider: 'xai', model: 'grok' },
			providerRequestId: 'request-1',
			diagnostic: {
				stage: 'model-content-json',
				content: `api_key=super-secret-value ${'x'.repeat(
					MALFORMED_OUTPUT_DIAGNOSTIC_MAX_CHARS + 100,
				)}`,
			},
			now: new Date('2026-09-27T12:00:00.000Z'),
		});
		const file = path.join(root, diagnosticRef);
		const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
		assert.equal(payload.providerRequestId, 'request-1');
		assert.equal(payload.stage, 'model-content-json');
		assert.equal(payload.truncated, true);
		assert.equal(payload.completionTruncated, undefined);
		assert.match(payload.excerpt, /\[REDACTED\]/);
		assert.doesNotMatch(payload.excerpt, /super-secret-value/);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(fs.existsSync(path.join(root, 'runs')), false);
	} finally {
		cleanupTestRoot(root);
	}
});

test('records a length cutoff separately from an excerpt that was shortened', () => {
	const root = makeTestRoot('malformed-diagnostic-completion');
	try {
		const diagnosticRef = writeMalformedOutputDiagnostic({
			stateRoot: root,
			runId: 'run-1',
			operationId: 'operation-1',
			attemptId: 'attempt-1',
			route: { id: 'anthropic-claude-quality', provider: 'anthropic', model: 'claude' },
			diagnostic: {
				stage: 'model-content-json',
				content: '{"action":',
				truncated: true,
			},
		});
		const payload = JSON.parse(fs.readFileSync(path.join(root, diagnosticRef), 'utf8'));
		assert.equal(payload.stage, 'model-content-json');
		assert.equal(payload.truncated, false);
		assert.equal(payload.completionTruncated, true);
		assert.match(payload.excerpt, /\{"action":/);
	} finally {
		cleanupTestRoot(root);
	}
});

test('prunes diagnostics after the seven-day retention window', () => {
	const root = makeTestRoot('malformed-diagnostic-prune');
	try {
		const capturedAt = new Date('2026-09-01T00:00:00.000Z');
		const diagnosticRef = writeMalformedOutputDiagnostic({
			stateRoot: root,
			runId: 'run-1',
			operationId: 'operation-1',
			attemptId: 'attempt-1',
			route: { id: 'xai-quality', provider: 'xai', model: 'grok' },
			diagnostic: { stage: 'schema-validation', content: '{}' },
			now: capturedAt,
		});
		const file = path.join(root, diagnosticRef);
		fs.utimesSync(file, capturedAt, capturedAt);
		const removed = pruneExpiredMalformedOutputDiagnostics(
			root,
			new Date(capturedAt.getTime() + MALFORMED_OUTPUT_DIAGNOSTIC_RETENTION_MS + 1),
		);
		assert.deepEqual(removed, [file]);
		assert.equal(fs.existsSync(file), false);
	} finally {
		cleanupTestRoot(root);
	}
});
