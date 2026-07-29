#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = { slug: '', scope: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--slug') result.slug = argv[++i] || '';
    else if (argv[i] === '--scope') result.scope = true;
    else fail(`Unknown argument: ${argv[i]}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.slug)) fail('--slug is required and must be a valid slug');
  return result;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function parsePost(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) fail(`${path.relative(ROOT, file)} is missing frontmatter`);
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^(\w+):\s*(.*)$/);
    if (item) meta[item[1]] = item[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: match[2], raw };
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function duplicateValues(items, field) {
  const seen = new Map();
  const duplicates = [];
  for (const item of items) {
    const value = normalize(item[field]);
    if (!value) continue;
    if (seen.has(value)) duplicates.push(item[field]);
    else seen.set(value, true);
  }
  return duplicates;
}

function htmlFilesUnder(relativeDir) {
  const start = path.join(ROOT, relativeDir);
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.html')) files.push(absolute);
    }
  }
  walk(start);
  return files;
}

function targetForHref(sourceFile, href) {
  const [withoutFragment] = href.split('#');
  const clean = withoutFragment.split('?')[0];
  if (!clean) return sourceFile;
  if (/^(?:https?:|mailto:|tel:|javascript:|data:)/i.test(clean) || clean.startsWith('//')) return null;
  let target = clean.startsWith('/')
    ? path.join(ROOT, clean.slice(1))
    : path.resolve(path.dirname(sourceFile), clean);
  if (clean.endsWith('/')) target = path.join(target, 'index.html');
  else if (!path.extname(target)) target = path.join(target, 'index.html');
  return target;
}

function verifyInternalLinks() {
  const errors = [];
  for (const file of htmlFilesUnder('blog')) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
      const href = match[1];
      const target = targetForHref(file, href);
      if (!target) continue;
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        errors.push(`${path.relative(ROOT, file)} -> ${href}`);
        continue;
      }
      const fragment = href.includes('#') ? decodeURIComponent(href.split('#')[1]) : '';
      if (fragment) {
        const targetHtml = fs.readFileSync(target, 'utf8');
        const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`(?:id|name)=["']${escaped}["']`, 'i').test(targetHtml)) {
          errors.push(`${path.relative(ROOT, file)} -> ${href} (missing fragment)`);
        }
      }
    }
  }
  if (errors.length) fail(`Broken internal links:\n${errors.join('\n')}`);
}

function verifyImageAlts(html, relativePath) {
  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const alt = match[1].match(/\balt=["']([^"']*)["']/i)?.[1];
    if (!alt?.trim()) fail(`${relativePath} contains an image without alt text`);
  }
}

function verifyScope(slug) {
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const allowed = new Set([
    `content/blog/${slug}.md`,
    `content/blog/${slug}.handoff.json`,
    `images/blog/${slug}-editorial.webp`,
    `blog/${slug}/index.html`,
    'blog/index.html',
    'sitemap.xml',
    'content/blog-history.json',
    'content/blog-topics.json'
  ]);
  const unexpected = [];
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    let name = line.slice(3).trim();
    if (name.includes(' -> ')) name = name.split(' -> ')[1];
    name = name.replace(/^"|"$/g, '');
    if (!allowed.has(name)) unexpected.push(name);
  }
  if (unexpected.length) fail(`Unexpected file changes detected:\n${unexpected.join('\n')}`);
}

function verifyBranchGuard() {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const defaultBranch = process.env.DEFAULT_BRANCH || 'main';
  if (!branch || branch === defaultBranch) fail(`Direct publication on ${defaultBranch} is forbidden`);
}

