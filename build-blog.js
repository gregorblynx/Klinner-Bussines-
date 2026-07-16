#!/usr/bin/env node
/* Klinner blog generator — zero dependencies.
   Reads content/blog/*.md, writes blog/index.html + blog/<slug>/index.html,
   and refreshes the blog entries in sitemap.xml between the BLOG markers.
   Usage: node build-blog.js */

'use strict';
const fs = require('fs');
const path = require('path');

const SITE = 'https://klinnercleaning.com';
const ROOT = __dirname;
const CONTENT_DIR = path.join(ROOT, 'content', 'blog');
const OUT_DIR = path.join(ROOT, 'blog');

/* ---------- frontmatter ---------- */
function parsePost(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${path.basename(file)}: missing frontmatter (--- block)`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  for (const req of ['title', 'date', 'description', 'slug']) {
    if (!meta[req]) throw new Error(`${path.basename(file)}: frontmatter is missing "${req}"`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) throw new Error(`${path.basename(file)}: date must be YYYY-MM-DD`);
  return { meta, body: m[2].trim() };
}

/* ---------- markdown (headings, lists, quotes, hr, bold/italic/code, links, images) ---------- */
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

function inline(s) {
  return s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/* ::pair <img-base> | <caption> | <img-base> | <caption>
   Renders a BEFORE/AFTER photo pair. img-base is the path without extension;
   .webp and .jpg versions must both exist (e.g. /images/blog/turnover-bathroom-before).
   ::duo works the same but without the BEFORE/AFTER badges. */
function picture(base, alt) {
  return `<picture><source srcset="${escAttr(base)}.webp" type="image/webp"><img src="${escAttr(base)}.jpg" alt="${escAttr(alt)}" loading="lazy"></picture>`;
}

function renderPairShortcode(t) {
  const m = t.match(/^::(pair|duo)\s+(.+)$/);
  if (!m) return null;
  const parts = m[2].split('|').map((s) => s.trim());
  if (parts.length !== 4) throw new Error(`::${m[1]} needs 4 fields separated by | — got: ${t}`);
  const [img1, cap1, img2, cap2] = parts;
  const badge = (kind) => m[1] === 'pair' ? `<span class="ba-badge ${kind}">${kind}</span>` : '';
  return `<div class="ba-grid">
<div class="ba-item">${badge('before')}${picture(img1, cap1)}<div class="ba-caption">${inline(esc(cap1))}</div></div>
<div class="ba-item">${badge('after')}${picture(img2, cap2)}<div class="ba-caption">${inline(esc(cap2))}</div></div>
</div>`;
}

function mdToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closePara = () => {
    if (para.length) { out.push(`<p>${inline(esc(para.join(' ')))}</p>`); para = []; }
  };

  for (const line of lines) {
    const t = line.trim();
    let m;
    if (!t) { closePara(); closeList(); continue; }
    if (t.startsWith('::')) {
      closePara(); closeList();
      const html = renderPairShortcode(t);
      if (!html) throw new Error(`Unknown shortcode: ${t}`);
      out.push(html);
    } else if ((m = t.match(/^(#{2,4})\s+(.*)$/))) {
      closePara(); closeList();
      const level = m[1].length;
      out.push(`<h${level}>${inline(esc(m[2]))}</h${level}>`);
    } else if (/^(---|\*\*\*)$/.test(t)) {
      closePara(); closeList();
      out.push('<hr>');
    } else if ((m = t.match(/^>\s?(.*)$/))) {
      closePara(); closeList();
      out.push(`<blockquote><p>${inline(esc(m[1]))}</p></blockquote>`);
    } else if ((m = t.match(/^[-*]\s+(.*)$/))) {
      closePara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(esc(m[1]))}</li>`);
    } else if ((m = t.match(/^\d+\.\s+(.*)$/))) {
      closePara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(esc(m[1]))}</li>`);
    } else if ((m = t.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/))) {
      closePara(); closeList();
      out.push(`<figure><img src="${m[2]}" alt="${escAttr(m[1])}" loading="lazy"></figure>`);
    } else {
      closeList();
      para.push(t);
    }
  }
  closePara(); closeList();
  return out.join('\n');
}

/* ---------- shared page chrome (matches service pages, root-absolute paths) ---------- */
function prettyDate(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[mo - 1]} ${d}, ${y}`;
}

