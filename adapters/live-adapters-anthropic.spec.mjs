import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicModelAdapter, pruneUnusedToolParameters, relaxNullableRequiredProperties } from './anthropic.ts';
import { route, request, response } from '../testing/live-adapters-test-support.mjs';

test('Anthropic adapter normalizes structured output, usage, request ID and request shape', async () => {
	let captured;
	const adapter = new AnthropicModelAdapter(route('anthropic'), {
		env: { ANTHROPIC_API_KEY: 'credential' },
		fetchImpl: async (url, init) => {
			captured = { url, init };
			return response({
				requestId: 'anthropic-1',
				body: {
					content: [{ type: 'text', text: '{"ok":true}' }],
					usage: { input_tokens: 5, output_tokens: 3 },
				},
			});
		},
	});
	const result = await adapter.execute(request());
	assert.deepEqual(result.output, { ok: true });
	assert.deepEqual(result.usage, {
		promptTokens: 5,
		completionTokens: 3,
		source: 'provider',
		tokenDetails: { cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
	});
	assert.equal(result.providerRequestId, 'anthropic-1');
	assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
	assert.equal(captured.init.headers['anthropic-version'], '2023-06-01');
	assert.equal(captured.init.headers['x-api-key'], 'credential');
	const sent = JSON.parse(captured.init.body);
	assert.equal(sent.model, 'claude-sonnet-5-5');
	assert.equal(sent.max_tokens, 10);
	assert.deepEqual(sent.thinking, { type: 'between_tools' });
	assert.equal(sent.cache_control, undefined);
	assert.equal(sent.messages[0].content, 'prompt');
	assert.equal(sent.output_config.format.type, 'json_schema');
	assert.deepEqual(sent.output_config.format.schema, { type: 'object' });
});

test('Anthropic adapter caches stable prompt blocks and splits cache usage from the uncached tail', async () => {
	let captured;
	const adapter = new AnthropicModelAdapter(route('anthropic'), {
		env: { ANTHROPIC_API_KEY: 'credential' },
		fetchImpl: async (url, init) => {
			captured = { url, init };
			return response({
				body: {
					content: [{ type: 'text', text: '{"ok":true}' }],
					usage: {
						input_tokens: 20,
						cache_read_input_tokens: 500,
						cache_creation_input_tokens: 40,
						output_tokens: 3,
					},
				},
			});
		},
	});
	const result = await adapter.execute({
		...request(),
		prompt: 'task\ntool result',
		promptBlocks: ['task', 'tool result'],
	});
	const sent = JSON.parse(captured.init.body);
	assert.deepEqual(sent.cache_control, { type: 'ephemeral' });
	assert.deepEqual(sent.messages[0].content, [
		{ type: 'text', text: 'task' },
		{ type: 'text', text: '\ntool result' },
	]);
	assert.deepEqual(result.usage, {
		promptTokens: 20,
		completionTokens: 3,
		cacheReadTokens: 500,
		cacheWriteTokens: 40,
		source: 'provider',
		tokenDetails: { cacheReadTokens: 500, cacheWriteTokens: 40, reasoningTokens: null },
	});
});

test('Anthropic adapter breakpoints the block before a trailing verification section', async () => {
	let captured;
	const adapter = new AnthropicModelAdapter(route('anthropic'), {
		env: { ANTHROPIC_API_KEY: 'credential' },
		fetchImpl: async (_url, init) => {
			captured = init;
			return response({
				body: {
					content: [{ type: 'text', text: '{"ok":true}' }],
					usage: { input_tokens: 4, cache_read_input_tokens: 80, cache_creation_input_tokens: 6, output_tokens: 2 },
				},
			});
		},
	});
	const blocks = ['task', 'read_file {"path":"a"}', '### Verification\nmissing case ids'];
	await adapter.execute({
		...request(),
		prompt: blocks.join('\n'),
		promptBlocks: blocks,
		promptCacheBreakpoint: 1,
	});
	const sent = JSON.parse(captured.body);
	assert.equal(sent.cache_control, undefined);
	assert.deepEqual(sent.messages[0].content, [
		{ type: 'text', text: 'task' },
		{ type: 'text', text: '\nread_file {"path":"a"}', cache_control: { type: 'ephemeral' } },
		{ type: 'text', text: '\n### Verification\nmissing case ids' },
	]);
});

test('Anthropic adapter drops usage when a cache token field is not an integer', async () => {
	const adapter = new AnthropicModelAdapter(route('anthropic'), {
		env: { ANTHROPIC_API_KEY: 'credential' },
		fetchImpl: async () =>
			response({
				body: {
					content: [{ type: 'text', text: '{"ok":true}' }],
					usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 1.5 },
				},
			}),
	});
	const result = await adapter.execute(request());
	assert.equal(result.status, 'succeeded');
	assert.equal(result.usage, undefined);
});