function main() {
  const { slug, scope } = parseArgs(process.argv.slice(2));
  verifyBranchGuard();
  const postPath = path.join(ROOT, 'content', 'blog', `${slug}.md`);
  const handoffPath = path.join(ROOT, 'content', 'blog', `${slug}.handoff.json`);
  const htmlPath = path.join(ROOT, 'blog', slug, 'index.html');
  for (const file of [postPath, handoffPath, htmlPath, path.join(ROOT, 'blog', 'index.html')]) {
    if (!fs.existsSync(file)) fail(`Required generated file is missing: ${path.relative(ROOT, file)}`);
  }

  const post = parsePost(postPath);
  const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
  const html = fs.readFileSync(htmlPath, 'utf8');
  for (const key of ['title', 'date', 'description', 'slug']) {
    if (!post.meta[key]) fail(`Post frontmatter is missing ${key}`);
  }
  if (post.meta.slug !== slug || handoff.suggestedSlug !== slug) fail('Slug mismatch across generated files');
  if (!post.meta.description.trim() || !handoff.metaDescription?.trim()) fail('Meta description is required');
  if (!handoff.contentStrategy?.trim()) fail('Content strategy is required');
  if (!handoff.primaryKeyword?.trim() || !handoff.secondaryKeywords?.length) fail('Primary and secondary keywords are required');
  if (!handoff.searchIntent?.trim() || !handoff.seoTitle?.trim()) fail('Search intent and SEO title are required');
  if (!handoff.h1?.trim() || !/^##\s+/m.test(post.body)) fail('H1 and H2 structure are required');
  if (!handoff.internalLinks?.length) fail('Internal links are required');
  if (!handoff.cta?.trim() || !/\/index\.html#(?:quote|contact-section)/.test(post.body)) fail('CTA is required');
  if (!handoff.image?.brief?.trim() || !handoff.image?.recommendedDimensions?.trim() || !handoff.image?.suggestedFilename?.trim()) {
    fail('Complete image brief is required');
  }
  if (!handoff.image?.altText?.trim()) fail('Image alt text is required');
  if (!post.meta.image?.trim() || !post.meta.image_alt?.trim()) fail('Featured image and alt text are required');
  if (!post.meta.image_caption?.trim()) fail('Featured image disclosure is required');
  const imagePath = post.meta.image.startsWith('/')
    ? path.join(ROOT, post.meta.image.slice(1))
    : path.resolve(path.dirname(postPath), post.meta.image);
  if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) fail(`Featured image is missing: ${post.meta.image}`);
  if (!handoff.blogExcerpt?.trim() || !handoff.socialMediaPost?.trim() || !handoff['CODEX HANDOFF']?.trim()) {
    fail('Excerpt, social post, and CODEX HANDOFF are required');
  }
  if (handoff.editorialAudit?.passed !== true || handoff.editorialAudit?.issues?.length) fail('Editorial audit did not pass');
  if (/(?:\$|\bUSD\b|\bdollars?\b|\bpercent\b|%)/i.test(post.body)) fail('Possible invented price or statistic detected');

  if (!/<meta\s+name=["']description["']\s+content=["'][^"']+/i.test(html)) fail('Generated HTML is missing meta description');
  if (!html.includes(`<title>${escapeHtml(handoff.seoTitle)} | Klinner Cleaning</title>`)) fail('Generated HTML is not using the supplied SEO title');
  if (!/<h1>[^<]+<\/h1>/i.test(html)) fail('Generated HTML is missing H1');
  if (!/href=["']\/index\.html#(?:quote|contact-section)["']/i.test(html)) fail('Generated HTML is missing the quote/contact CTA');
  if (!html.includes(`src="${post.meta.image}"`) || !html.includes(`alt="${post.meta.image_alt}"`)) fail('Generated HTML is missing the featured image or alt text');
  verifyImageAlts(html, path.relative(ROOT, htmlPath));

  const history = readJson('content/blog-history.json');
  const topics = readJson('content/blog-topics.json');
  const historySlugs = duplicateValues(history.posts, 'slug');
  const historyKeywords = duplicateValues(history.posts, 'primaryKeyword');
  const topicSlugs = duplicateValues(topics.topics, 'slug');
  const topicKeywords = duplicateValues(topics.topics, 'primaryKeyword');
  if (historySlugs.length || topicSlugs.length) fail(`Duplicate slug detected: ${[...historySlugs, ...topicSlugs].join(', ')}`);
  if (historyKeywords.length || topicKeywords.length) fail(`Duplicate keyword detected: ${[...historyKeywords, ...topicKeywords].join(', ')}`);
  const historyItem = history.posts.find((item) => item.slug === slug);
  if (!historyItem || !['title', 'slug', 'primaryKeyword', 'searchIntent', 'category', 'publicationDate', 'pullRequestStatus'].every((key) => historyItem[key])) {
    fail('Publication history entry is incomplete');
  }

  verifyInternalLinks();
  if (scope) verifyScope(slug);
  console.log(`Validated blog draft: ${slug}`);
}

try {
  main();
} catch (error) {
  console.error(`Klinner blog validation failed: ${error.message}`);
  process.exit(1);
}
