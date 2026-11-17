import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  editorialAuditPrompt,
  imageBriefRequestsDisallowedAsset,
  sourceQuoteSupported,
  verifySourceClaims
} from '../scripts/generate-blog.mjs';

const serviceSource = fs.readFileSync(new URL('../deep-cleaning.html', import.meta.url), 'utf8');

test('source verification accepts an exact confirmed quote', () => {
  const quote = 'Deep Cleaning in Nashville, TN';
  assert.equal(sourceQuoteSupported(serviceSource, quote), true);
});

test('source verification accepts confirmed text kept in order across page markup', () => {
  const quote = 'Deep Cleaning in Nashville, TN A more detailed clean for buildup, busy seasons, special occasions and homes that need extra attention.';
  assert.equal(sourceQuoteSupported(serviceSource, quote), true);
});

test('source verification rejects fabricated text', () => {
  assert.equal(
    sourceQuoteSupported(serviceSource, 'Klinner guarantees a free same-day cleaning in every Tennessee city'),
    false
  );
});

test('company claims must be meaningfully related to their source quote', () => {
  assert.throws(
    () => verifySourceClaims([
      {
        claim: 'Klinner guarantees same-day service everywhere.',
        sourcePath: 'deep-cleaning.html',
        sourceQuote: 'Deep Cleaning in Nashville, TN'
      }
    ], [{ path: 'deep-cleaning.html', text: serviceSource }]),
    /not sufficiently supported/
  );
});

test('company claim may use editorial language while preserving the cited service concept', () => {
  assert.doesNotThrow(
    () => verifySourceClaims([
      {
        claim: 'If ceiling-fan cleaning is part of a broader room reset, review the deep cleaning service when deciding how to scope the work.',
        sourcePath: 'deep-cleaning.html',
        sourceQuote: 'Deep Cleaning Service in Nashville, TN'
      }
    ], [{
      path: 'deep-cleaning.html',
      text: 'Deep Cleaning Service in Nashville, TN. A thorough top-to-bottom reset for your home.'
    }])
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
