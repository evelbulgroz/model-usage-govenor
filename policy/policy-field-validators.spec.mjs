import assert from 'node:assert/strict';
import test from 'node:test';
import {
	closed,
	object,
	repositoryPathArray,
	required,
	safeInteger,
	string,
} from './policy-field-validators.ts';

test('object, closed, and required reject null, arrays, and missing keys', () => {
	assert.throws(() => object(null, 'value'), /must be an object/);
	assert.throws(() => object([], 'value'), /must be an object/);
	assert.throws(() => closed({ extra: 1 }, new Set(['id']), 'value'), /unknown key 'extra'/);
	assert.throws(() => required({}, ['id'], 'value'), /id is required/);
	assert.equal(required({ id: 'route' }, ['id'], 'value'), undefined);
});

test('safeInteger and string reject empty values and non-integers', () => {
	assert.throws(() => safeInteger(1.5, 'count'), /non-negative safe integer/);
	assert.throws(() => safeInteger(0, 'count', { positive: true }), /positive safe integer/);
	assert.equal(safeInteger(0, 'count'), 0);
	assert.throws(() => string('', 'name'), /invalid/);
	assert.throws(() => string(null, 'name'), /invalid/);
});

test('repositoryPathArray rejects absolute paths and parent segments', () => {
	assert.throws(() => repositoryPathArray(['/etc/passwd'], 'paths'), /outside the repository/);
	assert.throws(() => repositoryPathArray(['../secret'], 'paths'), /outside the repository/);
	assert.deepEqual(repositoryPathArray(['tools/model-usage'], 'paths'), ['tools/model-usage']);
});
