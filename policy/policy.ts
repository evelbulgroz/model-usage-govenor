/**
 * Public policy facade. Retry, failover, and accounting stay in the governor.
 * Submodules are internal. This file re-exports the frozen name list only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePolicy } from './policy-local-merge.ts';
import type { ModelUsagePolicy } from './policy-validation.ts';

export { BUILTIN_SAFETY, validatePolicy, type ModelUsagePolicy } from './policy-validation.ts';
export {
	canonicalJson,
	effectiveProfile,
	normalizePrompt,
	normalizedOperationInput,
	operationInputHash,
	validateOperationId,
	validateOperationRequest,
	validateRunId,
	type EffectiveProfile,
	type NormalizedOperationRequest,
	type OperationAttribution,
	type OperationRequest,
	type ProfileLimits,
	type RequestedLimits,
	type RoutingConstraints,
	type RoutingStrategy,
} from './operation-request.ts';
export { resolvePolicy };

const DEFAULT_BUNDLED_POLICY_PATH = path.join(import.meta.dirname, 'default-policy.json');

function resolveHostRepoRoot(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	const explicitModelRepo = env.MODEL_USAGE_REPO_ROOT?.trim();
	if (explicitModelRepo) return path.resolve(explicitModelRepo);
	const explicitSdlcRepo = env.AGENT_SDLC_REPO_ROOT?.trim();
	if (explicitSdlcRepo) return path.resolve(explicitSdlcRepo);

	const resolvedCwd = path.resolve(cwd);
	const nodeModulesSegment = `${path.sep}node_modules`;
	const nmIndex = resolvedCwd.indexOf(nodeModulesSegment);
	const startDir =
		nmIndex >= 0 ? path.resolve(resolvedCwd.slice(0, nmIndex) || path.sep) : resolvedCwd;

	let current = startDir;
	while (true) {
		if (!current.split(path.sep).includes('node_modules')) {
			if (
				fs.existsSync(path.join(current, '.agents/model-usage-policy.json')) ||
				fs.existsSync(path.join(current, '.agents/sdlc-host.json')) ||
				fs.existsSync(path.join(current, '.git'))
			) {
				return current;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return startDir;
}

function resolveDefaultStateRoot(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	const explicitStateDir = env.MODEL_USAGE_STATE_DIR?.trim();
	if (explicitStateDir) return path.resolve(explicitStateDir);
	return path.join(resolveHostRepoRoot(cwd, env), 'tools/.model-usage');
}

export const DEFAULT_LOCAL_POLICY_PATH = path.join(
	resolveDefaultStateRoot(),
	'local-policy.json',
);

function defaultMachineLocalPath(): string {
	const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
	return path.join(configHome, 'model-usage', 'local-policy.json');
}

function defaultRepoLocalPath(): string {
	const cwd = process.cwd();
	const cwdToolsCandidate = path.join(cwd, 'tools/.model-usage/local-policy.json');
	if (fs.existsSync(cwdToolsCandidate)) return cwdToolsCandidate;
	const cwdSdlcCandidate = path.join(cwd, '.agent-sdlc/local-policy.json');
	if (fs.existsSync(cwdSdlcCandidate)) return cwdSdlcCandidate;
	return path.join(resolveDefaultStateRoot(cwd), 'local-policy.json');
}

function loadPolicyImpl({
	policyPath,
	localPolicyPath,
	defaultLocalPolicyPath,
	machineLocalPolicyPath,
	defaultMachineLocalPolicyPath,
}: {
	policyPath?: string;
	localPolicyPath?: string | null;
	defaultLocalPolicyPath?: string;
	machineLocalPolicyPath?: string | null;
	defaultMachineLocalPolicyPath?: string;
} = {}): Readonly<ModelUsagePolicy> {
	const hostPolicyCandidate = path.join(
		resolveHostRepoRoot(),
		'.agents/model-usage-policy.json',
	);
	const committedPath =
		policyPath ??
		(fs.existsSync(hostPolicyCandidate) ? hostPolicyCandidate : DEFAULT_BUNDLED_POLICY_PATH);
	const committed: unknown = JSON.parse(fs.readFileSync(committedPath, 'utf8'));

	let machineLocal: unknown;
	const resolvedDefaultMachinePath =
		defaultMachineLocalPolicyPath ??
		process.env.MODEL_USAGE_MACHINE_LOCAL_POLICY_PATH ??
		defaultMachineLocalPath();
	const resolvedMachinePath =
		machineLocalPolicyPath !== undefined
			? machineLocalPolicyPath
			: localPolicyPath === null
				? null
				: resolvedDefaultMachinePath;
	if (resolvedMachinePath && fs.existsSync(resolvedMachinePath)) {
		machineLocal = JSON.parse(fs.readFileSync(resolvedMachinePath, 'utf8'));
	}

	let local: unknown;
	const resolvedDefaultPath =
		defaultLocalPolicyPath ??
		process.env.MODEL_USAGE_DEFAULT_LOCAL_POLICY_PATH ??
		defaultRepoLocalPath();
	const resolvedLocalPath =
		localPolicyPath === undefined ? resolvedDefaultPath : localPolicyPath;
	if (resolvedLocalPath && fs.existsSync(resolvedLocalPath)) {
		local = JSON.parse(fs.readFileSync(resolvedLocalPath, 'utf8'));
	}

	const afterMachine = resolvePolicy(committed, machineLocal);
	return local === undefined ? afterMachine : resolvePolicy(afterMachine, local);
}

export const loadPolicy = Object.assign(loadPolicyImpl, {
	DEFAULT_BUNDLED_POLICY_PATH,
	resolveHostRepoRoot,
	resolveDefaultStateRoot,
});
