import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countryChoice } from '../src/apps/sheerid/labels.js';

test('country picker searches the localized name instead of a blank virtualized list', () => {
  const option = countryChoice('US', ['en-US', 'zh-Hans']);
  assert.equal(option.value, 'US');
  assert.equal(option.countryCode, 'US');
  assert.equal(option.searchText, 'United States');
  assert.ok(option.labels.includes('United States'));
  assert.ok(option.labels.includes('美国'));
  assert.equal(option.allowCountryFlagPrefix, true);
});

test('country picker prefers the form language even with English configuration', () => {
  const option = countryChoice('United States', ['zh-Hans', 'en-US']);
  assert.equal(option.countryCode, 'US');
  assert.equal(option.searchText, '美国');
  assert.ok(option.labels.includes('United States'));
});

test('country picker never guesses a code for an unrecognized name', () => {
  const option = countryChoice('Unknown Country Label', ['en-US']);
  assert.equal(option.countryCode, undefined);
  assert.equal(option.searchText, 'Unknown Country Label');
  assert.deepEqual(option.labels, ['Unknown Country Label']);
});