const HEAD_COMMON = `  <link rel="icon" type="image/png" href="/favicon Klinner.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#1B2F6E">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Klinner">
  <meta name="robots" content="index, follow">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/service-page.css">
  <!-- klinner-analytics:start (IDs injected at build time from Vercel env vars — see docs/analytics-setup.md) -->
  <script>window.KLINNER_ANALYTICS_CONFIG={gaId:"__NEXT_PUBLIC_GA_MEASUREMENT_ID__",clarityId:"__NEXT_PUBLIC_CLARITY_PROJECT_ID__"};</script>
  <script src="/analytics.js" defer></script>
  <!-- klinner-analytics:end -->
  <script src="/phone-cta.js" defer></script>`;

const BLOG_CSS = `  <style>
    .blog-hero { background: linear-gradient(135deg, var(--navy), var(--navy-dark)); color: var(--white); padding: 84px 0 64px; }
    .blog-hero .breadcrumb { color: rgba(255,255,255,.76); }
    .blog-hero h1 { font-size: clamp(2rem, 5vw, 3.4rem); }
    .post-meta { color: rgba(255,255,255,.72); font-weight: 600; font-size: .95rem; }
    .post-wrap { max-width: 720px; margin: 0 auto; }
    .post-content { font-size: 1.05rem; line-height: 1.75; color: var(--gray-800); }
    .post-content h2 { color: var(--navy); font-size: 1.65rem; line-height: 1.25; margin: 42px 0 14px; }
    .post-content h3 { color: var(--navy); font-size: 1.25rem; margin: 32px 0 10px; }
    .post-content p { margin: 16px 0; }
    .post-content ul, .post-content ol { margin: 16px 0 16px 4px; padding-left: 0; }
    .post-content ul li, .post-content ol li { position: relative; padding-left: 28px; margin: 9px 0; color: var(--gray-800); list-style: none; }
    .post-content ul li::before { content: "✓"; position: absolute; left: 0; color: var(--teal-dark); font-weight: 800; }
    .post-content ol { counter-reset: postol; }
    .post-content ol li { counter-increment: postol; }
    .post-content ol li::before { content: counter(postol) "."; position: absolute; left: 0; color: var(--teal-dark); font-weight: 800; }
    .post-content a { color: var(--teal-dark); font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
    .post-content blockquote { border-left: 4px solid var(--teal); background: var(--off-white); padding: 14px 20px; border-radius: 0 8px 8px 0; margin: 20px 0; color: var(--gray-600); }
    .post-content figure { margin: 26px 0; border-radius: 8px; overflow: hidden; box-shadow: var(--shadow); }
    .post-content img { width: 100%; }
    .post-content hr { border: 0; border-top: 1px solid var(--gray-200); margin: 34px 0; }
    .ba-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 26px 0; }
    .ba-item { position: relative; border-radius: 8px; overflow: hidden; box-shadow: var(--shadow); background: var(--gray-100); }
    .ba-item img { width: 100%; aspect-ratio: 3 / 4; object-fit: cover; }
    .ba-badge { position: absolute; top: 12px; left: 12px; padding: 5px 13px; border-radius: 100px; font-size: .72rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--white); }
    .ba-badge.before { background: rgba(30,41,59,.85); }
    .ba-badge.after { background: var(--teal); }
    .ba-caption { padding: 12px 14px; font-size: .88rem; color: var(--gray-600); line-height: 1.45; }
    @media (max-width: 640px) { .ba-grid { gap: 12px; } .ba-caption { font-size: .8rem; padding: 10px 10px; } }
    .post-featured { border-radius: 8px; overflow: hidden; box-shadow: var(--shadow-lg); margin: -46px auto 40px; position: relative; z-index: 3; max-width: 720px; }
    .post-featured img { width: 100%; max-height: 420px; object-fit: cover; }
    .blog-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; margin-top: 38px; }
    .blog-card { background: var(--white); border: 1px solid var(--gray-200); border-radius: 8px; box-shadow: var(--shadow); overflow: hidden; display: flex; flex-direction: column; transition: .25s ease; }
    .blog-card:hover { transform: translateY(-4px); border-color: rgba(42,191,191,.45); }
    .blog-card .thumb { aspect-ratio: 16 / 9; overflow: hidden; background: var(--gray-100); }
    .blog-card .thumb img { width: 100%; height: 100%; object-fit: cover; }
    .blog-card .card-body { padding: 22px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
    .blog-card time { color: var(--teal-dark); font-weight: 800; font-size: .8rem; letter-spacing: .08em; text-transform: uppercase; }
    .blog-card h2 { color: var(--navy); font-size: 1.15rem; line-height: 1.35; }
    .blog-card p { color: var(--gray-600); font-size: .95rem; flex: 1; }
    .blog-card .read-more { color: var(--teal-dark); font-weight: 800; font-size: .9rem; }
    @media (max-width: 980px) { .blog-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 640px) { .blog-grid { grid-template-columns: 1fr; } .blog-hero { padding: 64px 0 52px; } }
  </style>`;

