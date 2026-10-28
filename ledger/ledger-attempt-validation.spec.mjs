import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ModelUsageError } from '../policy/errors.ts';
import { validateCharge, validateTokenDetails } from './ledger-attempt-validation.ts';
import { ModelUsageLedger } from './ledger.ts';
import { cleanupTestRoot } from '../testing/test-support.mjs';
import { setup, reserve, successResult, reconcileUsage, readRunFile, detailsEnvelope, assertLedgerRejects } from '../testing/ledger-test-support.mjs';

test('validates closed immutable attempt audit fields', () => {
	const context = setup('ledger-closed-attempt-schema');
	try {
		const reserved = reserve(context);
		successResult(context, reserved);
		const file = context.ledger.runFile(context.request.runId);
		const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
		envelope.attempts[0].estimator.rawBody = 'must not be accepted';
		fs.writeFileSync(file, JSON.stringify(envelope));
		assert.throws(
			() =>
				new ModelUsageLedger({ stateRoot: context.stateRoot }).getRunSummary(
					context.request.runId,
					context.request.operationId,
				),
			/attempt\.estimator contains unknown key 'rawBody'/,
		);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('@ac AC-03 @case AC-03.2 a timed-out estimated attempt has no tokenDetails', () => {
	const context = setup('ledger-ac-03-2');
	try {
		const reserved = reserve(context);
		reconcileUsage(context, reserved, {
			terminal: 'failed',
			outcome: 'timeout',
			failure: new ModelUsageError('ERR_OPERATION_TIMEOUT', 'timed out'),
		});
		const attempt = JSON.parse(readRunFile(context)).attempts[0];
		assert.equal(attempt.outcome, 'timeout');
		assert.equal(attempt.usageSource, 'estimated');
		assert.equal(Object.hasOwn(attempt, 'tokenDetails'), false);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('@ac AC-04 @case AC-04.2 cache details above charge.promptTokens are rejected', () => {
	const { context, envelope } = detailsEnvelope('ledger-ac-04-2');
	try {
		envelope.attempts[0].tokenDetails.cacheReadTokens = envelope.attempts[0].charge.promptTokens + 1;
		assertLedgerRejects(envelope, /cache tokens exceed charge\.promptTokens/);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('@ac AC-04 @case AC-04.3 an unknown tokenDetails key is rejected', () => {
	const { context, envelope } = detailsEnvelope('ledger-ac-04-3');
	try {
		envelope.attempts[0].tokenDetails.extra = 1;
		assertLedgerRejects(envelope, /unknown key 'extra'/);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('@ac AC-04 @case AC-04.4 tokenDetails inside a 1.1.0 envelope is rejected', () => {
	const { context, envelope } = detailsEnvelope('ledger-ac-04-4');
	try {
		envelope.schemaVersion = '1.1.0';
		assertLedgerRejects(envelope, /unknown key 'tokenDetails'/);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('@ac AC-04 @case AC-04.5 a negative reasoningTokens count is rejected', () => {
	const { context, envelope } = detailsEnvelope('ledger-ac-04-5');
	try {
		envelope.attempts[0].tokenDetails.reasoningTokens = -1;
		assertLedgerRejects(envelope, /reasoningTokens invalid/);
	} finally {
		cleanupTestRoot(context.stateRoot);
	}
});

test('validateCharge and validateTokenDetails reject inconsistent and negative counts', () => {
	const charge = {
		promptTokens: 1,
		completionTokens: 1,
		totalTokens: 2,
		physicalCalls: 1,
		costMicrousd: 0,
		premiumRequestUnits: 0,
	};
	assert.equal(validateCharge(charge, 'charge'), undefined);
	assert.throws(() => validateCharge({ ...charge, totalTokens: 3 }, 'charge'), /inconsistent/);
	const details = { cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: null };
	assert.equal(validateTokenDetails(details, charge, 'tokenDetails'), undefined);
	assert.throws(
		() => validateTokenDetails({ ...details, reasoningTokens: -1 }, charge, 'tokenDetails'),
		/invalid/,
	);
});
