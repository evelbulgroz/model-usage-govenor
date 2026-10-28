import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FakeModelAdapter } from '../adapters/fake.ts';
import { baseRequest, cleanupTestRoot } from '../testing/test-support.mjs';
import { setup, run } from '../testing/governor-test-support.mjs';

test('pre-aborted dispatch is reconciled without invoking adapter and replays typed failure', async () => {
	const fake = new FakeModelAdapter('fake-governed', [
		{ status: 'succeeded', output: { ok: true } },
	]);
	const context = setup('governor-pre-aborted', {
		adapters: new Map([['fake-governed', fake]]),
	});
	const controller = new AbortController();
	controller.abort(new DOMException('cancel', 'AbortError'));
	try {
		for (let replay = 0; replay < 2; replay += 1) {
			await assert.rejects(
				run(context, context.request, { signal: controller.signal }),
				(error) =>
					error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED' &&
					error.metadata.outcome === 'cancelled',
			);
		}
		assert.equal(fake.callCount, 0);
		const envelope = JSON.parse(
			fs.readFileSync(path.join(context.stateRoot, 'runs', `${context.request.runId}.json`), 'utf8'),
		);
		assert.equal(envelope.attempts.length, 1);
		assert.equal(envelope.attempts[0].outcome, 'cancelled');
		assert.equal(envelope.attempts[0].charge.totalTokens, 0);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('distinguishes timeout and external cancellation and accounts both attempts', async (t) => {
	await t.test('timeout', async () => {
		const request = baseRequest({ requestedLimits: { maxCompletionTokens: 10, timeoutMs: 20 } });
		const fake = new FakeModelAdapter('fake-governed', [
			{ delayMs: 100, result: { status: 'succeeded', output: { ok: true } } },
		]);
		const context = setup('governor-timeout', {
			request,
			adapters: new Map([['fake-governed', fake]]),
		});
		try {
			await assert.rejects(run(context), (error) => error.code === 'ERR_OPERATION_TIMEOUT');
		} finally {
			cleanupTestRoot(context.root);
		}
	});
	await t.test('external cancellation', async () => {
		const controller = new AbortController();
		const fake = new FakeModelAdapter('fake-governed', [
			{ delayMs: 100, result: { status: 'succeeded', output: { ok: true } } },
		]);
		const context = setup('governor-cancel', {
			adapters: new Map([['fake-governed', fake]]),
		});
		try {
			setTimeout(() => controller.abort(new DOMException('cancel', 'AbortError')), 5);
			await assert.rejects(
				run(context, context.request, { signal: controller.signal }),
				(error) =>
					error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED' &&
					error.metadata.outcome === 'cancelled',
			);
		} finally {
			cleanupTestRoot(context.root);
		}
	});
});

test('hard timeout reconciles an adapter that ignores the abort signal', async () => {
	const request = baseRequest({ requestedLimits: { maxCompletionTokens: 10, timeoutMs: 20 } });
	const hanging = {
		routeId: 'fake-governed',
		execute() {
			return new Promise(() => {});
		},
	};
	const context = setup('governor-hard-timeout', {
		request,
		adapters: new Map([['fake-governed', hanging]]),
	});
	try {
		const startedAt = Date.now();
		await assert.rejects(run(context), (error) => error.code === 'ERR_OPERATION_TIMEOUT');
		assert.ok(Date.now() - startedAt < 500, 'governor must not await a non-cooperative adapter');
		const envelope = JSON.parse(
			fs.readFileSync(path.join(context.stateRoot, 'runs', `${request.runId}.json`), 'utf8'),
		);
		assert.equal(envelope.reservations.length, 0);
		assert.equal(envelope.attempts[0].outcome, 'timeout');
		assert.equal(envelope.attempts[0].usageSource, 'estimated');
	} finally {
		cleanupTestRoot(context.root);
	}
});
