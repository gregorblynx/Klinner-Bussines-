#!/usr/bin/env node
/* Renders every price shown on our-work.html from data/pricing.json (the single source of truth).
   It rewrites ONLY the regions between these marker comments in our-work.html:
     <!--PRICE-SUMMARY:START--> … <!--PRICE-SUMMARY:END-->   (overview cards)
     <!--PRICE:<service-slug>:START--> … <!--PRICE:<service-slug>:END-->   (per-service price box)
     <!--JSONLD:START--> … <!--JSONLD:END-->                 (schema.org offers with the starting prices)
   Validation runs first; a failed validation stops the build and nothing is written.
   Usage:  node scripts/build-our-work.js            rebuild our-work.html
           node scripts/build-our-work.js --check    exit 1 if our-work.html is out of date */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadPricing, validatePricing, startingPrice } = require('./pricing');

const SITE = 'https://klinnercleaning.com';
const PAGE = path.join(__dirname, '..', 'our-work.html');
const QUOTE_URL = '/#quote';
const FINAL_PRICE_NOTE = 'Final price depends on size, condition and add-ons.';

const money = n => '$' + n.toLocaleString('en-US');
const sizeLabel = r => (r.bedrooms == null ? 'Starting price' : `${r.bedrooms} bed / ${r.bathrooms} bath`);
const sizePhrase = r => (r.bedrooms == null ? '' : `for a ${r.bedrooms} bed / ${r.bathrooms} bath home`);

function pricedRows(service) {
  return (service.prices || [])
    .filter(r => typeof r.price === 'number')
    .sort((a, b) => (a.bedrooms || 0) - (b.bedrooms || 0) || (a.bathrooms || 0) - (b.bathrooms || 0));
}

/* "Starting at" is printed next to EVERY price that is displayed. */
function priceLine(row) {
  const size = sizePhrase(row);
  return `<p class="price-from"><span class="price-label">Starting at</span> <strong class="price-amount">${money(row.price)}</strong>` +
    (size ? ` <span class="price-size">${size}</span>` : '') + '</p>';
}

function lowestRow(service) {
  const rows = pricedRows(service);
  return rows.length ? rows.reduce((a, b) => (b.price < a.price ? b : a)) : null;
}

function renderBox(service) {
  const low = lowestRow(service);
  if (!low) {
    return [
      '<div class="price-box">',
      '  <p class="price-quote">Free quote</p>',
      '  <p class="price-note">Final price depends on size, condition and add-ons. <a href="' + QUOTE_URL + '">Request a quote.</a></p>',
      '  <a href="' + QUOTE_URL + '" class="btn btn-primary">Request a Quote</a>',
      '</div>'
    ].join('\n');
  }
  const rows = pricedRows(service);
  const out = ['<div class="price-box">', '  ' + priceLine(low)];
  const extra = [service.sizeNote].concat(service.details || []).filter(Boolean).join(' ');
  if (extra) out.push(`  <p class="size-note">${extra}</p>`);
  if (rows.length >= 2) {
    out.push('  <table class="price-table">', `    <caption>Prices by home size</caption>`, '    <tbody>');
    rows.forEach(r => out.push(`      <tr><th scope="row">${sizeLabel(r)}</th><td>Starting at ${money(r.price)}</td></tr>`));
    out.push('    </tbody>', '  </table>');
  }
  out.push(
    `  <p class="price-note">${FINAL_PRICE_NOTE} <a href="${QUOTE_URL}">Request a free quote.</a></p>`,
    `  <a href="${QUOTE_URL}" class="btn btn-primary">Get a Free Quote</a>`,
    '</div>'
  );
  return out.join('\n');
}

function renderSummary(data) {
  const cards = Object.entries(data.services).map(([slug, service]) => {
    const low = lowestRow(service);
    const price = low
      ? `<p class="price-from"><span class="price-label">Starting at</span> <strong class="price-amount">${money(low.price)}</strong></p>`
      : '<p class="price-quote">Free quote</p>';
    return `<a class="price-summary-card" href="#${slug}"><h3>${service.name}</h3>${price}<span class="more">See details</span></a>`;
  });
  return '<div class="price-summary">\n' + cards.map(c => '  ' + c).join('\n') + '\n</div>';
}

function renderJsonLd(data) {
  const offers = Object.entries(data.services).map(([slug, service]) => {
    const low = lowestRow(service);
    const offer = {
      '@type': 'Offer',
      itemOffered: { '@type': 'Service', name: service.name, url: `${SITE}/${service.pagePath}`, areaServed: 'Nashville, TN' }
    };
    if (low) {
      offer.priceSpecification = {
        '@type': 'PriceSpecification',
        minPrice: low.price,
        priceCurrency: data.currency || 'USD',
        description: ['Starting price.'].concat(service.details || [], 'Final price depends on size, condition and add-ons.').join(' ')
      };
    }
    return offer;
  });
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'HouseCleaningService',
    name: 'Klinner Cleaning & Maintenance',
    url: SITE,
    image: `${SITE}/klinner-logo.png`,
    email: 'info@klinnercleaning.com',
    address: { '@type': 'PostalAddress', addressLocality: 'Nashville', addressRegion: 'TN', postalCode: '37201', addressCountry: 'US' },
    areaServed: { '@type': 'City', name: 'Nashville', containedInPlace: { '@type': 'State', name: 'Tennessee' } },
    hasOfferCatalog: { '@type': 'OfferCatalog', name: 'Cleaning services and starting prices', itemListElement: offers },
    mainEntityOfPage: `${SITE}/our-work.html`
  };
  return '<script type="application/ld+json">\n' + JSON.stringify(ld, null, 2) + '\n</script>';
}

function replaceBlock(html, name, content) {
  const re = new RegExp(`(<!--${name}:START-->)[\\s\\S]*?(<!--${name}:END-->)`);
  if (!re.test(html)) throw new Error(`our-work.html is missing the markers <!--${name}:START--> / <!--${name}:END-->`);
  return html.replace(re, (_, start, end) => `${start}\n${content}\n${end}`);
}

function build(html, data) {
  let out = replaceBlock(html, 'PRICE-SUMMARY', renderSummary(data));
  for (const [slug, service] of Object.entries(data.services)) {
    out = replaceBlock(out, `PRICE:${slug}`, renderBox(service));
  }
  return replaceBlock(out, 'JSONLD', renderJsonLd(data));
}

if (require.main === module) {
  const data = loadPricing();
  const { errors } = validatePricing(data);
  if (errors.length) {
    console.error('PRICING VALIDATION FAILED — our-work.html was NOT rebuilt:');
    errors.forEach(e => console.error('  x ' + e));
    process.exit(1);
  }
  const current = fs.readFileSync(PAGE, 'utf8');
  const next = build(current, data);
  if (process.argv.includes('--check')) {
    if (next !== current) { console.error('our-work.html is out of date. Run: node scripts/build-our-work.js'); process.exit(1); }
    console.log('our-work.html is up to date with data/pricing.json');
  } else {
    fs.writeFileSync(PAGE, next);
    console.log('our-work.html rebuilt from data/pricing.json');
  }
}

module.exports = { build, renderBox, renderSummary, renderJsonLd };