test('Anthropic adapter relaxes required-but-nullable properties to genuinely optional before sending', async () => {
	let captured;
	const adapter = new AnthropicModelAdapter(route('anthropic'), {
		env: { ANTHROPIC_API_KEY: 'credential' },
		fetchImpl: async (url, init) => {
			captured = { url, init };
			return response({ body: { content: [{ type: 'text', text: '{"ok":true}' }] } });
		},
	});
	await adapter.execute({
		...request(),
		structuredOutputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['path', 'content'],
			properties: {
				path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
				content: { type: 'string' },
			},
		},
	});
	const sentSchema = JSON.parse(captured.init.body).output_config.format.schema;
	assert.deepEqual(sentSchema.properties.path, { type: 'string' });
	assert.deepEqual(sentSchema.required, ['content']);
});

test('relaxNullableRequiredProperties demotes only required nullable anyOf unions, recursively, leaving real unions and optional-already properties untouched', () => {
	const schema = {
		type: 'object',
		required: ['a', 'b'],
		properties: {
			a: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			b: {
				type: 'array',
				items: {
					type: 'object',
					required: ['c'],
					properties: {
						c: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
						d: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
					},
				},
			},
			e: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
		},
	};
	const relaxed = relaxNullableRequiredProperties(schema);
	assert.deepEqual(relaxed.required, ['b']);
	assert.deepEqual(relaxed.properties.a, { type: 'string' });
	assert.deepEqual(relaxed.properties.b.items.required, []);
	assert.deepEqual(relaxed.properties.b.items.properties.c, { type: 'integer' });
	// 'd' is a real type union (string|array), not an optional-marker nullable
	// union, and 'e' is nullable but not in the parent's required list: both
	// must survive unchanged.
	assert.deepEqual(relaxed.properties.b.items.properties.d, schema.properties.b.items.properties.d);
	assert.deepEqual(relaxed.properties.e, schema.properties.e);
});

test('pruneUnusedToolParameters prunes irrelevant parameters and tightens single-tool mandatory parameters', () => {
	const baseToolAction = {
		type: 'object',
		required: ['kind', 'toolName', 'parameters'],
		properties: {
			kind: { type: 'string', enum: ['tool_call'] },
			toolName: { type: 'string', enum: ['replace_in_file'] },
			parameters: {
				type: 'object',
				required: [
					'path',
					'content',
					'old_string',
					'new_string',
					'expected_file_hash',
					'start_line',
					'end_line',
					'pattern',
					'command',
					'args',
					'acknowledgedShrink',
				],
				properties: {
					path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
					content: { anyOf: [{ type: 'string' }, { type: 'null' }] },
					old_string: { anyOf: [{ type: 'string' }, { type: 'null' }] },
					new_string: { anyOf: [{ type: 'string' }, { type: 'null' }] },
					expected_file_hash: { anyOf: [{ type: 'string' }, { type: 'null' }] },
					start_line: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
					end_line: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
					pattern: { anyOf: [{ type: 'string' }, { type: 'null' }] },
					command: { anyOf: [{ type: 'string' }, { type: 'null' }] },
					args: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
					acknowledgedShrink: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
				},
			},
		},
	};

	const pruned = pruneUnusedToolParameters(baseToolAction);
	const params = pruned.properties.parameters;

	// Only replace_in_file allowed parameters survive
	assert.deepEqual(Object.keys(params.properties).sort(), [
		'expected_file_hash',
		'new_string',
		'old_string',
		'path',
	]);
	// Single tool: all mandatory parameters tightened to non-null required properties
	assert.deepEqual(params.required.sort(), [
		'expected_file_hash',
		'new_string',
		'old_string',
		'path',
	]);
	assert.deepEqual(params.properties.old_string, { type: 'string' });
	assert.deepEqual(params.properties.new_string, { type: 'string' });

	// When relaxed afterwards, 0 optional parameters remain
	const relaxed = relaxNullableRequiredProperties(pruned);
	assert.deepEqual(relaxed.properties.parameters.required.sort(), [
		'expected_file_hash',
		'new_string',
		'old_string',
		'path',
	]);
});

