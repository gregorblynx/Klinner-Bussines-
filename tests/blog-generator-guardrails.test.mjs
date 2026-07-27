import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  editorialAuditPrompt,
  imageBriefRequestsDisallowedAsset,
  sourceQuoteSupported,
  verifySourceClaims
} from '../scripts/generate-blog.mjs';

const recurringSource = fs.readFileSync(new URL('../recurring-cleaning.html', import.meta.url), 'utf8');

test('source verification accepts an exact confirmed quote', () => {
  const quote = 'Weekly, Bi-Weekly or Monthly';
  assert.equal(sourceQuoteSupported(recurringSource, quote), true);
});

test('source verification accepts confirmed text kept in order across page markup', () => {
  const quote = 'Weekly, Bi-Weekly or Monthly Recurring House Cleaning in Nashville, TN Keep your home consistently clean with a dependable schedule that fits your household.';
  assert.equal(sourceQuoteSupported(recurringSource, quote), true);
});

test('source verification rejects fabricated text', () => {
  assert.equal(
    sourceQuoteSupported(recurringSource, 'Klinner guarantees a free same-day cleaning in every Tennessee city'),
    false
  );
});

test('company claims must be meaningfully related to their source quote', () => {
  assert.throws(
    () => verifySourceClaims([
      {
        claim: 'Klinner guarantees same-day service everywhere.',
        sourcePath: 'recurring-cleaning.html',
        sourceQuote: 'Weekly, Bi-Weekly or Monthly Recurring House Cleaning in Nashville, TN'
      }
    ], [{ path: 'recurring-cleaning.html', text: recurringSource }]),
    /not sufficiently supported/
  );
});

test('editorial audit explicitly validates one category per execution', () => {
  const prompt = editorialAuditPrompt({
    result: {},
    master: 'Generate one educational and one local article each week.',
    sources: [],
    history: { posts: [] },
    topics: { topics: [] },
    type: 'educational'
  });

  assert.match(prompt, /exactly one educational article in this execution/);
  assert.match(prompt, /Do not fail this package because the other weekly article is absent/);
});

test('image brief may explicitly prohibit stock, placeholder, and before-and-after assets', () => {
  const brief = 'Create a neutral home-care illustration. Do not use a stock photo, placeholder image, or before-and-after presentation.';
  assert.equal(imageBriefRequestsDisallowedAsset(brief), false);
});

test('image brief rejects requests to publish disallowed assets', () => {
  assert.equal(imageBriefRequestsDisallowedAsset('Use a generic stock photo of a clean kitchen.'), true);
  assert.equal(imageBriefRequestsDisallowedAsset('Publish a placeholder image until a real photo is available.'), true);
  assert.equal(imageBriefRequestsDisallowedAsset('Create a before-and-after image of the room.'), true);
});
