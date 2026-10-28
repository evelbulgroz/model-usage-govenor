import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadPolicy } from '../policy/policy.ts';

const SCRIPT_PARENT = path.resolve(import.meta.dirname, '..');
const PACKAGE_ROOT =
	path.basename(SCRIPT_PARENT) === 'dist'
		? path.resolve(SCRIPT_PARENT, '..')
		: SCRIPT_PARENT;
const HOST_POLICY_CANDIDATE = path.join(
	loadPolicy.resolveHostRepoRoot(),
	'.agents/model-usage-policy.json',
);
const DEFAULT_POLICY_PATH = fs.existsSync(HOST_POLICY_CANDIDATE)
	? HOST_POLICY_CANDIDATE
	: loadPolicy.DEFAULT_BUNDLED_POLICY_PATH;
const DEFAULT_HANDBOOK_PATH = path.join(PACKAGE_ROOT, 'PROVIDER-CAPABILITIES.md');

export interface PricingTableRow {
	routeId: string;
	inputRate: number;
	outputRate: number;
	effectiveDate: string;
	citationUrl: string;
}

export function parseMarkdownPricingTable(markdownContent: string): Map<string, PricingTableRow> {
	const tableRows = new Map<string, PricingTableRow>();
	const lines = markdownContent.split('\n');
	// Match table row: | `route-id` | input | output | date | citation |
	const rowPattern =
		/^\s*\|\s*`?([a-z0-9-]+)`?\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\S+)\s*\|/;

	for (const line of lines) {
		const match = line.match(rowPattern);
		if (match) {
			const [, routeId, inputRateStr, outputRateStr, effectiveDate, citationUrl] = match;
			tableRows.set(routeId, {
				routeId,
				inputRate: Number.parseInt(inputRateStr, 10),
				outputRate: Number.parseInt(outputRateStr, 10),
				effectiveDate,
				citationUrl,
			});
		}
	}
	return tableRows;
}

interface PolicyRoutePricingRecord {
	id: string;
	enabled?: boolean;
	metered?: boolean;
	pricing?: {
		status?: string;
		inputMicrousdPerMillionTokens?: number;
		outputMicrousdPerMillionTokens?: number;
		effectiveDate?: string;
		citationUrl?: string;
		[key: string]: unknown;
	};
}

interface PolicyRecord {
	pricingVersion?: string;
	routes?: PolicyRoutePricingRecord[];
}

