import { ModelUsageError } from '../policy/errors.ts';
import type { PolicyRoute } from '../policy/policy-route-catalog.ts';
import {
	type AdapterRequest,
	type AdapterResult,
	type ModelAdapter,
	fallbackDiagnosticContent,
	outcomeForStatus,
	parseModelJson,
	parseRetryAfterMs,
	validateAdapterRequest,
	validateAdapterResult,
} from './adapter-contract.ts';

type SchemaObject = Record<string, unknown>;

function isNullableUnion(propertySchema: unknown): propertySchema is { anyOf: SchemaObject[] } {
	if (!propertySchema || typeof propertySchema !== 'object') return false;
	const rec = propertySchema as SchemaObject;
	return (
		Array.isArray(rec.anyOf) &&
		rec.anyOf.length === 2 &&
		rec.anyOf.some((branch) => (branch as SchemaObject | null)?.type === 'null')
	);
}

function nonNullBranch(propertySchema: { anyOf: SchemaObject[] }): unknown {
	return propertySchema.anyOf.find((branch) => branch?.type !== 'null');
}

const TOOL_ALLOWED_PARAMETERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	read_file: ['path', 'start_line'],
	delete_file: ['path'],
	list_dir: ['path'],
	find_files: ['path', 'pattern'],
	run_allowlisted_command: ['command', 'args'],
	write_file: ['path', 'content', 'acknowledgedShrink'],
	replace_in_file: ['path', 'expected_file_hash', 'old_string', 'new_string'],
	replace_snapshot_range: [
		'path',
		'expected_file_hash',
		'start_line',
		'end_line',
		'new_string',
		'acknowledgedShrink',
	],
});

const TOOL_MANDATORY_PARAMETERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	read_file: ['path'],
	delete_file: ['path'],
	list_dir: ['path'],
	find_files: ['path', 'pattern'],
	run_allowlisted_command: ['command', 'args'],
	write_file: ['path', 'content'],
	replace_in_file: ['path', 'expected_file_hash', 'old_string', 'new_string'],
	replace_snapshot_range: [
		'path',
		'expected_file_hash',
		'start_line',
		'end_line',
		'new_string',
	],
});

function getToolNames(toolNameSchema: unknown): unknown[] | null {
	if (!toolNameSchema || typeof toolNameSchema !== 'object') return null;
	const rec = toolNameSchema as SchemaObject;
	if (Array.isArray(rec.enum)) return rec.enum;
	if (typeof rec.const === 'string') return [rec.const];
	return null;
}

export function pruneUnusedToolParameters(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(pruneUnusedToolParameters);
	if (!node || typeof node !== 'object') return node;

	const next: SchemaObject = { ...(node as SchemaObject) };
	const nextProperties =
		next.properties && typeof next.properties === 'object'
			? (next.properties as SchemaObject)
			: undefined;

	const toolNames = getToolNames(nextProperties?.toolName);
	const origParams =
		nextProperties?.parameters && typeof nextProperties.parameters === 'object'
			? (nextProperties.parameters as SchemaObject)
			: undefined;
	const origProps =
		origParams?.properties && typeof origParams.properties === 'object'
			? (origParams.properties as SchemaObject)
			: undefined;

	if (toolNames && origParams && origProps) {
		const candidateTools = toolNames.filter(
			(name): name is string => typeof name === 'string' && name in TOOL_ALLOWED_PARAMETERS,
		);
		if (candidateTools.length > 0) {
			const allowedParams = new Set<string>();
			for (const tool of candidateTools) {
				for (const param of TOOL_ALLOWED_PARAMETERS[tool] ?? []) {
					allowedParams.add(param);
				}
			}

			const isSingleTool = candidateTools.length === 1;
			const mandatoryParams = new Set<string>(
				isSingleTool ? (TOOL_MANDATORY_PARAMETERS[candidateTools[0]] ?? []) : [],
			);

			const origRequired = Array.isArray(origParams.required)
				? (origParams.required as string[])
				: [];
			const nextProps: SchemaObject = {};
			const nextRequired = new Set<string>();

			for (const [paramName, paramSchema] of Object.entries(origProps)) {
				if (!allowedParams.has(paramName)) {
					continue;
				}
				if (isSingleTool && mandatoryParams.has(paramName)) {
					nextProps[paramName] = isNullableUnion(paramSchema)
						? nonNullBranch(paramSchema)
						: paramSchema;
					nextRequired.add(paramName);
				} else {
					nextProps[paramName] = paramSchema;
					if (origRequired.includes(paramName)) {
						nextRequired.add(paramName);
					}
				}
			}

			next.properties = {
				...nextProperties,
				parameters: {
					...origParams,
					properties: nextProps,
					required: [...nextRequired],
				},
			};
		}
	}

	if (next.properties && typeof next.properties === 'object') {
		const properties: SchemaObject = {};
		for (const [key, value] of Object.entries(next.properties as SchemaObject)) {
			properties[key] = pruneUnusedToolParameters(value);
		}
		next.properties = properties;
	}
	if (next.items) next.items = pruneUnusedToolParameters(next.items);
	if (Array.isArray(next.anyOf)) next.anyOf = next.anyOf.map(pruneUnusedToolParameters);
	if (Array.isArray(next.oneOf)) next.oneOf = next.oneOf.map(pruneUnusedToolParameters);

	return next;
}