function nav(active) {
  const blogLink = active === 'blog' ? '<li><a href="/blog/" style="color:var(--teal-dark)">Blog</a></li>' : '<li><a href="/blog/">Blog</a></li>';
  return `  <nav class="site-nav">
    <div class="container nav-inner">
      <a href="/index.html" class="nav-logo">
        <picture><source srcset="/klinner-logo.webp" type="image/webp"><img src="/klinner-logo.png" class="logo-img" alt="Klinner Cleaning & Maintenance"></picture>
        <span><span class="logo-brand">Klinner<span>.</span></span><span class="logo-sub">Cleaning & Maintenance</span></span>
      </a>
      <ul class="nav-links">
        <li><a href="/index.html#services">Services</a></li><li><a href="/index.html#features">About</a></li><li><a href="/index.html#gallery">Gallery</a></li>${blogLink}<li><a href="/index.html#quote">Quote</a></li><li><a href="/index.html#contact-section">Contact</a></li>
      </ul>
      <div class="nav-actions"><a href="tel:+16156694072" class="nav-phone">(615) 669-4072</a><a href="/index.html#quote" class="btn btn-primary">Get Quote</a></div>
      <button class="hamburger" id="hamburger" aria-label="Menu"><span></span><span></span><span></span></button>
    </div>
    <div class="mobile-menu" id="mobileMenu">
      <a href="/index.html#services">Services</a>
      <a href="/index.html#features">About</a>
      <a href="/index.html#gallery">Gallery</a>
      <a href="/blog/">Blog</a>
      <a href="/index.html#quote">Quote</a>
      <a href="/index.html#contact-section">Contact</a>
      <div class="mobile-cta"><a href="/index.html#quote" class="btn btn-primary">Get Quote</a></div>
    </div>
  </nav>`;
}

const FOOTER = `  <footer class="footer"><div class="container"><div class="footer-grid"><div><picture><source srcset="/klinner-logo.webp" type="image/webp"><img src="/klinner-logo.png" class="logo-img" alt="Klinner Cleaning & Maintenance"></picture><p>Nashville's trusted cleaning and maintenance team.</p><p style="margin-top:8px;font-size:.85rem;display:flex;align-items:center;gap:8px"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>Licensed &amp; Insured — $1M General Liability</p></div><div><div class="footer-title">Quick Links</div><ul class="footer-links"><li><a href="/index.html#services">Services</a></li><li><a href="/index.html#features">About Us</a></li><li><a href="/blog/">Blog</a></li><li><a href="/index.html#quote">Get a Quote</a></li></ul></div><div><div class="footer-title">Services</div><ul class="footer-links"><li><a href="/airbnb-cleaning.html">Airbnb Cleaning</a></li><li><a href="/move-in-cleaning.html">Move-In Cleaning</a></li><li><a href="/move-out-cleaning.html">Move-Out Cleaning</a></li><li><a href="/deep-cleaning.html">Deep Cleaning</a></li><li><a href="/recurring-cleaning.html">Recurring Cleaning</a></li><li><a href="/handyman-services.html">Basic Handyman</a></li></ul></div><div><div class="footer-title">Contact</div><ul class="footer-links"><li><a href="tel:+16156694072">(615) 669-4072</a></li><li><a href="mailto:klinnercleaning@gmail.com">klinnercleaning@gmail.com</a></li><li><span>Nashville, TN &amp; Metro Area</span></li></ul></div></div><div class="footer-bottom"><p>&copy; 2025 Klinner Cleaning & Maintenance. All rights reserved.</p><div class="footer-legal"><a href="/privacy.html">Privacy Policy</a><a href="/terms.html">Terms of Service</a></div></div></div></footer>
  <script src="/nav-menu.js" defer></script>
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
    }
  </script>
  <script src="/pwa-install.js" defer></script>`;

