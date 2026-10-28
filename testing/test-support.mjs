import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const hostCommittedPolicyPath = path.join(repositoryRoot, '.agents/model-usage-policy.json');
const bundledPolicyPath = path.join(import.meta.dirname, '../policy/default-policy.json');
export const committedPolicyPath = fs.existsSync(hostCommittedPolicyPath)
	? hostCommittedPolicyPath
	: bundledPolicyPath;

export function readCommittedPolicy() {
	return JSON.parse(fs.readFileSync(committedPolicyPath, 'utf8'));
}

export function enabledFakePolicy() {
	const policy = readCommittedPolicy();
	for (const route of policy.routes) {
		route.enabled = route.id === 'fake-governed';
	}
	return policy;
}

export function makeTestRoot(label) {
	const root = path.join(import.meta.dirname, '../.test-state', `${label}-${crypto.randomUUID()}`);
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	return root;
}

export function cleanupTestRoot(root) {
	fs.rmSync(root, { recursive: true, force: true });
}

export function writePolicy(root, policy) {
	const file = path.join(root, 'policy.json');
	fs.writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
	return file;
}

export function baseRequest(overrides = {}) {
	return {
		schemaVersion: '1.0.0',
		operationId: `operation-${crypto.randomUUID()}`,
		runId: `run-${crypto.randomUUID()}`,
		consumer: 'agent-sdlc',
		profile: 'agent-sdlc-default',
		attribution: { taskId: 'task', nodeId: 'node', generation: 1, nodeAttempt: 1 },
		prompt: 'Return a small JSON object.',
		structuredOutputSchema: {
			type: 'object',
			required: ['ok'],
			properties: { ok: { type: 'boolean' } },
			additionalProperties: false,
		},
		routingConstraints: { requiredCapabilities: ['structured-output'] },
		requestedLimits: { maxCompletionTokens: 32 },
		...overrides,
	};
}

export function addSecondFakeRoute(policy) {
	const second = structuredClone(policy.routes.find((route) => route.id === 'fake-governed'));
	second.id = 'fake-secondary';
	second.model = 'deterministic-json-secondary';
	policy.routes.splice(1, 0, second);
	policy.profiles['agent-sdlc-default'].routeIds.splice(1, 0, second.id);
	return policy;
}

export function addThirdFakeRoute(policy) {
	const third = structuredClone(policy.routes.find((route) => route.id === 'fake-governed'));
	third.id = 'fake-tertiary';
	third.model = 'deterministic-json-tertiary';
	policy.routes.push(third);
	policy.profiles['agent-sdlc-default'].routeIds.push(third.id);
	return policy;
}
