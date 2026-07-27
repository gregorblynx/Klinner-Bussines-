#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = path.join(ROOT, 'content', 'blog');
const HISTORY_FILE = path.join(ROOT, 'content', 'blog-history.json');
const TOPICS_FILE = path.join(ROOT, 'content', 'blog-topics.json');
const MASTER_FILE = path.join(ROOT, 'docs', 'klinner-blog-master-instructions.md');
const TIME_ZONE = 'America/Chicago';
const DEFAULT_MODEL = 'gpt-5.6';

const OFFICIAL_FILES = [
  'index.html',
  'airbnb-cleaning.html',
  'deep-cleaning.html',
  'move-in-cleaning.html',
  'move-out-cleaning.html',
  'recurring-cleaning.html',
  'handyman-services.html'
];

const REAL_SERVICES = [
  'Airbnb Cleaning',
  'Deep Cleaning',
  'Move-In Cleaning',
  'Move-Out Cleaning',
  'Recurring Cleaning',
  'Basic Handyman'
];

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function parseArgs(argv) {
  const result = { type: 'auto', dryRun: false, date: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--type') result.type = argv[++i] || '';
    else if (argv[i] === '--date') result.date = argv[++i] || '';
    else if (argv[i] === '--dry-run') result.dryRun = true;
    else fail(`Unknown argument: ${argv[i]}`);
  }
  if (!['auto', 'educational', 'local-commercial'].includes(result.type)) {
    fail('--type must be auto, educational, or local-commercial');
  }
  if (result.date && !/^\d{4}-\d{2}-\d{2}$/.test(result.date)) {
    fail('--date must use YYYY-MM-DD');
  }
  return result;
}

function localDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(value) {
  const ignored = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'the', 'to', 'what', 'when', 'with']);
  return new Set(normalize(value).split(' ').filter((token) => token && !ignored.has(token)));
}

function jaccard(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / union.size;
}

function sharedMeaningfulTokenCount(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function stripHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function officialSource(relativePath) {
  const file = path.join(ROOT, relativePath);
  if (!fs.existsSync(file)) fail(`Required official source is missing: ${relativePath}`);
  const html = fs.readFileSync(file, 'utf8');
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '';
  const description = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)/i)?.[1] || '';
  const text = stripHtml(html);
  return { path: relativePath, text: `Title: ${stripHtml(title)}\nDescription: ${description}\nPage text: ${text}` };
}

function parseFrontmatter(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) fail(`${path.relative(ROOT, file)} has no valid frontmatter`);
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^(\w+):\s*(.*)$/);
    if (item) meta[item[1]] = item[2].replace(/^["']|["']$/g, '').trim();
  }
  return { path: path.relative(ROOT, file), meta, body: match[2].trim() };
}

function existingPosts() {
  return fs.readdirSync(CONTENT_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => parseFrontmatter(path.join(CONTENT_DIR, name)));
}

function chooseType(requested, history) {
  if (requested !== 'auto') return requested;
  const latest = [...history.posts]
    .filter((post) => ['educational', 'local-commercial'].includes(post.category))
    .sort((a, b) => String(b.publicationDate).localeCompare(String(a.publicationDate)))[0];
  return latest?.category === 'educational' ? 'local-commercial' : 'educational';
}

function assertNotDefaultBranch() {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const defaultBranch = process.env.DEFAULT_BRANCH || 'main';
  if (!branch || branch === defaultBranch) {
    fail(`Refusing to generate on the default branch (${defaultBranch}). Create an automation branch first.`);
  }
}