/* ---------- post page ---------- */
function renderPost(post) {
  const { meta } = post;
  const url = `${SITE}/blog/${meta.slug}/`;
  const image = meta.image ? `${SITE}${meta.image}` : `${SITE}/og-image.jpg`;
  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: meta.title,
    description: meta.description,
    image,
    datePublished: meta.date,
    dateModified: meta.date,
    mainEntityOfPage: url,
    author: { '@type': 'Organization', name: 'Klinner Cleaning & Maintenance', url: SITE },
    publisher: {
      '@type': 'Organization',
      name: 'Klinner Cleaning & Maintenance',
      logo: { '@type': 'ImageObject', url: `${SITE}/klinner-logo.png` }
    }
  });

  const featured = meta.image
    ? `  <div class="container"><div class="post-featured"><img src="${escAttr(meta.image)}" alt="${escAttr(meta.image_alt || meta.title)}"></div></div>\n`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escAttr(meta.description)}">
  <title>${esc(meta.seo_title || meta.title)} | Klinner Cleaning</title>
${meta.keywords ? `  <meta name="keywords" content="${escAttr(meta.keywords)}">\n` : ''}  <link rel="canonical" href="${url}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Klinner Cleaning &amp; Maintenance">
  <meta property="og:title" content="${escAttr(meta.title)}">
  <meta property="og:description" content="${escAttr(meta.description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${escAttr(image)}">
  <meta property="article:published_time" content="${meta.date}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escAttr(meta.title)}">
  <meta name="twitter:description" content="${escAttr(meta.description)}">
  <meta name="twitter:image" content="${escAttr(image)}">
${HEAD_COMMON}
${BLOG_CSS}
  <script type="application/ld+json">
  ${jsonld}
  </script>
</head>
<body>
${nav('blog')}
  <header class="blog-hero">
    <div class="container">
      <div class="post-wrap">
        <div class="breadcrumb"><a href="/index.html">Home</a><span>/</span><a href="/blog/">Blog</a><span>/</span><span>${esc(meta.title)}</span></div>
        <h1>${esc(meta.title)}</h1>
        <p class="post-meta">Published ${prettyDate(meta.date)} · Klinner Cleaning &amp; Maintenance</p>
      </div>
    </div>
  </header>
${featured}  <main>
    <div class="container">
      <article class="post-wrap post-content">
${mdToHtml(post.body)}
      </article>
    </div>
    <section class="cta-band" style="margin-top:70px">
      <div class="container">
        <h2 class="section-title">Need reliable cleaning in Nashville?</h2>
        <p class="section-copy">Tell us about your home or rental property. We will respond with a custom quote.</p>
        <a href="/index.html#quote" class="btn btn-primary">Request Free Quote</a>
      </div>
    </section>
  </main>
