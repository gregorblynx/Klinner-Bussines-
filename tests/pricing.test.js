'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPricing, validatePricing, startingPrice } = require('../scripts/pricing.js');

function data(rows) {
  return { services: { deep: { prices: rows } } };
}

test('the real data/pricing.json passes validation', () => {
  assert.deepEqual(validatePricing(loadPricing()).errors, []);
});

test('3 bed / 3 bath cheaper than 3 bed / 2 bath FAILS (the known past error)', () => {
  const { errors } = validatePricing(data([
    { bedrooms: 3, bathrooms: 2, price: 300 },
    { bedrooms: 3, bathrooms: 3, price: 280 }
  ]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /3 bed \/ 3 bath/);
});

test('same price for a larger home FAILS', () => {
  const { errors } = validatePricing(data([
    { bedrooms: 2, bathrooms: 2, price: 249 },
    { bedrooms: 3, bathrooms: 2, price: 249 }
  ]));
  assert.equal(errors.length, 1);
});

test('same bathrooms, more bedrooms must cost more', () => {
  const { errors } = validatePricing(data([
    { bedrooms: 2, bathrooms: 2, price: 249 },
    { bedrooms: 4, bathrooms: 2, price: 200 }
  ]));
  assert.equal(errors.length, 1);
});

test('correctly increasing prices pass', () => {
  const { errors } = validatePricing(data([
    { bedrooms: 3, bathrooms: 2, price: 300 },
    { bedrooms: 3, bathrooms: 3, price: 330 },
    { bedrooms: 4, bathrooms: 3, price: 380 }
  ]));
  assert.deepEqual(errors, []);
});

test('unset (null) prices are TODOs, not errors, and never trigger comparisons', () => {
  const { errors, todos } = validatePricing(data([
    { bedrooms: 3, bathrooms: 2, price: null },
    { bedrooms: 3, bathrooms: 3, price: 100 }
  ]));
  assert.deepEqual(errors, []);
  assert.equal(todos.length, 1);
});

test('invalid prices and duplicate sizes fail', () => {
  assert.equal(validatePricing(data([{ bedrooms: 1, bathrooms: 1, price: -5 }])).errors.length, 1);
  assert.equal(validatePricing(data([
    { bedrooms: 1, bathrooms: 1, price: 100 },
    { bedrooms: 1, bathrooms: 1, price: 120 }
  ])).errors.length, 1);
});

test('startingPrice is the lowest filled-in price, or null', () => {
  assert.equal(startingPrice({ prices: [{ price: null }, { price: 249 }, { price: 300 }] }), 249);
  assert.equal(startingPrice({ prices: [{ price: null }] }), null);
});

test('Google Business Profile prices: airbnb 85, deep 249 (2/2), move-in 149, move-out 149, basic handyman 125', () => {
  const { services } = loadPricing();
  assert.equal(startingPrice(services['airbnb-cleaning']), 85);
  assert.equal(startingPrice(services['deep-cleaning']), 249);
  const deep = services['deep-cleaning'].prices.find(r => r.price === 249);
  assert.equal(`${deep.bedrooms}/${deep.bathrooms}`, '2/2');
  assert.equal(startingPrice(services['move-in-cleaning']), 149);
  assert.equal(startingPrice(services['move-out-cleaning']), 149);
  assert.equal(startingPrice(services['handyman-services']), 125);
});

test('Move-In and Move-Out are separate services; there is no combined entry', () => {
  const { services } = loadPricing();
  assert.ok(services['move-in-cleaning'] && services['move-out-cleaning']);
  assert.equal(services['move-in-out-cleaning'], undefined);
});

test('the handyman service is named "Basic Handyman" and carries its price details', () => {
  const { services } = loadPricing();
  const h = services['handyman-services'];
  assert.equal(h.name, 'Basic Handyman');
  const details = h.details.join(' ');
  assert.match(details, /first hour/);
  assert.match(details, /\$75 per additional hour/);
  assert.match(details, /Materials billed separately/);
});

test('Recurring Cleaning has been removed from the pricing data and from our-work.html', () => {
  const { services } = loadPricing();
  assert.equal(services['recurring-cleaning'], undefined);
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'our-work.html'), 'utf8');
  assert.doesNotMatch(html, /recurring/i);
});

test('our-work.html is in sync with data/pricing.json (run: node scripts/build-our-work.js)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { build } = require('../scripts/build-our-work.js');
  const html = fs.readFileSync(path.join(__dirname, '..', 'our-work.html'), 'utf8');
  assert.equal(build(html, loadPricing()), html);
});

test('every price on our-work.html is preceded by "Starting at"', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // Only the page content: the footer's "$1M General Liability" is not a service price.
  // The size-note paragraph holds sentences that belong to the "Starting at" price above it
  // (e.g. handyman: "$75 per additional hour"), so it is excluded from the per-price check.
  const html = fs.readFileSync(path.join(__dirname, '..', 'our-work.html'), 'utf8').match(/<main>[\s\S]*<\/main>/)[0]
    .replace(/<p class="size-note">[\s\S]*?<\/p>/g, '');
  const prices = html.match(/\$\d[\d,]*/g) || [];
  const labelled = html.match(/Starting at(?:<\/span>)? ?(?:<strong class="price-amount">)?\$\d[\d,]*/g) || [];
  assert.ok(prices.length > 0);
  assert.equal(labelled.length, prices.length);
});
