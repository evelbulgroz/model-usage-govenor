import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchesSchema } from './structured-output-schema.ts';
import path from 'node:path';
import test from 'node:test';
import { FakeModelAdapter } from '../adapters/fake.ts';
import { baseRequest, cleanupTestRoot } from '../testing/test-support.mjs';
import { setup, run } from '../testing/governor-test-support.mjs';

test('matches structured enum and const values by JSON structure', async () => {
	const output = {
		action: {
			kind: 'tool_call',
			parameters: {
				args: ['--filter', '@example/target-package', 'test'],
				path: null,
			},
			marker: { forced: true },
		},
	};
	const context = setup('governor-structural-enum', {
		request: baseRequest({
			structuredOutputSchema: {
				type: 'object',
				required: ['action'],
				additionalProperties: false,
				properties: {
					action: {
						type: 'object',
						required: ['kind', 'parameters', 'marker'],
						additionalProperties: false,
						properties: {
							kind: { const: 'tool_call' },
							parameters: {
								type: 'object',
								required: ['args', 'path'],
								additionalProperties: false,
								properties: {
									args: {
										enum: [
											[
												'--filter',
												'@example/target-package',
												'test',
											],
										],
									},
									path: {
										anyOf: [{ type: 'string' }, { type: 'null' }],
									},
								},
							},
							marker: { const: { forced: true } },
						},
					},
				},
			},
		}),
		adapters: new Map([
			[
				'fake-governed',
				new FakeModelAdapter('fake-governed', [
					{ status: 'succeeded', output },
				]),
			],
		]),
	});
	try {
		assert.deepEqual((await run(context)).output, output);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('rejects unsupported schema keywords before state read and validates nested supported subset', async () => {
	const context = setup('governor-schema', {
		request: baseRequest({
			structuredOutputSchema: { type: 'string', pattern: '^unsafe-unsupported$' },
		}),
	});
	try {
		await assert.rejects(run(context), /Unsupported structured output schema keyword/);
		assert.equal(fs.existsSync(context.stateRoot), false);
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('accepts finite numeric minimum schemas and enforces the bound', async (t) => {
	await t.test('accepts value at minimum', async () => {
		const context = setup('governor-schema-minimum', {
			request: baseRequest({
				structuredOutputSchema: {
					type: 'object',
					required: ['line'],
					properties: { line: { type: 'integer', minimum: 1 } },
					additionalProperties: false,
				},
			}),
			adapters: new Map([
				[
					'fake-governed',
					new FakeModelAdapter('fake-governed', [
						{ status: 'succeeded', output: { line: 1 } },
					]),
				],
			]),
		});
		try {
			assert.deepEqual((await run(context)).output, { line: 1 });
		} finally {
			cleanupTestRoot(context.root);
		}
	});

	await t.test('rejects a non-numeric minimum before state mutation', async () => {
		const context = setup('governor-schema-invalid-minimum', {
			request: baseRequest({
				structuredOutputSchema: { type: 'string', minimum: 1 },
			}),
		});
		try {
			await assert.rejects(run(context), /minimum.*finite numeric type/);
			assert.equal(fs.existsSync(context.stateRoot), false);
		} finally {
			cleanupTestRoot(context.root);
		}
	});

	await t.test('treats output below minimum as malformed', async () => {
		const context = setup('governor-schema-below-minimum', {
			request: baseRequest({
				requestedLimits: {
					maxCompletionTokens: 32,
					maxPhysicalAttempts: 1,
					maxRetriesPerRoute: 0,
				},
				structuredOutputSchema: {
					type: 'object',
					required: ['line'],
					properties: { line: { type: 'integer', minimum: 1 } },
					additionalProperties: false,
				},
			}),
			adapters: new Map([
				[
					'fake-governed',
					new FakeModelAdapter('fake-governed', [
						{ status: 'succeeded', output: { line: 0 } },
					]),
				],
			]),
		});
		try {
			await assert.rejects(
				run(context),
				(error) =>
					error.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED' &&
					error.metadata.outcome === 'malformed_output',
			);
		} finally {
			cleanupTestRoot(context.root);
		}
	});
});

test('validates anyOf structured output schemas and matches compatible values', async () => {
	const schema = {
		type: 'object',
		required: ['value'],
		properties: {
			value: {
				anyOf: [
					{ type: 'string' },
					{ type: 'array', items: { type: 'string' } },
				],
			},
		},
	};

	const contextString = setup('governor-schema-anyof-string', {
		request: baseRequest({
			operationId: 'op-anyof-1',
			structuredOutputSchema: schema,
		}),
		adapters: new Map([
			[
				'fake-governed',
				new FakeModelAdapter('fake-governed', [
					{
						status: 'succeeded',
						output: { value: 'hello' },
						usage: { promptTokens: 2, completionTokens: 1, source: 'provider' },
					},
				]),
			],
		]),
	});
	try {
		const res = await run(contextString);
		assert.equal(res.status, 'succeeded');
		assert.deepEqual(res.output, { value: 'hello' });
	} finally {
		cleanupTestRoot(contextString.root);
	}

	const contextArray = setup('governor-schema-anyof-array', {
		request: baseRequest({
			operationId: 'op-anyof-2',
			structuredOutputSchema: schema,
		}),
		adapters: new Map([
			[
				'fake-governed',
				new FakeModelAdapter('fake-governed', [
					{
						status: 'succeeded',
						output: { value: ['a', 'b'] },
						usage: { promptTokens: 2, completionTokens: 1, source: 'provider' },
					},
				]),
			],
		]),
	});
	try {
		const res = await run(contextArray);
		assert.equal(res.status, 'succeeded');
		assert.deepEqual(res.output, { value: ['a', 'b'] });
	} finally {
		cleanupTestRoot(contextArray.root);
	}

	const contextMismatch = setup('governor-schema-anyof-mismatch', {
		request: baseRequest({
			operationId: 'op-anyof-3',
			structuredOutputSchema: schema,
		}),
		adapters: new Map([
			[
				'fake-governed',
				new FakeModelAdapter('fake-governed', [
					{
						status: 'succeeded',
						output: { value: 123 },
						usage: { promptTokens: 2, completionTokens: 1, source: 'provider' },
					},
				]),
			],
		]),
	});
	try {
		await assert.rejects(run(contextMismatch), (err) => err.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED');
	} finally {
		cleanupTestRoot(contextMismatch.root);
	}

	// Rejects invalid anyOf definitions
	const contextInvalid = setup('governor-schema-anyof-invalid', {
		request: baseRequest({
			operationId: 'op-anyof-4',
			structuredOutputSchema: {
				type: 'object',
				properties: {
					value: { anyOf: [] },
				},
			},
		}),
	});
	try {
		await assert.rejects(run(contextInvalid), /Schema anyOf at \$\.properties\.value must be a non-empty array/);
	} finally {
		cleanupTestRoot(contextInvalid.root);
	}
});

test('matches sparse tool parameters when omitted required keys are nullable', async () => {
	const schema = {
		type: 'object',
		required: ['action'],
		additionalProperties: false,
		properties: {
			action: {
				type: 'object',
				required: ['kind', 'toolName', 'parameters'],
				additionalProperties: false,
				properties: {
					kind: { type: 'string', enum: ['tool_call'] },
					toolName: { type: 'string', enum: ['read_file', 'replace_in_file', 'write_file'] },
					parameters: {
						type: 'object',
						additionalProperties: false,
						required: ['path', 'old_string', 'new_string', 'content'],
						properties: {
							path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
							old_string: { anyOf: [{ type: 'string' }, { type: 'null' }] },
							new_string: { anyOf: [{ type: 'string' }, { type: 'null' }] },
							content: { anyOf: [{ type: 'string' }, { type: 'null' }] },
						},
					},
				},
			},
		},
	};
	const output = {
		action: {
			kind: 'tool_call',
			toolName: 'replace_in_file',
			parameters: {
				path: 'packages/example/src/foo.ts',
				old_string: 'a',
				new_string: 'b',
			},
		},
	};
	const context = setup('governor-schema-replace-in-file', {
		request: baseRequest({
			operationId: 'op-replace-in-file',
			structuredOutputSchema: schema,
		}),
		adapters: new Map([
			[
				'fake-governed',
				new FakeModelAdapter('fake-governed', [
					{
						status: 'succeeded',
						output,
						usage: { promptTokens: 2, completionTokens: 1, source: 'provider' },
					},
				]),
			],
		]),
	});
	try {
		const res = await run(context);
		assert.equal(res.status, 'succeeded');
		assert.equal(res.output.action.toolName, 'replace_in_file');
	} finally {
		cleanupTestRoot(context.root);
	}
});

test('matchesSchema compares const values by structure', () => {
	assert.equal(matchesSchema({ ok: true }, { const: { ok: true } }), true);
	assert.equal(matchesSchema({ ok: false }, { const: { ok: true } }), false);
});