${FOOTER}
</body>
</html>
`;
}

/* ---------- index page ---------- */
function renderIndex(posts) {
  const cards = posts.map((p) => {
    const thumb = p.meta.image
      ? `<div class="thumb"><img src="${escAttr(p.meta.image)}" alt="${escAttr(p.meta.title)}" loading="lazy"></div>`
      : '';
    return `        <a class="blog-card" href="/blog/${p.meta.slug}/">
          ${thumb}
          <div class="card-body">
            <time datetime="${p.meta.date}">${prettyDate(p.meta.date)}</time>
            <h2>${esc(p.meta.title)}</h2>
            <p>${esc(p.meta.excerpt || p.meta.description)}</p>
            <span class="read-more">Read article →</span>
          </div>
        </a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Cleaning tips, Airbnb turnover guides and home care advice for Nashville homeowners and short-term rental hosts, from the Klinner Cleaning team.">
  <title>Cleaning Tips &amp; Airbnb Host Guides | Klinner Cleaning Blog</title>
  <link rel="canonical" href="${SITE}/blog/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Klinner Cleaning &amp; Maintenance">
  <meta property="og:title" content="Cleaning Tips &amp; Airbnb Host Guides | Klinner Cleaning Blog">
  <meta property="og:description" content="Cleaning tips, Airbnb turnover guides and home care advice for Nashville homeowners and short-term rental hosts.">
  <meta property="og:url" content="${SITE}/blog/">
  <meta property="og:image" content="${SITE}/og-image.jpg">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Cleaning Tips &amp; Airbnb Host Guides | Klinner Cleaning Blog">
  <meta name="twitter:description" content="Cleaning tips and Airbnb turnover guides for Nashville hosts.">
  <meta name="twitter:image" content="${SITE}/og-image.jpg">
${HEAD_COMMON}
${BLOG_CSS}
</head>
<body>
${nav('blog')}
  <header class="blog-hero">
    <div class="container">
      <div class="breadcrumb"><a href="/index.html">Home</a><span>/</span><span>Blog</span></div>
      <span class="eyebrow">Klinner Blog</span>
      <h1>Cleaning Tips &amp; Host Guides</h1>
      <p class="post-meta" style="max-width:640px">Practical cleaning advice for Nashville homeowners and short-term rental hosts — from the team that cleans them every day.</p>
    </div>
  </header>
  <main>
    <section>
      <div class="container">
        <div class="blog-grid">
${cards}
        </div>
      </div>
    </section>
    <section class="cta-band">
      <div class="container">
        <h2 class="section-title">Need reliable cleaning in Nashville?</h2>
        <p class="section-copy">Tell us about your home or rental property. We will respond with a custom quote.</p>
        <a href="/index.html#quote" class="btn btn-primary">Request Free Quote</a>
      </div>
    </section>
  </main>
${FOOTER}
</body>
</html>
`;
}

/* ---------- sitemap ---------- */
function updateSitemap(posts) {
  const file = path.join(ROOT, 'sitemap.xml');
  let xml = fs.readFileSync(file, 'utf8');
  // Use the newest publication date so a no-op rebuild does not create a
  // timezone-dependent sitemap diff.
  const today = posts[0]?.meta.date || new Date().toISOString().slice(0, 10);
  const entries = [
    `  <!-- BLOG:START (managed by build-blog.js — do not edit between markers) -->`,
    `  <url>\n    <loc>${SITE}/blog/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`,
    ...posts.map((p) =>
      `  <url>\n    <loc>${SITE}/blog/${p.meta.slug}/</loc>\n    <lastmod>${p.meta.date}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`),
    `  <!-- BLOG:END -->`
  ].join('\n');

  if (xml.includes('<!-- BLOG:START')) {
    xml = xml.replace(/[ \t]*<!-- BLOG:START[\s\S]*?<!-- BLOG:END -->/, entries);
  } else {
    xml = xml.replace('</urlset>', `${entries}\n</urlset>`);
  }
  fs.writeFileSync(file, xml);
}

/* ---------- main ---------- */
function main() {
  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.md'));
  if (!files.length) { console.error('No .md files found in content/blog/'); process.exit(1); }

  const posts = files.map((f) => parsePost(path.join(CONTENT_DIR, f)));
  const slugs = new Set();
  for (const p of posts) {
    if (slugs.has(p.meta.slug)) throw new Error(`Duplicate slug: ${p.meta.slug}`);
    slugs.add(p.meta.slug);
  }
  posts.sort((a, b) => b.meta.date.localeCompare(a.meta.date));

  for (const p of posts) {
    const dir = path.join(OUT_DIR, p.meta.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), renderPost(p));
    console.log(`✓ blog/${p.meta.slug}/index.html`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), renderIndex(posts));
  console.log('✓ blog/index.html');
  updateSitemap(posts);
  console.log('✓ sitemap.xml updated');
  console.log(`\nDone — ${posts.length} post(s) published.`);
}

main();
