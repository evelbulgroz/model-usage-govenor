import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FakeModelAdapter } from '../adapters/fake.ts';
import { addSecondFakeRoute, baseRequest, cleanupTestRoot, enabledFakePolicy } from '../testing/test-support.mjs';
import { setup, run } from '../testing/governor-test-support.mjs';

test('malformed-provider-output', async () => {
		const fake = new FakeModelAdapter('fake-governed', [
			{
				status: 'failed',
				outcome: 'malformed_output',
				diagnostic: {
					stage: 'model-content-json',
					content: 'api_key=super-secret-value invalid-json',
				},
			},
			{ status: 'succeeded', output: { ok: true } },
		]);
		const context = setup('governor-malformed-provider-output', {
			request: baseRequest({
				requestedLimits: {
					maxCompletionTokens: 32,
					maxPhysicalAttempts: 2,
					maxRetriesPerRoute: 1,
				},
			}),
			adapters: new Map([['fake-governed', fake]]),
		});
		try {
			const result = await run(context);
			assert.equal(result.attempts, 2);
			assert.equal(fake.callCount, 2);
			const diagnosticRoot = path.join(
				context.stateRoot,
				'diagnostics',
				encodeURIComponent(context.request.runId),
			);
			const diagnosticFiles = fs.readdirSync(diagnosticRoot);
			assert.equal(diagnosticFiles.length, 1);
			const diagnostic = fs.readFileSync(
				path.join(diagnosticRoot, diagnosticFiles[0]),
				'utf8',
			);
			assert.match(diagnostic, /\[REDACTED\]/);
			assert.doesNotMatch(diagnostic, /super-secret-value/);
			const ledger = fs.readFileSync(
				path.join(context.stateRoot, 'runs', `${context.request.runId}.json`),
				'utf8',
			);
			assert.doesNotMatch(ledger, /diagnostic|invalid-json|super-secret-value/);
		} finally {
			cleanupTestRoot(context.root);
		}
	});

test('malformed output prefers cross-vendor failover', async () => {
		const policy = addSecondFakeRoute(enabledFakePolicy());
		const secondaryRoute = policy.routes.find((route) => route.id === 'fake-secondary');
		secondaryRoute.provider = 'google';
		secondaryRoute.canonicalVendor = 'google';
		const first = new FakeModelAdapter('fake-governed', [
			{ status: 'failed', outcome: 'malformed_output' },
			{ status: 'succeeded', output: { ok: false } },
		]);
		const second = new FakeModelAdapter('fake-secondary', [
			{ status: 'succeeded', output: { ok: true } },
		]);
		const context = setup('governor-malformed-failover', {
			policy,
			request: baseRequest({
				requestedLimits: {
					maxCompletionTokens: 32,
					maxPhysicalAttempts: 2,
					maxRetriesPerRoute: 1,
					maxFailovers: 1,
				},
			}),
			adapters: new Map([
				['fake-governed', first],
				['fake-secondary', second],
			]),
		});
		try {
			const result = await run(context);
			assert.equal(result.route.routeId, 'fake-secondary');
			assert.equal(first.callCount, 1);
			assert.equal(second.callCount, 1);
			assert.equal(result.attempts, 2);
		} finally {
			cleanupTestRoot(context.root);
		}
	});

test('a truncated reply is not retried on the same route', async () => {
		const fake = new FakeModelAdapter('fake-governed', [
			{
				status: 'failed',
				outcome: 'malformed_output',
				diagnostic: {
					stage: 'model-content-json',
					content: '{"action":',
					truncated: true,
				},
			},
			{ status: 'succeeded', output: { ok: true } },
		]);
		const context = setup('governor-truncated-no-retry', {
			request: baseRequest({
				requestedLimits: {
					maxCompletionTokens: 32,
					maxPhysicalAttempts: 2,
					maxRetriesPerRoute: 1,
				},
			}),
			adapters: new Map([['fake-governed', fake]]),
		});
		try {
			await assert.rejects(run(context), (error) => {
				assert.equal(error.code, 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED');
				assert.equal(error.metadata.truncated, true);
				assert.equal(error.metadata.outcome, 'malformed_output');
				return true;
			});
			assert.equal(fake.callCount, 1);
			const diagnosticRoot = path.join(
				context.stateRoot,
				'diagnostics',
				encodeURIComponent(context.request.runId),
			);
			const diagnosticFiles = fs.readdirSync(diagnosticRoot);
			assert.equal(diagnosticFiles.length, 1);
			const payload = JSON.parse(
				fs.readFileSync(path.join(diagnosticRoot, diagnosticFiles[0]), 'utf8'),
			);
			assert.equal(payload.stage, 'model-content-json');
			assert.equal(payload.completionTruncated, true);
			assert.equal(payload.truncated, false);
		} finally {
			cleanupTestRoot(context.root);
		}
	});

test('a truncated reply still fails over to another selected vendor once', async () => {
		const policy = addSecondFakeRoute(enabledFakePolicy());
		const secondaryRoute = policy.routes.find((route) => route.id === 'fake-secondary');
		secondaryRoute.provider = 'google';
		secondaryRoute.canonicalVendor = 'google';
		const first = new FakeModelAdapter('fake-governed', [
			{
				status: 'failed',
				outcome: 'malformed_output',
				diagnostic: {
					stage: 'model-content-json',
					content: '{"action":',
					truncated: true,
				},
			},
			{ status: 'succeeded', output: { ok: false } },
		]);
		const second = new FakeModelAdapter('fake-secondary', [
			{ status: 'succeeded', output: { ok: true } },
		]);
		const context = setup('governor-truncated-failover', {
			policy,
			request: baseRequest({
				requestedLimits: {
					maxCompletionTokens: 32,
					maxPhysicalAttempts: 2,
					maxRetriesPerRoute: 1,
					maxFailovers: 1,
				},
			}),
			adapters: new Map([
				['fake-governed', first],
				['fake-secondary', second],
			]),
		});
		try {
			const result = await run(context);
			assert.equal(result.route.routeId, 'fake-secondary');
			assert.equal(first.callCount, 1);
			assert.equal(second.callCount, 1);
			assert.equal(result.attempts, 2);
		} finally {
			cleanupTestRoot(context.root);
		}
	});