function schema() {
  const string = { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['topic', 'article'],
    properties: {
      topic: {
        type: 'object',
        additionalProperties: false,
        required: ['articleTitle', 'primaryKeyword', 'searchIntent', 'relatedService', 'targetAudience', 'seoValue', 'estimatedDifficulty', 'priority'],
        properties: {
          articleTitle: string,
          primaryKeyword: string,
          searchIntent: string,
          relatedService: { type: 'string', enum: REAL_SERVICES },
          targetAudience: string,
          seoValue: string,
          estimatedDifficulty: { type: 'string', enum: ['Low', 'Medium', 'High'] },
          priority: { type: 'string', enum: ['High', 'Medium', 'Low'] }
        }
      },
      article: {
        type: 'object',
        additionalProperties: false,
        required: [
          'contentStrategy', 'primaryKeyword', 'secondaryKeywords', 'searchIntent', 'seoTitle',
          'metaDescription', 'suggestedSlug', 'h1', 'articleMarkdown', 'internalLinks',
          'ctaMarkdown', 'imageBrief', 'imageDimensions', 'suggestedImageFilename',
          'imageAltText', 'blogExcerpt', 'socialMediaPost', 'codexHandoff', 'companyClaims'
        ],
        properties: {
          contentStrategy: string,
          primaryKeyword: string,
          secondaryKeywords: { type: 'array', minItems: 2, maxItems: 8, items: string },
          searchIntent: string,
          seoTitle: string,
          metaDescription: string,
          suggestedSlug: string,
          h1: string,
          articleMarkdown: string,
          internalLinks: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['url', 'anchorText', 'rationale'],
              properties: { url: string, anchorText: string, rationale: string }
            }
          },
          ctaMarkdown: string,
          imageBrief: string,
          imageDimensions: string,
          suggestedImageFilename: string,
          imageAltText: string,
          blogExcerpt: string,
          socialMediaPost: string,
          codexHandoff: string,
          companyClaims: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['claim', 'sourcePath', 'sourceQuote'],
              properties: { claim: string, sourcePath: string, sourceQuote: string }
            }
          }
        }
      }
    }
  };
}

function auditSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['passed', 'issues'],
    properties: {
      passed: { type: 'boolean' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'excerpt', 'reason'],
          properties: { type: { type: 'string' }, excerpt: { type: 'string' }, reason: { type: 'string' } }
        }
      }
    }
  };
}

function outputText(response) {
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) return content.text;
      if (content.type === 'refusal') fail(`OpenAI refused the request: ${content.refusal || 'no reason supplied'}`);
    }
  }
  fail(`OpenAI returned no output text (status: ${response.status || 'unknown'})`);
}

async function structuredResponse({ name, jsonSchema, system, user }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) fail('OPENAI_API_KEY is required');
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 16000,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      text: {
        format: {
          type: 'json_schema',
          name,
          strict: true,
          schema: jsonSchema
        }
      }
    })
  });
  const data = await response.json();
  if (!response.ok) fail(`OpenAI API error ${response.status}: ${data.error?.message || 'unknown error'}`);
  return JSON.parse(outputText(data));
}

function sourceBundle(sources) {
  return sources.map((source) => `\n===== SOURCE: ${source.path} =====\n${source.text}`).join('\n');
}

function prompt({ type, date, master, posts, history, topics, sources }) {
  const audience = type === 'educational'
    ? 'Create an educational article that answers a practical cleaning, maintenance, or home-care question.'
    : 'Create a Nashville-area local/commercial article tied to one confirmed Klinner service.';
  const prior = history.posts.map((post) => ({
    title: post.title,
    slug: post.slug,
    primaryKeyword: post.primaryKeyword,
    searchIntent: post.searchIntent,
    category: post.category
  }));
  const existing = posts.map((post) => ({ path: post.path, meta: post.meta, article: post.body }));
  return `Publication date in ${TIME_ZONE}: ${date}
Requested category: ${type}

${audience}

Non-negotiable production rules:
- Write all public-facing copy in US English.
- The master instructions and repository sources below are the only authority for company facts.
- Existing published articles are supplied only for duplicate-topic analysis; they are not authority for company facts.
- Never invent prices, services, certifications, guarantees, statistics, reviews, promotions, cities served, business processes, timing, coverage, or company claims.
- General educational guidance must be framed as practical guidance, not unsupported quantitative fact.
- Avoid every prior topic, slug, primary keyword, and equivalent search intent.
- The H1 and article title must match. The articleMarkdown must not contain an H1; use H2 and H3 headings.
- Produce a complete, useful article. Keep the CTA separate in ctaMarkdown and link it to /index.html#quote or /index.html#contact-section.
- Use two to six relevant internal links. Only use URLs that are visibly supported by the repository source paths.
- Do not select or claim a real Klinner photo. Supply only an image brief, recommended dimensions, filename, and alt text. No featured image path will be published automatically.
- Every company-specific sentence must be listed in companyClaims with a supporting quote and source path. Copy one contiguous quote from the source whenever possible; do not combine unrelated excerpts. Prefer no company-specific claim beyond the CTA.
- codexHandoff must tell the reviewer what to verify before approval, including factual claims, links, image approval, and Vercel Preview.
- seoValue must be two or three sentences.

MASTER INSTRUCTIONS (primary source):
${master}

PUBLICATION HISTORY:
${JSON.stringify(prior, null, 2)}

TOPIC HISTORY:
${JSON.stringify(topics.topics, null, 2)}

EXISTING PUBLISHED ARTICLES (full source):
${JSON.stringify(existing, null, 2)}

OFFICIAL REPOSITORY PAGES:
${sourceBundle(sources)}`;
}