export function relaxNullableRequiredProperties(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(relaxNullableRequiredProperties);
	if (!node || typeof node !== 'object') return node;
	const next: SchemaObject = { ...(node as SchemaObject) };
	if (next.properties && typeof next.properties === 'object') {
		const requiredSet = new Set<string>(
			Array.isArray(next.required) ? (next.required as string[]) : [],
		);
		const properties: SchemaObject = {};
		for (const [key, value] of Object.entries(next.properties as SchemaObject)) {
			if (requiredSet.has(key) && isNullableUnion(value)) {
				properties[key] = relaxNullableRequiredProperties(nonNullBranch(value));
				requiredSet.delete(key);
			} else {
				properties[key] = relaxNullableRequiredProperties(value);
			}
		}
		next.properties = properties;
		next.required = [...requiredSet];
	}
	if (next.items) next.items = relaxNullableRequiredProperties(next.items);
	if (Array.isArray(next.anyOf)) next.anyOf = next.anyOf.map(relaxNullableRequiredProperties);
	if (Array.isArray(next.oneOf)) next.oneOf = next.oneOf.map(relaxNullableRequiredProperties);
	return next;
}

function cacheTokenCount(usage: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = usage?.[key];
	if (value === undefined || value === 0) return 0;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
	return value;
}

// Absent and invalid counts stay null. Do not reuse cacheTokenCount: it maps both to 0.
function observedCount(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
	return value;
}

export class AnthropicModelAdapter implements ModelAdapter {
	readonly routeId: string;
	readonly route: PolicyRoute;
	readonly fetchImpl: typeof globalThis.fetch;
	readonly env: NodeJS.ProcessEnv;

	constructor(
		route: PolicyRoute,
		{
			fetchImpl = globalThis.fetch,
			env = process.env,
		}: { fetchImpl?: typeof globalThis.fetch; env?: NodeJS.ProcessEnv } = {},
	) {
		if (
			!route?.enabled ||
			!['governed', 'governed-conservative'].includes(route.classification) ||
			!route.capabilities?.includes('structured-output') ||
			!route.capabilities?.includes('abort') ||
			!route.credentialEnv ||
			!route.baseUrl
		) {
			throw new ModelUsageError(
				'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
				'Anthropic route lacks committed governance capabilities',
				{ routeId: route?.id, reason: 'capability-gate' },
			);
		}
		this.routeId = route.id;
		this.route = route;
		this.fetchImpl = fetchImpl;
		this.env = env;
	}

