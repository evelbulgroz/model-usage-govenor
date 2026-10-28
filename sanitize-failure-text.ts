import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared sanitization helpers for CI failure packets / PR repair comments.
 * Used by post-pr-failure-comment.mjs; unit-tested without GitHub API.
 *
 * Fail-closed: only allowlisted error-like lines are extracted; no trailing-log
 * fallback. Credential-bearing URLs and secret-like tokens are redacted.
 */

export const DEFAULT_MAX_SNIPPET_CHARS = 200;
export const DEFAULT_MAX_SNIPPETS = 12;

export interface ExtractSnippetsOptions {
	maxSnippets?: number;
	maxSnippetChars?: number;
}

const SECRET_PATTERNS: readonly RegExp[] = [
	/gh[pousr]_[A-Za-z0-9]{20,}/g,
	/github_pat_[A-Za-z0-9_]{20,}/g,
	/npm_[A-Za-z0-9]{20,}/g,
	/(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
	/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
	/\b(?:sk|rk|pk)-(?:live|prod|test)?-?[A-Za-z0-9_-]{16,}\b/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/["']?(?:password|passwd|secret|token|access[_-]?token|auth[_-]?token|api[_-]?key|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key)["']?\s*[=:]\s*["']?[^\s"',}\]]{8,}/gi,
	/\bBearer\s+(?!(?:authentication|authorization|token|scheme)\b)[A-Za-z0-9._~+/=-]{8,}/gi,
	/\bAuthorization\s*[:=]\s*(?:Bearer|Basic|token)?\s*(?!(?:authentication|authorization|token|scheme)\b)[A-Za-z0-9._~+/=-]{8,}/gi,
	// Credential-bearing URLs: scheme://user:pass@host…
	/\b[a-z][a-z0-9+.-]*:\/\/[^/\s'"]+:[^/\s'"]+@[^/\s'"]+/gi,
	// DB/broker schemes often embed credentials in the authority or query string
	/\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s'"]+/gi,
];

export function containsSensitiveCredential(text: unknown): boolean {
	const value = String(text ?? '');
	for (const pattern of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		if (pattern.test(value)) return true;
	}
	return false;
}

/** Lines that look like credentials even after generic redaction — drop entirely. */
const UNSAFE_LINE =
	/(password|passwd|secret|api[_-]?key|private[_-]?key|BEGIN [A-Z ]*PRIVATE|ghp_|github_pat_|npm_)/i;

const ALLOWLIST_LINE =
	/\b(Error|error|FAIL|failed|ELIFECYCLE|AssertionError|ERR_|✖|×|not ok|TypeError|ReferenceError|Expected|Received|expected|received|TS\d{3,5})\b/;

/**
 * Quality-gate findings (eslint/jscpd/semgrep/dependency-cruiser/etc.) are
 * printed by quality-gate runners' printFailures() as
 * '  [tool] ruleId location — message (fingerprint)' and never contain the
 * generic Error/FAIL/AssertionError vocabulary above, so ALLOWLIST_LINE alone
 * silently drops every quality-gate failure detail, leaving only the
 * top-level 'RESULT status=FAIL' summary for repair.
 */
const QUALITY_FINDING_LINE = /^\[[a-z0-9][a-z0-9_-]*\]\s+\S+/i;
const QUALITY_FINDINGS_HEADER_LINE = /failures:\s*$/i;

export function sanitize(text: unknown): string {
	let s = String(text ?? '');
	for (const re of SECRET_PATTERNS) {
		// Reset lastIndex for global patterns reused across calls
		re.lastIndex = 0;
		s = s.replace(re, '[REDACTED]');
	}
	s = s.replace(/\u001b\[[0-9;]*m/g, '');
	return s;
}

export function fence(text: unknown, maxChars: number = DEFAULT_MAX_SNIPPET_CHARS): string {
	const safe = sanitize(text).replace(/```/g, "'''");
	const body = safe.slice(0, maxChars) + (safe.length > maxChars ? '…' : '');
	return '```\n' + body + '\n```';
}

/**
 * Extract allowlisted error-like lines only.
 * Does **not** fall back to arbitrary trailing log lines (credential leak risk).
 * Drops lines that remain unsafe after sanitization.
 */
export function extractSnippets(
	logText: unknown,
	options: ExtractSnippetsOptions = {},
): string[] {
	const maxSnippets = options.maxSnippets ?? DEFAULT_MAX_SNIPPETS;
	const maxChars = options.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS;
	const lines = sanitize(logText).split(/\r?\n/);
	const interesting: string[] = [];

	for (const line of lines) {
		const t = line.trim();
		if (!t || t.length < 8) continue;
		if (UNSAFE_LINE.test(t) && !t.includes('[REDACTED]')) {
			// Still looks credential-like without redaction token — skip
			continue;
		}
		// Drop lines that are only redaction noise or pure URLs
		if (/^\[REDACTED\]+$/i.test(t)) continue;
		if (
			!ALLOWLIST_LINE.test(t) &&
			!/FAIL\s+\S+\.spec\./.test(t) &&
			!QUALITY_FINDING_LINE.test(t) &&
			!QUALITY_FINDINGS_HEADER_LINE.test(t)
		) {
			continue;
		}

		// If allowlisted but still contains unredacted userinfo URL, skip
		if (/:\/\/[^/\s]+:[^/\s]+@/.test(t)) continue;

		interesting.push(t.slice(0, maxChars));
	}

	// Fail closed: sample only allowlisted lines and never fall back to arbitrary trailing output.
	if (interesting.length <= maxSnippets) return interesting;
	const headCount = Math.ceil(maxSnippets / 2);
	const tailCount = maxSnippets - headCount;
	return [...interesting.slice(0, headCount), ...interesting.slice(-tailCount)];
}

export function truncateBody(body: unknown, maxChars: number = 8000): string {
	const s = String(body ?? '');
	if (s.length <= maxChars) return s;
	return s.slice(0, Math.max(0, maxChars - 20)) + '\n\n…[truncated]';
}

function isDirectExecution(): boolean {
	if (!process.argv[1]) return false;
	const resolvedArg = path.resolve(process.argv[1]);
	if (resolvedArg === fileURLToPath(import.meta.url)) return true;
	const base = path.basename(resolvedArg);
	return base === 'sanitize-failure-text.mjs' || base === 'sanitize-failure-text.ts';
}

// CLI entrypoint if executed directly
if (isDirectExecution()) {
	async function runCli(): Promise<void> {
		const args = process.argv.slice(2);
		let filePath: string | null = null;
		let maxSnippets = 20; // Default <= 20 lines for CLI
		let maxChars = DEFAULT_MAX_SNIPPET_CHARS;
		let useFence = false;

		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === '--file' || arg === '-f') {
				filePath = args[++i] ?? null;
			} else if (arg === '--max-lines' || arg === '--max-snippets') {
				maxSnippets = parseInt(args[++i] ?? '', 10) || 20;
			} else if (arg === '--max-chars') {
				maxChars = parseInt(args[++i] ?? '', 10) || DEFAULT_MAX_SNIPPET_CHARS;
			} else if (arg === '--fence') {
				useFence = true;
			} else if (arg === '--help' || arg === '-h') {
				console.log('Usage: node sanitize-failure-text.ts [--file <path>] [--max-lines <n>] [--max-chars <n>] [--fence]');
				console.log('Reads from --file <path> or stdin if omitted/dash.');
				process.exit(0);
			} else if (arg && !arg.startsWith('-') && !filePath) {
				filePath = arg;
			}
		}

		let input = '';
		if (filePath && filePath !== '-') {
			if (!fs.existsSync(filePath)) {
				console.error(`Error: File not found: ${filePath}`);
				process.exit(1);
			}
			input = fs.readFileSync(filePath, 'utf8');
		} else {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			}
			input = Buffer.concat(chunks).toString('utf8');
		}

		const snippets = extractSnippets(input, {
			maxSnippets: Math.min(maxSnippets, 20),
			maxSnippetChars: maxChars,
		});

		if (snippets.length === 0) {
			console.log('status: CLEAN (no allowlisted error-like patterns found)');
			process.exit(0);
		}

		if (useFence) {
			console.log('```');
			for (const snip of snippets) {
				console.log(snip);
			}
			console.log('```');
		} else {
			for (const snip of snippets) {
				console.log(snip);
			}
		}
	}

	runCli().catch((err) => {
		console.error('Error running sanitize-failure-text CLI:', err);
		process.exit(1);
	});
}
