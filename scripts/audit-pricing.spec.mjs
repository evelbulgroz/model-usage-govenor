import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditPricing, bumpPricing, parseMarkdownPricingTable } from './audit-pricing.ts';

function createTempFixture({ policyMod, handbookMod } = {}) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pricing-test-'));
	const policyPath = path.join(tempDir, 'model-usage-policy.json');
	const handbookPath = path.join(tempDir, 'model-usage-provider-capabilities.md');

	const basePolicy = {
		schemaVersion: '1.0.0',
		pricingVersion: '2026-09-11',
		routes: [
			{
				id: 'test-route-1',
				enabled: true,
				metered: true,
				pricing: {
					status: 'known',
					inputMicrousdPerMillionTokens: 150000,
					outputMicrousdPerMillionTokens: 600000,
					effectiveDate: '2026-09-11',
					citationUrl: 'https://example.com/pricing-1',
				},
			},
			{
				id: 'test-route-2',
				enabled: true,
				metered: true,
				pricing: {
					status: 'known',
					inputMicrousdPerMillionTokens: 750000,
					outputMicrousdPerMillionTokens: 3750000,
					effectiveDate: '2026-09-11',
					citationUrl: 'https://example.com/pricing-2',
				},
			},
			{
				id: 'disabled-route',
				enabled: false,
				metered: false,
				pricing: { status: 'known', inputMicrousdPerMillionTokens: 0 },
			},
		],
	};

	const baseHandbook = `# Capabilities Reference

## Metered route rate card and pricing evidence

| Route | Input (µUSD/1M) | Output (µUSD/1M) | Effective date | Citation |
|---|---:|---:|---|---|
| \`test-route-1\` | 150000 | 600000 | 2026-09-11 | https://example.com/pricing-1 |
| \`test-route-2\` | 750000 | 3750000 | 2026-09-11 | https://example.com/pricing-2 |
`;

	const policy = policyMod ? policyMod(basePolicy) : basePolicy;
	const handbook = handbookMod ? handbookMod(baseHandbook) : baseHandbook;

	fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2), 'utf8');
	fs.writeFileSync(handbookPath, handbook, 'utf8');

	return {
		tempDir,
		policyPath,
		handbookPath,
		cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
	};
}

test('parseMarkdownPricingTable correctly extracts routes and rates', () => {
	const md = `
| Route | Input (µUSD/1M) | Output (µUSD/1M) | Effective date | Citation |
|---|---:|---:|---|---|
| \`openai-compatible-conservative\` | 150000 | 600000 | 2026-09-11 | https://platform.openai.com/docs/pricing |
| google-gemini-conservative | 750000 | 3750000 | 2026-09-11 | https://ai.google.dev/pricing |
`;
	const table = parseMarkdownPricingTable(md);
	assert.equal(table.size, 2);
	const openai = table.get('openai-compatible-conservative');
	assert.deepEqual(openai, {
		routeId: 'openai-compatible-conservative',
		inputRate: 150000,
		outputRate: 600000,
		effectiveDate: '2026-09-11',
		citationUrl: 'https://platform.openai.com/docs/pricing',
	});
});

test('auditPricing passes on matching fixture', () => {
	const fixture = createTempFixture();
	try {
		const result = auditPricing({
			policyPath: fixture.policyPath,
			handbookPath: fixture.handbookPath,
		});
		assert.equal(result.ok, true);
		assert.equal(result.errors.length, 0);
		assert.equal(result.routesChecked, 2);
	} finally {
		fixture.cleanup();
	}
});

test('auditPricing detects rate mismatch between policy and handbook', () => {
	const fixture = createTempFixture({
		policyMod: (p) => {
			p.routes[0].pricing.inputMicrousdPerMillionTokens = 999999;
			return p;
		},
	});
	try {
		const result = auditPricing({
			policyPath: fixture.policyPath,
			handbookPath: fixture.handbookPath,
		});
		assert.equal(result.ok, false);
		assert.match(result.errors[0], /input rate mismatch/);
	} finally {
		fixture.cleanup();
	}
});

test('auditPricing detects pricingVersion mismatch', () => {
	const fixture = createTempFixture({
		policyMod: (p) => {
			p.pricingVersion = '2025-01-01';
			return p;
		},
	});
	try {
		const result = auditPricing({
			policyPath: fixture.policyPath,
			handbookPath: fixture.handbookPath,
		});
		assert.equal(result.ok, false);
		assert.match(result.errors[0], /pricingVersion '2025-01-01' does not match max effectiveDate/);
	} finally {
		fixture.cleanup();
	}
});

test('bumpPricing updates policy and handbook and monotonically updates pricingVersion', () => {
	const fixture = createTempFixture();
	try {
		const bumpResult = bumpPricing({
			routeId: 'test-route-1',
			inputRate: '200000',
			outputRate: '800000',
			effectiveDate: '2026-10-01',
			citationUrl: 'https://example.com/pricing-1-updated',
			policyPath: fixture.policyPath,
			handbookPath: fixture.handbookPath,
			runTokenizerSpec: false,
		});

		assert.equal(bumpResult.ok, true);
		assert.equal(bumpResult.pricingVersion, '2026-10-01');

		// Audit should now pass on the bumped files
		const auditResult = auditPricing({
			policyPath: fixture.policyPath,
			handbookPath: fixture.handbookPath,
		});
		assert.equal(auditResult.ok, true);

		// Verify monotonic behavior when bumping with an earlier date
		const bumpEarlier = bumpPricing({
			routeId: 'test-route-2',
			inputRate: '700000',
			outputRate: '3500000',
			effectiveDate: '2026-09-15', // Earlier than 2026-10-01
			citationUrl: 'https://example.com/pricing-2-updated',
			policyPath: fixture.policyPath,
			handbookPath: fixture.handbookPath,
			runTokenizerSpec: false,
		});
		assert.equal(bumpEarlier.pricingVersion, '2026-10-01'); // Retains max
	} finally {
		fixture.cleanup();
	}
});

test('bumpPricing rejects invalid input parameters', () => {
	const fixture = createTempFixture();
	try {
		assert.throws(
			() =>
				bumpPricing({
					routeId: 'test-route-1',
					inputRate: '-10',
					outputRate: '100',
					effectiveDate: '2026-10-01',
					citationUrl: 'https://example.com',
					policyPath: fixture.policyPath,
					handbookPath: fixture.handbookPath,
				}),
			/inputRate must be a non-negative safe integer/,
		);

		assert.throws(
			() =>
				bumpPricing({
					routeId: 'test-route-1',
					inputRate: '100',
					outputRate: '100',
					effectiveDate: 'invalid-date',
					citationUrl: 'https://example.com',
					policyPath: fixture.policyPath,
					handbookPath: fixture.handbookPath,
				}),
			/effectiveDate must be a valid ISO/,
		);

		assert.throws(
			() =>
				bumpPricing({
					routeId: 'test-route-1',
					inputRate: '100',
					outputRate: '100',
					effectiveDate: '2026-10-01',
					citationUrl: 'http://insecure.com',
					policyPath: fixture.policyPath,
					handbookPath: fixture.handbookPath,
				}),
			/citationUrl must be a valid HTTPS URL/,
		);
	} finally {
		fixture.cleanup();
	}
});
