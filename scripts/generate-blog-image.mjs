#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE_LABEL = 'Illustrative AI-generated image. Not a photo of a Klinner project.';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--slug' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(argv[1])) {
    fail('Usage: node scripts/generate-blog-image.mjs --slug <blog-slug>');
  }
  return argv[1];
}

function yamlString(value) {
  return `"${String(value).replace(/"/g, "'").replace(/\r?\n/g, ' ')}"`;
}

function upsertFrontmatter(raw, values) {
  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?[\s\S]*)$/);
  if (!match) fail('Article is missing frontmatter');
  const lines = match[2].split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    const replacement = `${key}: ${yamlString(value)}`;
    if (index === -1) lines.push(replacement);
    else lines[index] = replacement;
  }
  return `${match[1]}${lines.join('\n')}${match[3]}`;
}

async function generate(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) fail('OPENAI_API_KEY is required');
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
      prompt,
      size: '1536x1024',
      quality: 'low',
      output_format: 'webp',
      output_compression: 82,
      moderation: 'auto',
      n: 1
    })
  });
  const data = await response.json();
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id');
    fail(`OpenAI image API error ${response.status}${requestId ? ` (request ${requestId})` : ''}: ${data.error?.message || 'unknown error'}`);
  }
  const encoded = data?.data?.[0]?.b64_json;
  if (!encoded) fail('OpenAI image API returned no image data');
  const image = Buffer.from(encoded, 'base64');
  if (image.length < 1024) fail('OpenAI image API returned an invalid image payload');
  return image;
}

async function main() {
  const slug = parseArgs(process.argv.slice(2));
  const articlePath = path.join(ROOT, 'content', 'blog', `${slug}.md`);
  const handoffPath = path.join(ROOT, 'content', 'blog', `${slug}.handoff.json`);
  if (!fs.existsSync(articlePath) || !fs.existsSync(handoffPath)) fail(`Article and handoff are required for ${slug}`);
  const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
  const brief = String(handoff.image?.brief || '').trim();
  const altText = String(handoff.image?.altText || '').trim();
  if (!brief || !altText) fail('Image brief and alt text are required');

  const prompt = `Create one photorealistic, generic editorial blog hero image. ${brief}

Safety and truthfulness constraints: this is an illustrative image only, not a real Klinner Cleaning & Maintenance job or a photo of any named company. Do not depict or imply a real customer, employee, property, address, or completed company project. No logos, uniforms, brand names, watermarks, text, signage, before-and-after panels, testimonials, or promotional claims. Use a clean, realistic 3:2 landscape composition suitable for a website article.`;
  const image = await generate(prompt);
  const filename = `${slug}-editorial.webp`;
  const relativeImage = `/images/blog/${filename}`;
  const outputPath = path.join(ROOT, 'images', 'blog', filename);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, image, { flag: 'wx' });

  const article = fs.readFileSync(articlePath, 'utf8');
  fs.writeFileSync(articlePath, upsertFrontmatter(article, {
    image: relativeImage,
    image_alt: altText,
    image_caption: IMAGE_LABEL
  }), 'utf8');

  handoff.image = {
    ...handoff.image,
    suggestedFilename: filename,
    path: relativeImage,
    assetType: 'AI-generated editorial illustration',
    disclosure: IMAGE_LABEL,
    publicationStatus: 'generated-editorial-image-awaiting-review'
  };
  fs.writeFileSync(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
  console.log(`Generated editorial image: ${relativeImage}`);
}

main().catch((error) => {
  console.error(`Klinner blog image generation failed: ${error.message}`);
  process.exit(1);
});
