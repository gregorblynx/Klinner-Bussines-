'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderIndex } = require('../build-blog.js');

function post(overrides = {}) {
  return {
    meta: {
      title: 'Example Cleaning Guide',
      date: '2026-07-17',
      description: 'A test description for the blog card.',
      excerpt: 'A test excerpt for the blog card.',
      slug: 'example-cleaning-guide',
      ...overrides
    }
  };
}

test('blog cards without an image do not create whitespace-only lines', () => {
  const html = renderIndex([post()]);

  assert.doesNotMatch(html, /^[\t ]+$/m);
  assert.match(html, /<a class="blog-card" href="\/blog\/example-cleaning-guide\/">\n          <div class="card-body">/);
});

test('blog cards render an approved image without changing card indentation', () => {
  const html = renderIndex([post({ image: '/images/blog/example.webp' })]);

  assert.doesNotMatch(html, /^[\t ]+$/m);
  assert.match(html, /<div class="thumb"><img src="\/images\/blog\/example.webp"/);
});