export function auditPricing({
	policyPath = DEFAULT_POLICY_PATH,
	handbookPath = DEFAULT_HANDBOOK_PATH,
}: {
	policyPath?: string;
	handbookPath?: string;
} = {}): {
	ok: boolean;
	errors: string[];
	routesChecked: number;
} {
	const errors: string[] = [];
	const policyRaw = fs.readFileSync(policyPath, 'utf8');
	const policy = JSON.parse(policyRaw) as PolicyRecord;

	const handbookRaw = fs.readFileSync(handbookPath, 'utf8');
	const handbookTable = parseMarkdownPricingTable(handbookRaw);

	const enabledMeteredRoutes = (policy.routes ?? []).filter(
		(r) => r.enabled === true && r.metered === true,
	);

	if (enabledMeteredRoutes.length === 0) {
		errors.push('No enabled metered routes found in policy');
	}

	const effectiveDates: string[] = [];

	for (const route of enabledMeteredRoutes) {
		const pricing = route.pricing;
		if (!pricing || pricing.status !== 'known') {
			errors.push(`Route '${route.id}' must have pricing.status = 'known'`);
			continue;
		}

		if (
			typeof pricing.inputMicrousdPerMillionTokens !== 'number' ||
			!Number.isSafeInteger(pricing.inputMicrousdPerMillionTokens) ||
			pricing.inputMicrousdPerMillionTokens < 0
		) {
			errors.push(`Route '${route.id}' invalid inputMicrousdPerMillionTokens`);
		}

		if (
			typeof pricing.outputMicrousdPerMillionTokens !== 'number' ||
			!Number.isSafeInteger(pricing.outputMicrousdPerMillionTokens) ||
			pricing.outputMicrousdPerMillionTokens < 0
		) {
			errors.push(`Route '${route.id}' invalid outputMicrousdPerMillionTokens`);
		}

		if (
			typeof pricing.effectiveDate !== 'string' ||
			!/^\d{4}-\d{2}-\d{2}$/.test(pricing.effectiveDate) ||
			Number.isNaN(Date.parse(pricing.effectiveDate))
		) {
			errors.push(`Route '${route.id}' invalid effectiveDate: '${pricing.effectiveDate}'`);
		} else {
			effectiveDates.push(pricing.effectiveDate);
		}

		if (typeof pricing.citationUrl !== 'string' || !pricing.citationUrl.startsWith('https://')) {
			errors.push(`Route '${route.id}' invalid citationUrl: '${pricing.citationUrl}'`);
		}

		const handbookRow = handbookTable.get(route.id);
		if (!handbookRow) {
			errors.push(`Route '${route.id}' missing in handbook pricing evidence table`);
		} else {
			if (handbookRow.inputRate !== pricing.inputMicrousdPerMillionTokens) {
				errors.push(
					`Route '${route.id}' input rate mismatch: policy=${pricing.inputMicrousdPerMillionTokens}, handbook=${handbookRow.inputRate}`,
				);
			}
			if (handbookRow.outputRate !== pricing.outputMicrousdPerMillionTokens) {
				errors.push(
					`Route '${route.id}' output rate mismatch: policy=${pricing.outputMicrousdPerMillionTokens}, handbook=${handbookRow.outputRate}`,
				);
			}
			if (handbookRow.effectiveDate !== pricing.effectiveDate) {
				errors.push(
					`Route '${route.id}' effectiveDate mismatch: policy=${pricing.effectiveDate}, handbook=${handbookRow.effectiveDate}`,
				);
			}
			if (handbookRow.citationUrl !== pricing.citationUrl) {
				errors.push(
					`Route '${route.id}' citationUrl mismatch: policy=${pricing.citationUrl}, handbook=${handbookRow.citationUrl}`,
				);
			}
		}
	}

	if (effectiveDates.length > 0) {
		const maxDate = effectiveDates.reduce((max, d) => (d > max ? d : max), effectiveDates[0]);
		if (policy.pricingVersion !== maxDate) {
			errors.push(
				`Root pricingVersion '${policy.pricingVersion}' does not match max effectiveDate '${maxDate}'`,
			);
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		routesChecked: enabledMeteredRoutes.length,
	};
}

export function bumpPricing({
	routeId,
	inputRate,
	outputRate,
	effectiveDate,
	citationUrl,
	policyPath = DEFAULT_POLICY_PATH,
	handbookPath = DEFAULT_HANDBOOK_PATH,
	runTokenizerSpec = true,
}: {
	routeId: unknown;
	inputRate: unknown;
	outputRate: unknown;
	effectiveDate: unknown;
	citationUrl: unknown;
	policyPath?: string;
	handbookPath?: string;
	runTokenizerSpec?: boolean;
}): {
	ok: true;
	routeId: string;
	pricingVersion: string | undefined;
} {
	if (!routeId || typeof routeId !== 'string') {
		throw new TypeError('routeId is required');
	}

	const parsedInputRate = Number.parseInt(String(inputRate), 10);
	const parsedOutputRate = Number.parseInt(String(outputRate), 10);

	if (!Number.isSafeInteger(parsedInputRate) || parsedInputRate < 0) {
		throw new TypeError('inputRate must be a non-negative safe integer');
	}
	if (!Number.isSafeInteger(parsedOutputRate) || parsedOutputRate < 0) {
		throw new TypeError('outputRate must be a non-negative safe integer');
	}

	if (
		typeof effectiveDate !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ||
		Number.isNaN(Date.parse(effectiveDate))
	) {
		throw new TypeError('effectiveDate must be a valid ISO YYYY-MM-DD date');
	}

	if (typeof citationUrl !== 'string' || !citationUrl.startsWith('https://')) {
		throw new TypeError('citationUrl must be a valid HTTPS URL');
	}

	const policyRaw = fs.readFileSync(policyPath, 'utf8');
	const policy = JSON.parse(policyRaw) as PolicyRecord;

	const targetRoute = (policy.routes ?? []).find((r) => r.id === routeId);
	if (!targetRoute) {
		throw new Error(`Route '${routeId}' not found in policy`);
	}
	if (!targetRoute.enabled || !targetRoute.metered) {
		throw new Error(`Route '${routeId}' must be enabled and metered`);
	}

	targetRoute.pricing = {
		...targetRoute.pricing,
		status: 'known',
		inputMicrousdPerMillionTokens: parsedInputRate,
		outputMicrousdPerMillionTokens: parsedOutputRate,
		effectiveDate,
		citationUrl,
	};

	const allEffectiveDates = (policy.routes ?? [])
		.map((r) => r.pricing?.effectiveDate)
		.filter((d): d is string => typeof d === 'string');

	if (allEffectiveDates.length > 0) {
		policy.pricingVersion = allEffectiveDates.reduce(
			(max, d) => (d > max ? d : max),
			allEffectiveDates[0],
		);
	}

	fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n', 'utf8');
	if (
		policyPath === HOST_POLICY_CANDIDATE &&
		fs.existsSync(loadPolicy.DEFAULT_BUNDLED_POLICY_PATH)
	) {
		fs.writeFileSync(
			loadPolicy.DEFAULT_BUNDLED_POLICY_PATH,
			JSON.stringify(policy, null, 2) + '\n',
			'utf8',
		);
	}

	const handbookRaw = fs.readFileSync(handbookPath, 'utf8');
	const rowRegex = new RegExp(
		`^\\s*\\|\\s*\`?${routeId}\`?\\s*\\|.*?\\|.*?\\|.*?\\|.*?\\|`,
		'm',
	);
	const newRow = `| \`${routeId}\` | ${parsedInputRate} | ${parsedOutputRate} | ${effectiveDate} | ${citationUrl} |`;

	let updatedHandbook: string;
	if (rowRegex.test(handbookRaw)) {
		updatedHandbook = handbookRaw.replace(rowRegex, newRow);
	} else {
		throw new Error(
			`Row for route '${routeId}' not found in handbook pricing evidence table`,
		);
	}
	fs.writeFileSync(handbookPath, updatedHandbook, 'utf8');

	if (runTokenizerSpec) {
		execFileSync(
			process.execPath,
			['--test', path.join(PACKAGE_ROOT, 'routing/tokenizer-pricing.spec.mjs')],
			{
				cwd: PACKAGE_ROOT,
				stdio: 'pipe',
			},
		);
	}

	return {
		ok: true,
		routeId,
		pricingVersion: policy.pricingVersion,
	};
}

export function main(): void {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			check: { type: 'boolean', default: false },
			bump: { type: 'boolean', default: false },
			route: { type: 'string' },
			'input-rate': { type: 'string' },
			'output-rate': { type: 'string' },
			'effective-date': { type: 'string' },
			citation: { type: 'string' },
		},
		strict: true,
		allowPositionals: false,
	});

	if (values.bump) {
		try {
			const result = bumpPricing({
				routeId: values.route,
				inputRate: values['input-rate'],
				outputRate: values['output-rate'],
				effectiveDate: values['effective-date'],
				citationUrl: values.citation,
			});
			console.log(
				`Successfully bumped pricing for ${result.routeId}. New pricingVersion: ${result.pricingVersion}`,
			);
			process.exit(0);
		} catch (err) {
			console.error(`Bump failed: ${(err as Error).message}`);
			process.exit(1);
		}
	}

	// Default to check mode if --check or no flag passed
	const audit = auditPricing();
	if (audit.ok) {
		console.log(
			`Pricing audit OK: ${audit.routesChecked} enabled metered routes verified with exact handbook parity.`,
		);
		process.exit(0);
	} else {
		console.error('Pricing audit FAILED:');
		for (const err of audit.errors) {
			console.error(`  - ${err}`);
		}
		process.exit(1);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