function resolveInternalPath(url) {
  const clean = url.split('#')[0].split('?')[0];
  if (!clean.startsWith('/') || clean.startsWith('//')) return null;
  if (clean === '/') return path.join(ROOT, 'index.html');
  let target = path.join(ROOT, clean.slice(1));
  if (!path.extname(target)) target = path.join(target, 'index.html');
  return target;
}

function orderedTokenSubsequence(needle, haystack) {
  const expected = normalize(needle).split(' ').filter(Boolean);
  const available = normalize(haystack).split(' ').filter(Boolean);
  if (expected.length < 8) return false;
  let cursor = 0;
  for (const token of available) {
    if (token === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return true;
  }
  return false;
}

export function sourceQuoteSupported(source, quote) {
  const normalizedSource = normalize(source);
  const normalizedQuote = normalize(quote);
  if (normalizedQuote.length < 12) return false;
  return normalizedSource.includes(normalizedQuote) || orderedTokenSubsequence(normalizedQuote, normalizedSource);
}

export function verifySourceClaims(claims, sources) {
  const byPath = new Map(sources.map((source) => [source.path, normalize(source.text)]));
  for (const item of claims) {
    if (!byPath.has(item.sourcePath)) fail(`Company claim cites an unauthorized source: ${item.sourcePath}`);
    if (!sourceQuoteSupported(byPath.get(item.sourcePath), item.sourceQuote)) {
      fail(`Company claim source quote was not found in order in ${item.sourcePath}: ${item.sourceQuote}`);
    }
    if (sharedMeaningfulTokenCount(item.claim, item.sourceQuote) < 2) {
      fail(`Company claim is not sufficiently supported by its cited quote in ${item.sourcePath}: ${item.claim}`);
    }
  }
}

export function imageBriefRequestsDisallowedAsset(brief) {
  const patterns = [
    /\b(?:use|select|source|choose|provide)\s+(?:an?\s+)?(?:generic\s+)?stock\s+(?:photo|image)\b/,
    /\b(?:use|add|publish|provide)\s+(?:an?\s+)?placeholder\s+(?:photo|image)\b/,
    /\b(?:create|show|depict|publish|provide)\s+(?:an?\s+)?before\s+and\s+after\b/
  ];
  return String(brief || '').split(/[.!?]+/).some((sentence) => {
    const text = normalize(sentence);
    if (/\b(?:do not|dont|never|must not|should not)\b/.test(text)) return false;
    return patterns.some((pattern) => pattern.test(text));
  });
}

function staticChecks(result, { type, history, topics, posts, sources }) {
  const { topic, article } = result;
  if (topic.primaryKeyword !== article.primaryKeyword) fail('Topic and article primary keywords do not match');
  if (topic.searchIntent !== article.searchIntent) fail('Topic and article search intents do not match');
  if (topic.articleTitle !== article.h1) fail('Article title and H1 do not match');
  if (!REAL_SERVICES.includes(topic.relatedService)) fail(`Unconfirmed service: ${topic.relatedService}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.suggestedSlug)) fail(`Invalid slug: ${article.suggestedSlug}`);
  if (!article.metaDescription.trim()) fail('Meta description is required');
  if (!article.imageAltText.trim()) fail('Image alt text is required');
  if (!/^##\s+/m.test(article.articleMarkdown)) fail('Article must contain H2 headings');
  if (/^#\s+/m.test(article.articleMarkdown)) fail('Article Markdown must not contain an H1');
  if (!/\]\(\/index\.html#(?:quote|contact-section)\)/.test(article.ctaMarkdown)) {
    fail('CTA must link to the real quote or contact section');
  }
  const publicCopy = `${article.articleMarkdown}\n${article.ctaMarkdown}`;
  if (/(?:\$|\bUSD\b|\bdollars?\b|\bpercent\b|%)/i.test(publicCopy)) {
    fail('Prices or numeric/statistical claims are not allowed');
  }
  if (imageBriefRequestsDisallowedAsset(article.imageBrief)) {
    fail('Image brief must not imply a stock, placeholder, or before-and-after asset');
  }
  for (const link of article.internalLinks) {
    const target = resolveInternalPath(link.url);
    if (!target || !fs.existsSync(target)) fail(`Broken or unsupported internal link: ${link.url}`);
    if (!publicCopy.includes(`](${link.url})`)) fail(`Declared internal link is missing from article or CTA: ${link.url}`);
  }
  verifySourceClaims(article.companyClaims, sources);

  const priorItems = [
    ...history.posts.map((item) => ({ title: item.title, slug: item.slug, keyword: item.primaryKeyword, intent: item.searchIntent })),
    ...topics.topics.map((item) => ({ title: item.articleTitle, slug: item.slug, keyword: item.primaryKeyword, intent: item.searchIntent })),
    ...posts.map((item) => ({ title: item.meta.title, slug: item.meta.slug, keyword: String(item.meta.keywords || '').split(',')[0], intent: '' }))
  ];
  for (const prior of priorItems) {
    if (prior.slug === article.suggestedSlug) fail(`Duplicate slug: ${article.suggestedSlug}`);
    if (normalize(prior.keyword) === normalize(article.primaryKeyword)) fail(`Duplicate primary keyword: ${article.primaryKeyword}`);
    if (normalize(prior.intent) && normalize(prior.intent) === normalize(article.searchIntent)) fail(`Duplicate search intent: ${article.searchIntent}`);
    if (jaccard(prior.keyword, article.primaryKeyword) >= 0.8) fail(`Near-duplicate primary keyword: ${prior.keyword}`);
    if (jaccard(prior.title, topic.articleTitle) >= 0.72) fail(`Near-duplicate topic: ${prior.title}`);
  }
  if (type === 'educational' && topic.targetAudience.toLowerCase().includes('nashville') && !article.primaryKeyword.toLowerCase().includes('nashville')) {
    // Nashville references are allowed in an educational article, but local intent should remain reserved for local-commercial runs.
  }
}

function yamlString(value) {
  return `"${String(value).replace(/"/g, "'").replace(/\r?\n/g, ' ')}"`;
}

