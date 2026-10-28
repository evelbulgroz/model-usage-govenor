import fs from 'node:fs';
import path from 'node:path';
import { durableReplaceSync } from '../atomic-file-state.ts';
import { sanitize, truncateBody } from '../sanitize-failure-text.ts';

export const MALFORMED_OUTPUT_DIAGNOSTIC_MAX_CHARS = 32_768;
export const MALFORMED_OUTPUT_DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface MalformedOutputDiagnosticInput {
	stage: string;
	content: string;
	truncated?: boolean;
}

function safeSegment(value: unknown): string {
	return encodeURIComponent(String(value));
}

export function pruneExpiredMalformedOutputDiagnostics(
	stateRoot: string,
	now: Date = new Date(),
): string[] {
	const diagnosticsRoot = path.join(path.resolve(stateRoot), 'diagnostics');
	if (!fs.existsSync(diagnosticsRoot)) return [];
	const cutoff = now.getTime() - MALFORMED_OUTPUT_DIAGNOSTIC_RETENTION_MS;
	const removed: string[] = [];

	for (const runEntry of fs.readdirSync(diagnosticsRoot, { withFileTypes: true })) {
		if (!runEntry.isDirectory()) continue;
		const runRoot = path.join(diagnosticsRoot, runEntry.name);
		for (const entry of fs.readdirSync(runRoot, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
			const file = path.join(runRoot, entry.name);
			if (fs.statSync(file).mtimeMs >= cutoff) continue;
			fs.unlinkSync(file);
			removed.push(file);
		}
		if (fs.readdirSync(runRoot).length === 0) fs.rmdirSync(runRoot);
	}

	return removed;
}

export function writeMalformedOutputDiagnostic({
	stateRoot,
	runId,
	operationId,
	attemptId,
	route,
	providerRequestId,
	diagnostic,
	now = new Date(),
}: {
	stateRoot: string;
	runId: string;
	operationId: string;
	attemptId: string;
	route: { id: string; provider: string; model: string };
	providerRequestId?: string;
	diagnostic?: MalformedOutputDiagnosticInput;
	now?: Date;
}): string | undefined {
	if (!diagnostic) return undefined;
	const root = path.resolve(stateRoot);
	pruneExpiredMalformedOutputDiagnostics(root, now);
	const runRoot = path.join(root, 'diagnostics', safeSegment(runId));
	fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
	fs.chmodSync(runRoot, 0o700);

	const sanitized = sanitize(diagnostic.content);
	const excerpt = truncateBody(sanitized, MALFORMED_OUTPUT_DIAGNOSTIC_MAX_CHARS);
	const payload = {
		schemaVersion: '1.0.0',
		capturedAt: now.toISOString(),
		expiresAt: new Date(
			now.getTime() + MALFORMED_OUTPUT_DIAGNOSTIC_RETENTION_MS,
		).toISOString(),
		runId,
		operationId,
		attemptId,
		routeId: route.id,
		provider: route.provider,
		model: route.model,
		...(providerRequestId ? { providerRequestId } : {}),
		stage: diagnostic.stage,
		truncated: excerpt.length < sanitized.length,
		...(diagnostic.truncated === true ? { completionTruncated: true } : {}),
		excerpt,
	};
	const file = path.join(runRoot, `${safeSegment(attemptId)}.json`);
	durableReplaceSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
	return path.relative(root, file);
}