	async execute(request: AdapterRequest): Promise<AdapterResult> {
		validateAdapterRequest(request);
		const credential = this.route.credentialEnv ? this.env[this.route.credentialEnv] : undefined;
		if (!credential) {
			return validateAdapterResult({
				status: 'failed',
				outcome: 'transport',
				executionProvenFalse: true,
			});
		}
		let response: Response;
		try {
			const blocks = request.promptBlocks;
			const cacheBlocks = Array.isArray(blocks);
			// An explicit breakpoint caches through that block and leaves the trailing block uncached.
			// Top-level automatic caching breakpoints the last block, which misses when that block is a stable tail with new blocks inserted before it.
			const automaticCache = cacheBlocks && request.promptCacheBreakpoint === undefined;
			response = await this.fetchImpl(`${this.route.baseUrl}/messages`, {
				method: 'POST',
				headers: {
					'anthropic-version': '2023-06-01',
					'content-type': 'application/json',
					'x-api-key': credential,
				},
				signal: request.signal,
				body: JSON.stringify({
					model: this.route.model,
					max_tokens: request.maxCompletionTokens,
					// The provider requires between_tools to turn thinking off on this model; unrestricted thinking can exhaust max_tokens before any JSON is emitted.
					thinking: { type: 'between_tools' },
					// Later blocks keep a leading newline so earlier blocks stay byte-identical for the cache prefix.
					...(automaticCache ? { cache_control: { type: 'ephemeral' } } : {}),
					messages: [
						{
							role: 'user',
							content: blocks
								? blocks.map((text, index) => ({
										type: 'text',
										text: index === 0 ? text : `\n${text}`,
										...(request.promptCacheBreakpoint === index
											? { cache_control: { type: 'ephemeral' } }
											: {}),
									}))
								: request.prompt,
						},
					],
					output_config: {
						format: {
							type: 'json_schema',
							schema: relaxNullableRequiredProperties(
								pruneUnusedToolParameters(request.structuredOutputSchema),
							),
						},
					},
				}),
			});
		} catch {
			return validateAdapterResult({
				status: 'failed',
				outcome: request.signal.aborted
					? (request.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
						? 'timeout'
						: 'cancelled'
					: 'transport',
			});
		}
		const providerRequestId = response.headers?.get?.('request-id') ?? undefined;
		if (!response.ok) {
			const errorBody = await response.text().catch(() => '');
			const outcome = outcomeForStatus(response.status, errorBody);
			const retryAfterMs = parseRetryAfterMs(response, outcome);
			return validateAdapterResult({
				status: 'failed',
				outcome,
				providerRequestId,
				executionProvenFalse: true,
				...(errorBody
					? { diagnostic: { stage: 'provider-error-response', content: errorBody } }
					: {}),
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			});
		}
		let body: {
			content?: Array<{ type?: string; text?: string }>;
			stop_reason?: string;
			usage?: Record<string, unknown>;
		};
		let rawBody = '';
		try {
			rawBody = await response.text();
			body = JSON.parse(rawBody) as typeof body;
		} catch {
			if (request.signal.aborted) {
				return validateAdapterResult({
					status: 'failed',
					outcome:
						(request.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
							? 'timeout'
							: 'cancelled',
					providerRequestId,
				});
			}
			return validateAdapterResult({
				status: 'failed',
				outcome: 'malformed_output',
				providerRequestId,
				diagnostic: { stage: 'provider-body-json', content: rawBody },
			});
		}
		const text = Array.isArray(body?.content)
			? body.content.find((block) => block?.type === 'text' && typeof block.text === 'string')
					?.text
			: undefined;
		let output: unknown;
		try {
			output = parseModelJson(text);
		} catch {
			return validateAdapterResult({
				status: 'failed',
				outcome: 'malformed_output',
				providerRequestId,
				diagnostic: {
					stage: 'model-content-json',
					content: fallbackDiagnosticContent(text, body),
					...(body?.stop_reason === 'max_tokens' ? { truncated: true } : {}),
				},
			});
		}
		const rawUsage = body?.usage;
		const inputTokens = rawUsage?.input_tokens;
		const outputTokens = rawUsage?.output_tokens;
		const cacheReadTokens = cacheTokenCount(rawUsage, 'cache_read_input_tokens');
		const cacheWriteTokens = cacheTokenCount(rawUsage, 'cache_creation_input_tokens');
		// input_tokens is only the uncached tail. Cache reads and writes are the rest of the prompt.
		const usage =
			typeof inputTokens === 'number' &&
			Number.isSafeInteger(inputTokens) &&
			inputTokens >= 0 &&
			typeof outputTokens === 'number' &&
			Number.isSafeInteger(outputTokens) &&
			outputTokens >= 0 &&
			cacheReadTokens !== undefined &&
			cacheWriteTokens !== undefined
				? {
						promptTokens: inputTokens,
						completionTokens: outputTokens,
						source: 'provider' as const,
						...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
						...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
						tokenDetails: {
							cacheReadTokens: observedCount(rawUsage?.cache_read_input_tokens),
							cacheWriteTokens: observedCount(rawUsage?.cache_creation_input_tokens),
							reasoningTokens: null,
						},
					}
				: undefined;
		return validateAdapterResult({ status: 'succeeded', output, usage, providerRequestId });
	}
}