function articleMarkdown(result, date) {
  const { topic, article } = result;
  const keywords = [article.primaryKeyword, ...article.secondaryKeywords]
    .filter((value, index, array) => array.findIndex((item) => normalize(item) === normalize(value)) === index)
    .join(', ');
  return `---
title: ${yamlString(topic.articleTitle)}
date: ${date}
description: ${yamlString(article.metaDescription)}
slug: ${article.suggestedSlug}
seo_title: ${yamlString(article.seoTitle)}
excerpt: ${yamlString(article.blogExcerpt)}
keywords: ${keywords}
---

${article.articleMarkdown.trim()}

${article.ctaMarkdown.trim()}
`;
}

export function editorialAuditPrompt({ result, master, sources, history, topics, type }) {
  return `Audit this proposed Klinner blog package against the source material.

This workflow intentionally creates exactly one ${type} article in this execution. The other weekly category is created by a separate scheduled execution. Do not fail this package because the other weekly article is absent.

Fail it if it contains an invented or unsupported price, service, statistic, certification, guarantee, review, promotion, city served, company fact, business process, timing promise, or real-work/photo claim. Fail it for a duplicate or substantially equivalent topic, primary keyword, slug, or search intent. Fail it if the CTA, metadata, internal links, image brief, alt text, full article, or CODEX handoff is missing. General non-quantitative home-care guidance is allowed.

MASTER:
${master}

OFFICIAL SOURCES:
${sourceBundle(sources)}

HISTORY:
${JSON.stringify(history.posts, null, 2)}

TOPICS:
${JSON.stringify(topics.topics, null, 2)}

PROPOSED PACKAGE:
${JSON.stringify(result, null, 2)}`;
}

