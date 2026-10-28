/**
 * Shared governor spec fixtures. Excluded from the navigability ceiling.
 */
import fs from 'node:fs';
import path from 'node:path';
import { executeOperation } from '../governor/governor.ts';
import { FakeModelAdapter } from '../adapters/fake.ts';
import { baseRequest, enabledFakePolicy, makeTestRoot, writePolicy } from './test-support.mjs';

export function setup(label, { policy = enabledFakePolicy(), request = baseRequest(), adapters } = {}) {
	const root = makeTestRoot(label);
	const stateRoot = path.join(root, 'state');
	const policyPath = writePolicy(root, policy);
	return {
		root,
		stateRoot,
		policyPath,
		request,
		adapters:
			adapters ??
			new Map([
				[
					'fake-governed',
					new FakeModelAdapter('fake-governed', [
						{
							status: 'succeeded',
							output: { ok: true },
							usage: { promptTokens: 2, completionTokens: 1, source: 'provider' },
						},
					]),
				],
			]),
	};
}

export async function run(context, request = context.request, extra = {}) {
	return executeOperation(request, {
		policyPath: context.policyPath,
		stateRoot: context.stateRoot,
		adapters: context.adapters,
		localPolicyPath: null,
		...extra,
	});
}

export function reservationCount(stateRoot, runId) {
	const file = path.join(stateRoot, 'runs', `${runId}.json`);
	if (!fs.existsSync(file)) return 0;
	return JSON.parse(fs.readFileSync(file, 'utf8')).reservations.length;
}

export function governOptions(context) {
	return {
		policyPath: context.policyPath,
		stateRoot: context.stateRoot,
		adapters: context.adapters,
		localPolicyPath: null,
	};
}
