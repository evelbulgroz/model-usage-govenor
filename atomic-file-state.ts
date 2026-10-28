import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AtomicStateDependencies {
	fs?: typeof fs;
	now?: () => number;
	random?: () => number;
	randomUUID?: () => string;
	sleepSync?: (ms: number) => void;
	isProcessAlive?: (pid: number) => boolean;
}

export interface AcquireLockOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
	mode?: number;
	dependencies?: AtomicStateDependencies;
}

export interface ReleaseLockOptions {
	dependencies?: AtomicStateDependencies;
}

export interface DurableReplaceOptions {
	encoding?: BufferEncoding;
	mode?: number;
	dependencies?: AtomicStateDependencies;
}

interface ResolvedAtomicStateDependencies {
	fs: typeof fs;
	now: () => number;
	random: () => number;
	randomUUID: () => string;
	sleepSync: (ms: number) => void;
	isProcessAlive: (pid: number) => boolean;
}

function defaultSleepSync(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const end = Date.now() + ms;
		while (Date.now() < end) {}
	}
}

function dependencies(overrides: AtomicStateDependencies = {}): ResolvedAtomicStateDependencies {
	return {
		fs: overrides.fs ?? fs,
		now: overrides.now ?? Date.now,
		random: overrides.random ?? Math.random,
		randomUUID: overrides.randomUUID ?? crypto.randomUUID,
		sleepSync: overrides.sleepSync ?? defaultSleepSync,
		isProcessAlive: overrides.isProcessAlive ?? isProcessAlive,
	};
}

/**
 * Check whether a process is currently addressable by PID.
 */
export function isProcessAlive(
	pid: number,
	{ kill = process.kill.bind(process) }: { kill?: typeof process.kill } = {},
): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
	}
}

function cleanupCreatedLock(
	lockFile: string,
	fileSystem: typeof fs,
	createdStat: fs.Stats,
): void {
	try {
		const currentStat = fileSystem.lstatSync(lockFile);
		if (
			currentStat.dev === createdStat.dev &&
			currentStat.ino === createdStat.ino
		) {
			fileSystem.unlinkSync(lockFile);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
	}
}

function describeExistingLock(
	lockFile: string,
	deps: ResolvedAtomicStateDependencies,
): string {
	const cleanup = `Inspect the lock and, only after confirming no owner is active, manually remove '${lockFile}'`;
	try {
		const content = deps.fs.readFileSync(lockFile, 'utf8');
		let parsed: Record<string, unknown> | null;
		try {
			parsed = JSON.parse(content) as Record<string, unknown> | null;
		} catch (error) {
			return `lock contents are malformed/corrupt (${(error as Error).message}). ${cleanup}`;
		}

		if (
			!parsed ||
			typeof parsed !== 'object' ||
			typeof parsed.pid !== 'number' ||
			!Number.isInteger(parsed.pid) ||
			parsed.pid <= 0 ||
			typeof parsed.createdAt !== 'number' ||
			!Number.isFinite(parsed.createdAt) ||
			typeof parsed.token !== 'string' ||
			parsed.token.length === 0
		) {
			return `lock contents are malformed/corrupt. ${cleanup}`;
		}

		const alive = deps.isProcessAlive(parsed.pid);
		const ageSeconds = Math.max(0, (deps.now() - parsed.createdAt) / 1000).toFixed(1);
		return `lock held by PID ${parsed.pid} [${alive ? 'alive' : 'dead'}], age=${ageSeconds}s. ${cleanup}`;
	} catch (error) {
		return `lock could not be inspected (${(error as Error).message}). ${cleanup}`;
	}
}

/**
 * Acquire an exclusive-create lock within a bounded time.
 *
 * Foreign, dead, and malformed locks are never removed automatically.
 */
export function acquireLockSync(
	lockFile: string,
	{
		timeoutMs = 10000,
		pollIntervalMs = 25,
		mode = 0o600,
		dependencies: dependencyOverrides,
	}: AcquireLockOptions = {},
): string {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new TypeError('timeoutMs must be a non-negative finite number');
	}
	if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
		throw new TypeError('pollIntervalMs must be a non-negative finite number');
	}

	const deps = dependencies(dependencyOverrides);
	const startedAt = deps.now();
	let firstAttempt = true;

	while (firstAttempt || deps.now() - startedAt < timeoutMs) {
		firstAttempt = false;
		const token = deps.randomUUID();
		let descriptor: number | undefined;
		let createdStat: fs.Stats | undefined;
		try {
			descriptor = deps.fs.openSync(lockFile, 'wx', mode);
			createdStat = deps.fs.fstatSync(descriptor);
			deps.fs.writeFileSync(
				descriptor,
				JSON.stringify({ pid: process.pid, createdAt: deps.now(), token }),
				'utf8',
			);
			deps.fs.closeSync(descriptor);
			descriptor = undefined;
			return token;
		} catch (error) {
			if (descriptor !== undefined) {
				try {
					deps.fs.closeSync(descriptor);
				} catch {}
				if (createdStat) cleanupCreatedLock(lockFile, deps.fs, createdStat);
			}
			if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error;

			const elapsed = deps.now() - startedAt;
			if (elapsed >= timeoutMs) break;
			const jitter = Math.floor(deps.random() * 15);
			deps.sleepSync(Math.min(pollIntervalMs + jitter, timeoutMs - elapsed));
		}
	}

	const diagnostic = describeExistingLock(lockFile, deps);
	throw new Error(
		`Timed out waiting to acquire lock on '${lockFile}' after ${timeoutMs}ms (${diagnostic})`,
	);
}

