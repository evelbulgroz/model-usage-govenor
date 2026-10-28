import assert from 'node:assert/strict';
import test from 'node:test';
import {
	classifyAttemptOutcome,
	dispatchAttempt,
	linkedAttemptSignal,
	reservedFailoverTimeMs,
} from './governor-attempt.ts';

const policy = { retryableOutcomes: ['timeout', 'transport', 'http_5xx', 'malformed_output'] };
const profile = { limits: { maxFailovers: 2, maxRetriesPerRoute: 1, maxPhysicalAttempts: 4, operationTimeoutMs: 60_000 } };
const routes = [{ id: 'primary' }, { id: 'secondary' }];

function flags(outcome) {
	return classifyAttemptOutcome({
		result: { status: 'failed', outcome },
		policy,
		profile,
		routes,
		routeIndex: 0,
		failovers: 0,
		attempts: 1,
		retryIndex: 0,
		availableAlternativeVendorCount: 1,
		hasDispatchTimeRemaining: true,
		completionTruncated: false,
	});
}

test('classifyAttemptOutcome prefers failover for quota, 5xx, and malformed output', () => {
	assert.equal(flags('quota').preferFailover, true);
	assert.equal(flags('quota').canRetry, false);
	assert.equal(flags('http_4xx').canFailover, false);
	assert.equal(flags('http_4xx').terminal, 'failed');
	assert.equal(flags('http_5xx').preferFailover, true);
	assert.equal(flags('http_5xx').canRetry, false);
	assert.equal(flags('transport').preferFailover, false);
	assert.equal(flags('transport').canRetry, true);
	assert.equal(flags('malformed_output').preferFailover, true);
	assert.equal(flags('malformed_output').canRetry, false);
});

test('reservedFailoverTimeMs returns 0 when no alternative route remains', () => {
	assert.equal(reservedFailoverTimeMs(1_000, profile, 0, 1, 0), 0);
});

test('dispatchAttempt does not call the adapter when the signal is already aborted', async () => {
	const controller = new AbortController();
	controller.abort();
	const linked = linkedAttemptSignal(controller.signal, 1_000);
	let called = false;
	const result = await dispatchAttempt({
		adapter: { execute() { called = true; } },
		request: { operationId: 'operation', prompt: 'prompt' },
		reserved: { reservation: { attemptId: 'attempt' } },
		completionTokens: 1,
		linked,
	});
	assert.equal(called, false);
	assert.equal(result.status, 'failed');
	assert.equal(result.outcome, 'cancelled');
	assert.equal(result.executionProvenFalse, true);
});
