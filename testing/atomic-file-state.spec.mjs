import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
	acquireLockSync,
	durableReplaceSync,
	releaseLockSync,
	withLockSync,
} from '../atomic-file-state.ts';

const testRoot = path.join(os.tmpdir(), 'model-usage-test-atomic-file-state');

function freshDirectory(name) {
	const directory = path.join(testRoot, name);
	fs.rmSync(directory, { recursive: true, force: true });
	fs.mkdirSync(directory, { recursive: true });
	return directory;
}

function remainingTemporaryFiles(directory) {
	return fs.readdirSync(directory).filter((name) => name.includes('.tmp.'));
}

function injectedFs(overrides) {
	return Object.assign(Object.create(fs), overrides);
}

describe('atomic-file-state locks', () => {
	it('replacement-token safety preserves a replacement owner lock', () => {
		const directory = freshDirectory('replacement-token');
		const lockFile = path.join(directory, 'state.lock');
		try {
			const oldToken = acquireLockSync(lockFile);
			fs.writeFileSync(
				lockFile,
				JSON.stringify({
					pid: process.pid,
					createdAt: Date.now(),
					token: 'replacement-token',
				}),
			);

			assert.equal(releaseLockSync(lockFile, oldToken), false);
			assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'replacement-token');
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('malformed and corrupt lock diagnostics fail closed and preserve the lock', () => {
		const directory = freshDirectory('corrupt-lock');
		const lockFile = path.join(directory, 'state.lock');
		try {
			fs.writeFileSync(lockFile, '{broken');
			assert.throws(
				() => acquireLockSync(lockFile, { timeoutMs: 20, pollIntervalMs: 5 }),
				(error) => {
					assert.match(error.message, /malformed\/corrupt/);
					assert.match(error.message, /manually remove/);
					return true;
				},
			);
			assert.equal(fs.readFileSync(lockFile, 'utf8'), '{broken');
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('explicit cleanup permits acquisition after a corrupt lock failure', () => {
		const directory = freshDirectory('explicit-cleanup');
		const lockFile = path.join(directory, 'state.lock');
		try {
			fs.writeFileSync(lockFile, JSON.stringify({ pid: 'not-a-pid' }));
			assert.throws(
				() => acquireLockSync(lockFile, { timeoutMs: 10, pollIntervalMs: 2 }),
				/malformed\/corrupt/,
			);
			assert.equal(fs.existsSync(lockFile), true);

			fs.unlinkSync(lockFile);
			const token = acquireLockSync(lockFile, { timeoutMs: 20 });
			assert.ok(token);
			assert.equal(releaseLockSync(lockFile, token), true);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('bounded timeout reports a dead owner without deleting its lock', () => {
		const directory = freshDirectory('bounded-timeout');
		const lockFile = path.join(directory, 'state.lock');
		try {
			fs.writeFileSync(
				lockFile,
				JSON.stringify({ pid: 9999999, createdAt: Date.now() - 1000, token: 'foreign' }),
			);
			const startedAt = Date.now();
			assert.throws(
				() => acquireLockSync(lockFile, { timeoutMs: 30, pollIntervalMs: 5 }),
				/\[dead\]/,
			);
			assert.ok(Date.now() - startedAt < 250, 'acquisition should respect its bounded timeout');
			assert.equal(fs.existsSync(lockFile), true);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('finally-path release removes the owned lock when the callback throws', () => {
		const directory = freshDirectory('finally-release');
		const lockFile = path.join(directory, 'state.lock');
		try {
			assert.throws(
				() =>
					withLockSync(lockFile, () => {
						throw new Error('callback failed');
					}),
				/callback failed/,
			);
			assert.equal(fs.existsSync(lockFile), false);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe('durableReplaceSync', () => {
	it('writes, synchronizes, renames, synchronizes the directory, and honors owner-only mode', () => {
		const directory = freshDirectory('durable-success');
		const targetFile = path.join(directory, 'state.json');
		try {
			durableReplaceSync(targetFile, '{"ok":true}\n', { mode: 0o600 });
			assert.equal(fs.readFileSync(targetFile, 'utf8'), '{"ok":true}\n');
			assert.equal(fs.statSync(targetFile).mode & 0o777, 0o600);
			assert.deepEqual(remainingTemporaryFiles(directory), []);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	for (const failure of [
		{
			name: 'write failure',
			override: {
				writeFileSync() {
					throw new Error('injected write failure');
				},
			},
		},
		{
			name: 'file-sync failure',
			override: {
				fsyncSync() {
					throw new Error('injected file-sync failure');
				},
			},
		},
		{
			name: 'rename failure',
			override: {
				renameSync() {
					throw new Error('injected rename failure');
				},
			},
		},
	]) {
		it(`${failure.name} returns no success and cleans the temporary file`, () => {
			const directory = freshDirectory(failure.name.replaceAll(' ', '-'));
			const targetFile = path.join(directory, 'state.json');
			try {
				assert.throws(
					() =>
						durableReplaceSync(targetFile, 'content', {
							dependencies: { fs: injectedFs(failure.override) },
						}),
					new RegExp(`injected ${failure.name}`),
				);
				assert.deepEqual(remainingTemporaryFiles(directory), []);
				assert.equal(fs.existsSync(targetFile), false);
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		});
	}

	it('directory-sync failure returns no success after rename and leaves no temporary file', () => {
		const directory = freshDirectory('directory-sync-failure');
		const targetFile = path.join(directory, 'state.json');
		let syncCalls = 0;
		const fileSystem = injectedFs({
			fsyncSync(descriptor) {
				syncCalls += 1;
				if (syncCalls === 2) throw new Error('injected directory-sync failure');
				return fs.fsyncSync(descriptor);
			},
		});
		try {
			assert.throws(
				() =>
					durableReplaceSync(targetFile, 'renamed-content', {
						dependencies: { fs: fileSystem },
					}),
				/injected directory-sync failure/,
			);
			assert.equal(fs.readFileSync(targetFile, 'utf8'), 'renamed-content');
			assert.deepEqual(remainingTemporaryFiles(directory), []);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('process termination during replacement leaves one complete target envelope', async () => {
		const directory = freshDirectory('process-termination');
		const targetFile = path.join(directory, 'state.json');
		fs.writeFileSync(targetFile, '{"state":"old"}\n');
		try {
			const child = spawn(process.execPath, [
				path.join(import.meta.dirname, 'atomic-file-state-child.mjs'),
				targetFile,
			]);
			const result = await new Promise((resolve, reject) => {
				child.once('error', reject);
				child.once('close', (code, signal) => resolve({ code, signal }));
			});
			assert.equal(result.signal, 'SIGKILL');
			const envelope = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
			assert.ok(['old', 'new'].includes(envelope.state));
			assert.deepEqual(Object.keys(envelope), ['state']);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
