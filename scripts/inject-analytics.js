#!/usr/bin/env node
/* =====================================================================
   Klinner — build-time analytics ID injection
   ---------------------------------------------------------------------
   This static site has no framework, so there is no automatic build-time
   env-var inlining (like Next.js "NEXT_PUBLIC_*" vars). This script does
   that job: it walks every .html file and replaces the placeholder tokens
   in the committed analytics <head> block with the real IDs read from
   Vercel environment variables.

       __NEXT_PUBLIC_GA_MEASUREMENT_ID__   ->  process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID
       __NEXT_PUBLIC_CLARITY_PROJECT_ID__  ->  process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID

   It runs on Vercel via the "buildCommand" in vercel.json. Because IDs
   only ever exist in the build environment, no IDs are committed to git.

   SAFETY CONTRACT — this script must never break a deploy:
     * It always exits 0, even on an unexpected error. Analytics is not
       worth taking the website down for. Worst case, tokens stay
       unreplaced and analytics.js silently disables itself.
     * Missing env vars are a warning, never an error.
     * It only ever touches .html files containing our own tokens.

   NOTE: Running this locally will bake whatever is in your shell env into
   your working-tree HTML files. Normally you do NOT run this by hand;
   Vercel runs it automatically on every deploy.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const GA_TOKEN = '__NEXT_PUBLIC_GA_MEASUREMENT_ID__';
const CLARITY_TOKEN = '__NEXT_PUBLIC_CLARITY_PROJECT_ID__';

// Directories we never walk. Compared case-insensitively and trimmed,
// because one of these really is named "PHOTOS WORK " (trailing space).
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.vercel', '.github', '.claude',
  'photos work', 'blog photos', 'prospeccion'
]);

function shouldSkipDir(name) {
  return name.startsWith('.') || SKIP_DIRS.has(name.trim().toLowerCase());
}

function walk(dir, out) {
  out = out || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[analytics] skipped unreadable dir ${dir}: ${err.message}`);
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const GA = (process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || '').trim();
  const CLARITY = (process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID || '').trim();

  // Warn loudly on a likely misconfiguration, but never fail the build.
  if (!GA) {
    console.warn('[analytics] WARNING: NEXT_PUBLIC_GA_MEASUREMENT_ID is not set — Google Analytics will stay OFF.');
  } else if (!/^G-[A-Z0-9]+$/i.test(GA)) {
    console.warn(`[analytics] WARNING: NEXT_PUBLIC_GA_MEASUREMENT_ID ("${GA}") does not look like a GA4 ID (expected "G-XXXXXXXXXX").`);
  }
  if (!CLARITY) {
    console.warn('[analytics] WARNING: NEXT_PUBLIC_CLARITY_PROJECT_ID is not set — Microsoft Clarity will stay OFF.');
  } else if (!/^[a-z0-9]+$/i.test(CLARITY)) {
    console.warn(`[analytics] WARNING: NEXT_PUBLIC_CLARITY_PROJECT_ID ("${CLARITY}") does not look like a Clarity project ID.`);
  }

  const files = walk(process.cwd());
  let changed = 0;
  for (const file of files) {
    try {
      const html = fs.readFileSync(file, 'utf8');
      if (!html.includes(GA_TOKEN) && !html.includes(CLARITY_TOKEN)) continue;
      const updated = html.split(GA_TOKEN).join(GA).split(CLARITY_TOKEN).join(CLARITY);
      if (updated !== html) {
        fs.writeFileSync(file, updated);
        changed++;
      }
    } catch (err) {
      // One bad file must not stop the rest, and must not fail the build.
      console.warn(`[analytics] WARNING: could not process ${file}: ${err.message}`);
    }
  }

  console.log(
    `[analytics] GA=${GA ? 'set' : 'OFF'}  Clarity=${CLARITY ? 'set' : 'OFF'}  ` +
    `-> updated ${changed}/${files.length} HTML file(s)`
  );
}

try {
  main();
} catch (err) {
  // Absolute last resort: never take the site down over analytics.
  console.warn('[analytics] WARNING: injection failed, continuing deploy without analytics.');
  console.warn(err && err.stack ? err.stack : err);
}
process.exit(0);