test('pruneUnusedToolParameters and relaxNullableRequiredProperties keep multi-variant schema optional parameters below Anthropic limit (24)', () => {
	function countOptionalParameters(node) {
		let count = 0;
		if (!node || typeof node !== 'object') return 0;
		if (Array.isArray(node)) {
			for (const item of node) count += countOptionalParameters(item);
			return count;
		}
		if (node.properties && typeof node.properties === 'object') {
			const required = new Set(Array.isArray(node.required) ? node.required : []);
			for (const key of Object.keys(node.properties)) {
				if (!required.has(key)) count += 1;
			}
			for (const val of Object.values(node.properties)) {
				count += countOptionalParameters(val);
			}
		}
		if (node.items) count += countOptionalParameters(node.items);
		if (Array.isArray(node.anyOf)) {
			for (const branch of node.anyOf) count += countOptionalParameters(branch);
		}
		if (Array.isArray(node.oneOf)) {
			for (const branch of node.oneOf) count += countOptionalParameters(branch);
		}
		return count;
	}

	const baseParameters = {
		type: 'object',
		required: [
			'path',
			'content',
			'old_string',
			'new_string',
			'expected_file_hash',
			'start_line',
			'end_line',
			'pattern',
			'command',
			'args',
			'acknowledgedShrink',
		],
		properties: {
			path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			content: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			old_string: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			new_string: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			expected_file_hash: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			start_line: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
			end_line: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
			pattern: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			command: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			args: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
			acknowledgedShrink: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
		},
	};

	// Multi-tool variant (read/search/command)
	const nonMutationAction = {
		type: 'object',
		required: ['kind', 'toolName', 'parameters'],
		properties: {
			kind: { type: 'string', enum: ['tool_call'] },
			toolName: {
				type: 'string',
				enum: [
					'read_file',
					'delete_file',
					'list_dir',
					'find_files',
					'run_allowlisted_command',
				],
			},
			parameters: structuredClone(baseParameters),
		},
	};

	// Snapshot-bound replace_in_file variants
	const replaceAction1 = {
		type: 'object',
		required: ['kind', 'toolName', 'parameters'],
		properties: {
			kind: { type: 'string', enum: ['tool_call'] },
			toolName: { type: 'string', enum: ['replace_in_file'] },
			parameters: {
				...structuredClone(baseParameters),
				properties: {
					...structuredClone(baseParameters.properties),
					path: { type: 'string', enum: ['packages/example/src/file1.ts'] },
					expected_file_hash: { type: 'string', enum: ['hash1'] },
				},
			},
		},
	};

	const replaceAction2 = {
		type: 'object',
		required: ['kind', 'toolName', 'parameters'],
		properties: {
			kind: { type: 'string', enum: ['tool_call'] },
			toolName: { type: 'string', enum: ['replace_in_file'] },
			parameters: {
				...structuredClone(baseParameters),
				properties: {
					...structuredClone(baseParameters.properties),
					path: { type: 'string', enum: ['packages/example/src/file2.ts'] },
					expected_file_hash: { type: 'string', enum: ['hash2'] },
				},
			},
		},
	};

	const rootSchema = {
		type: 'object',
		required: ['rationale', 'action'],
		properties: {
			rationale: { type: 'string' },
			action: {
				anyOf: [nonMutationAction, replaceAction1, replaceAction2],
			},
		},
	};

	// Unpruned schema produces 29 optional parameters, which causes Anthropic error
	const unprunedRelaxed = relaxNullableRequiredProperties(structuredClone(rootSchema));
	assert.equal(countOptionalParameters(unprunedRelaxed), 29);

	// Pruned schema produces only 5 optional parameters, safely below the 24 limit
	const prunedRelaxed = relaxNullableRequiredProperties(
		pruneUnusedToolParameters(structuredClone(rootSchema)),
	);
	const optionalCount = countOptionalParameters(prunedRelaxed);
	assert.equal(optionalCount, 5);
	assert.ok(optionalCount < 24);
});