/**
 * Release a lock only when its token and file identity still match the owner.
 */
export function releaseLockSync(
	lockFile: string,
	lockToken: string,
	{ dependencies: dependencyOverrides }: ReleaseLockOptions = {},
): boolean {
	if (!lockToken) return false;
	const deps = dependencies(dependencyOverrides);
	let descriptor: number | undefined;
	try {
		descriptor = deps.fs.openSync(lockFile, 'r');
		const openedStat = deps.fs.fstatSync(descriptor);
		const content = deps.fs.readFileSync(descriptor, 'utf8');
		let parsed: Record<string, unknown> | null;
		try {
			parsed = JSON.parse(content) as Record<string, unknown> | null;
		} catch {
			return false;
		}
		if (parsed?.token !== lockToken) return false;

		const currentStat = deps.fs.lstatSync(lockFile);
		if (
			currentStat.dev !== openedStat.dev ||
			currentStat.ino !== openedStat.ino
		) {
			return false;
		}
		deps.fs.unlinkSync(lockFile);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
		throw error;
	} finally {
		if (descriptor !== undefined) {
			try {
				deps.fs.closeSync(descriptor);
			} catch {}
		}
	}
}

/**
 * Run a synchronous callback under an exclusive lock and always release it.
 */
export function withLockSync<T>(
	lockFile: string,
	fn: (token: string) => T,
	options: AcquireLockOptions = {},
): T {
	const token = acquireLockSync(lockFile, options);
	try {
		return fn(token);
	} finally {
		releaseLockSync(lockFile, token, options);
	}
}

function cleanupTempFile(tempFile: string, fileSystem: typeof fs): void {
	try {
		fileSystem.unlinkSync(tempFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
	}
}

/**
 * Durably replace a file using a same-directory temporary file.
 *
 * Success is returned only after the temporary file and parent directory have
 * both been synchronized.
 */
export function durableReplaceSync(
	targetFile: string,
	data: string | NodeJS.ArrayBufferView,
	{
		encoding = 'utf8',
		mode,
		dependencies: dependencyOverrides,
	}: DurableReplaceOptions = {},
): void {
	const deps = dependencies(dependencyOverrides);
	const directory = path.dirname(targetFile);
	const temporaryFile = path.join(
		directory,
		`.${path.basename(targetFile)}.tmp.${process.pid}.${deps.randomUUID()}`,
	);
	let fileDescriptor: number | undefined;
	let directoryDescriptor: number | undefined;
	let renamed = false;

	try {
		fileDescriptor = deps.fs.openSync(
			temporaryFile,
			'wx',
			mode === undefined ? 0o666 : mode,
		);
		deps.fs.writeFileSync(fileDescriptor, data, encoding);
		deps.fs.fsyncSync(fileDescriptor);
		deps.fs.closeSync(fileDescriptor);
		fileDescriptor = undefined;

		deps.fs.renameSync(temporaryFile, targetFile);
		renamed = true;

		directoryDescriptor = deps.fs.openSync(directory, deps.fs.constants.O_RDONLY);
		deps.fs.fsyncSync(directoryDescriptor);
		deps.fs.closeSync(directoryDescriptor);
		directoryDescriptor = undefined;
	} catch (error) {
		if (fileDescriptor !== undefined) {
			try {
				deps.fs.closeSync(fileDescriptor);
			} catch {}
		}
		if (directoryDescriptor !== undefined) {
			try {
				deps.fs.closeSync(directoryDescriptor);
			} catch {}
		}
		if (!renamed) cleanupTempFile(temporaryFile, deps.fs);
		throw error;
	}
}
