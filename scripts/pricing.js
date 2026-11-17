'use strict';
/* Pricing data helpers shared by validate-pricing.js, build-our-work.js and the tests.
   Zero dependencies. Source of truth: data/pricing.json */

const fs = require('fs');
const path = require('path');

const PRICING_FILE = path.join(__dirname, '..', 'data', 'pricing.json');

function loadPricing(file) {
  return JSON.parse(fs.readFileSync(file || PRICING_FILE, 'utf8'));
}

function isSized(row) {
  return Number.isFinite(row.bedrooms) && Number.isFinite(row.bathrooms);
}

/* Returns { errors: string[], todos: string[] }. Errors must fail the check; todos are informational. */
function validatePricing(data) {
  const errors = [];
  const todos = [];
  if (!data || typeof data !== 'object' || !data.services || typeof data.services !== 'object') {
    return { errors: ['pricing data must have a "services" object'], todos };
  }

  for (const [slug, service] of Object.entries(data.services)) {
    const rows = service && service.prices;
    if (!Array.isArray(rows)) { errors.push(`${slug}: "prices" must be an array`); continue; }

    const seen = new Set();
    rows.forEach((row, i) => {
      const where = `${slug}[${i}]`;
      const size = (row.bedrooms == null && row.bathrooms == null) ? 'any size' : `${row.bedrooms} bed / ${row.bathrooms} bath`;
      if ((row.bedrooms == null) !== (row.bathrooms == null)) {
        errors.push(`${where}: bedrooms and bathrooms must both be numbers or both be null`);
      }
      for (const key of ['bedrooms', 'bathrooms']) {
        if (row[key] != null && (!Number.isInteger(row[key]) || row[key] < 0)) {
          errors.push(`${where}: ${key} must be a non-negative integer or null`);
        }
      }
      const dupKey = `${row.bedrooms}/${row.bathrooms}`;
      if (seen.has(dupKey)) errors.push(`${where}: duplicate size (${size})`);
      seen.add(dupKey);

      if (row.price === null || row.price === undefined) {
        todos.push(`${slug}: ${size} — price not set`);
      } else if (typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price <= 0) {
        errors.push(`${where}: price must be a positive number or null (got ${JSON.stringify(row.price)})`);
      }
    });

    // A larger home must never cost less than (or the same as) a smaller one.
    // "Larger" = at least as many bedrooms AND bathrooms, and not identical.
    // This covers: same beds + more baths, same baths + more beds, and mixed growth.
    const priced = rows.filter(r => isSized(r) && typeof r.price === 'number' && Number.isFinite(r.price));
    for (const small of priced) {
      for (const big of priced) {
        if (big === small) continue;
        const bigger = big.bedrooms >= small.bedrooms && big.bathrooms >= small.bathrooms &&
          (big.bedrooms > small.bedrooms || big.bathrooms > small.bathrooms);
        if (bigger && big.price <= small.price) {
          errors.push(
            `${slug}: ${big.bedrooms} bed / ${big.bathrooms} bath ($${big.price}) must cost more than ` +
            `${small.bedrooms} bed / ${small.bathrooms} bath ($${small.price})`
          );
        }
      }
    }
  }
  return { errors, todos };
}

/* Lowest price filled in for a service, or null when none is set yet. */
function startingPrice(service) {
  const prices = (service.prices || [])
    .map(r => r.price)
    .filter(p => typeof p === 'number' && Number.isFinite(p));
  return prices.length ? Math.min(...prices) : null;
}

module.exports = { PRICING_FILE, loadPricing, validatePricing, startingPrice };
