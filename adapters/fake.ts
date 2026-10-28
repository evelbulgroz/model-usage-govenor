import {
	type AdapterRequest,
	type AdapterResult,
	type ModelAdapter,
	validateAdapterRequest,
	validateAdapterResult,
} from './adapter-contract.ts';

export interface FakeAdapterScriptStep {
	status?: 'succeeded' | 'failed';
	outcome?: string;
	output?: unknown;
	usage?: unknown;
	providerRequestId?: string;
	providerModelVersion?: string;
	executionProvenFalse?: boolean;
	diagnostic?: unknown;
	retryAfterMs?: number;
	throw?: unknown;
	delayMs?: number;
	onCall?: (request: AdapterRequest) => void | Promise<void>;
	result?: unknown;
}

export class FakeModelAdapter implements ModelAdapter {
	readonly routeId: string;
	readonly script: FakeAdapterScriptStep[];
	callCount: number;
	readonly requests: Array<{
		operationId: string;
		attemptId: string;
		maxCompletionTokens: number;
	}>;

	constructor(routeId = 'fake-governed', script: readonly FakeAdapterScriptStep[] = []) {
		this.routeId = routeId;
		this.script = [...script];
		this.callCount = 0;
		this.requests = [];
	}

	async execute(request: AdapterRequest): Promise<AdapterResult> {
		validateAdapterRequest(request);
		this.callCount += 1;
		this.requests.push({
			operationId: request.operationId,
			attemptId: request.attemptId,
			maxCompletionTokens: request.maxCompletionTokens,
		});
		const step: FakeAdapterScriptStep = this.script.shift() ?? {
			status: 'succeeded',
			output: {},
			usage: { promptTokens: 1, completionTokens: 1, source: 'provider' },
		};
		if (step.throw) throw step.throw;
		if (step.delayMs) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, step.delayMs);
				request.signal.addEventListener(
					'abort',
					() => {
						clearTimeout(timer);
						reject(request.signal.reason ?? new DOMException('Aborted', 'AbortError'));
					},
					{ once: true },
				);
			});
		}
		if (step.onCall) await step.onCall(request);
		return validateAdapterResult(step.result ?? step);
	}
}