async function editorialAudit({ result, master, sources, history, topics, type }) {
  const system = `You are a strict factual and SEO compliance auditor. Fail closed: any unsupported business claim or meaningful duplication must make passed false.
Audit exactly one requested article category per execution. Never require the other weekly category in the same package.`;
  const user = editorialAuditPrompt({ result, master, sources, history, topics, type });
  return structuredResponse({ name: 'klinner_blog_audit', jsonSchema: auditSchema(), system, user });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const file of [MASTER_FILE, HISTORY_FILE, TOPICS_FILE]) {
    if (!fs.existsSync(file)) fail(`Required file is missing: ${path.relative(ROOT, file)}`);
  }
  assertNotDefaultBranch();
  const history = readJson(HISTORY_FILE);
  const topics = readJson(TOPICS_FILE);
  const posts = existingPosts();
  const master = fs.readFileSync(MASTER_FILE, 'utf8').trim();
  const sources = OFFICIAL_FILES.map(officialSource);
  const type = chooseType(options.type, history);
  const date = options.date || localDate();

  const result = await structuredResponse({
    name: 'klinner_blog_package',
    jsonSchema: schema(),
    system: 'You are the Content Strategist and SEO Editor for Klinner Cleaning & Maintenance. Follow the supplied master instructions and repository evidence exactly. When evidence is absent, omit the claim.',
    user: prompt({ type, date, master, posts, history, topics, sources })
  });

  staticChecks(result, { type, history, topics, posts, sources });
  const audit = await editorialAudit({ result, master, sources, history, topics, type });
  if (!audit.passed || audit.issues.length) {
    const details = audit.issues.map((item) => `${item.type}: ${item.reason} [${item.excerpt}]`).join('\n');
    fail(`Editorial audit failed:\n${details || 'audit did not pass'}`);
  }

  const { topic, article } = result;
  const postFile = path.join(CONTENT_DIR, `${article.suggestedSlug}.md`);
  const handoffFile = path.join(CONTENT_DIR, `${article.suggestedSlug}.handoff.json`);
  if (fs.existsSync(postFile) || fs.existsSync(handoffFile)) fail(`Slug output already exists: ${article.suggestedSlug}`);

  const topicRecord = {
    ...topic,
    category: type,
    slug: article.suggestedSlug,
    status: 'draft-pr',
    createdAt: date
  };
  const historyRecord = {
    title: topic.articleTitle,
    slug: article.suggestedSlug,
    primaryKeyword: article.primaryKeyword,
    searchIntent: article.searchIntent,
    category: type,
    publicationDate: date,
    pullRequestStatus: 'draft',
    source: 'github-actions'
  };
  const handoff = {
    version: 1,
    category: type,
    publicationDate: date,
    topic,
    contentStrategy: article.contentStrategy,
    primaryKeyword: article.primaryKeyword,
    secondaryKeywords: article.secondaryKeywords,
    searchIntent: article.searchIntent,
    seoTitle: article.seoTitle,
    metaDescription: article.metaDescription,
    suggestedSlug: article.suggestedSlug,
    h1: article.h1,
    internalLinks: article.internalLinks,
    cta: article.ctaMarkdown,
    image: {
      brief: article.imageBrief,
      recommendedDimensions: article.imageDimensions,
      suggestedFilename: article.suggestedImageFilename,
      altText: article.imageAltText,
      publicationStatus: 'brief-only-awaiting-approved-real-image'
    },
    blogExcerpt: article.blogExcerpt,
    socialMediaPost: article.socialMediaPost,
    'CODEX HANDOFF': article.codexHandoff,
    companyClaims: article.companyClaims,
    editorialAudit: { passed: true, issues: [] }
  };

  if (options.dryRun) {
    console.log(JSON.stringify({ type, date, slug: article.suggestedSlug, result, audit }, null, 2));
    return;
  }

  fs.writeFileSync(postFile, articleMarkdown(result, date), { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(handoffFile, `${JSON.stringify(handoff, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  history.posts.push(historyRecord);
  topics.topics.push(topicRecord);
  writeJsonAtomic(HISTORY_FILE, history);
  writeJsonAtomic(TOPICS_FILE, topics);
  console.log(`Generated ${type} draft: ${article.suggestedSlug}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `slug=${article.suggestedSlug}\ntitle=${topic.articleTitle}\ncategory=${type}\n`);
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(`Klinner blog generation failed: ${error.message}`);
    process.exit(1);
  });
}
