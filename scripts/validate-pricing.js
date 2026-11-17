#!/usr/bin/env node
/* Fails (exit 1) if data/pricing.json breaks the pricing rules — most importantly
   if a larger home costs less than (or the same as) a smaller one.
   Usage: node scripts/validate-pricing.js [path/to/pricing.json] */
'use strict';

const { loadPricing, validatePricing } = require('./pricing');

const { errors, todos } = validatePricing(loadPricing(process.argv[2]));

if (todos.length) {
  console.log(`TODO — ${todos.length} price(s) still to be set by the owner (never shown on the site):`);
  todos.forEach(t => console.log('  - ' + t));
}
if (errors.length) {
  console.error(`\nPRICING VALIDATION FAILED — ${errors.length} problem(s):`);
  errors.forEach(e => console.error('  x ' + e));
  process.exit(1);
}
console.log('\nPRICING VALIDATION PASSED');
