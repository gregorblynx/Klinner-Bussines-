# How to Publish a Blog Post

The blog is generated from Markdown files. You write a `.md` file, run one command, and commit. No frameworks, no dependencies — just Node (already on your Mac).

## 1. Create the post file

Add a new file in `content/blog/`, named after your post slug:

```
content/blog/my-new-post.md
```

Start the file with this frontmatter template, then write the article below it in Markdown:

```markdown
---
title: "Your Post Title Here"
date: 2026-07-15
description: "One or two sentences used as the excerpt on the blog index and as the SEO meta description (aim for ~150 characters)."
slug: my-new-post
image: /servicios/airbnb-cleaning-gallery/airbnb-02.jpg
keywords: optional, comma separated, seo keywords
---

Intro paragraph...

## A Section Heading

- A checklist item
- Another item

**Bold text**, *italic text*, and [a link](/index.html#quote).
```

Field notes:

- `title`, `date` (YYYY-MM-DD), `description`, `slug` are **required** — the build fails with a clear error if one is missing.
- `slug` becomes the URL: `https://klinnercleaning.com/blog/my-new-post/`. Use lowercase words separated by hyphens. Never change it after publishing (it would break the URL).
- `image` (optional) is the featured image + social share image. Use a path starting with `/` to an image already in the repo, or add a new `.jpg`/`.webp` to the repo first.
- `keywords` (optional) — a few comma-separated search phrases.
- Supported Markdown: `##`/`###` headings, paragraphs, `-` bullet lists, `1.` numbered lists, `**bold**`, `*italic*`, `[links](url)`, `![images](/path.jpg)`, `>` quotes, `---` dividers.

### Before/after photo pairs

For side-by-side photos, use the `::pair` shortcode (adds BEFORE/AFTER badges) or `::duo` (no badges), on its own line:

```
::pair /images/blog/my-before | Caption for the before photo | /images/blog/my-after | Caption for the after photo
```

The image paths go **without extension** — both a `.jpg` and a `.webp` with that name must exist in the repo. To prepare web-sized versions of new photos (resize + jpg + webp), ask Claude to process them into `images/blog/`.

## 2. Generate the pages

From the repo folder, run:

```bash
cd ~/Desktop/klinner-deploy
node build-blog.js
```

This regenerates:

- `blog/index.html` — the blog home, newest post first
- `blog/<slug>/index.html` — one page per post
- `sitemap.xml` — blog URLs are refreshed between the `BLOG:START` / `BLOG:END` markers (the rest of the sitemap is never touched)

## 3. Preview locally (optional but recommended)

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000/blog/ in your browser. Press `Ctrl+C` in the terminal to stop the server.

## 4. Publish

```bash
git add content/blog/my-new-post.md blog/ sitemap.xml
git commit -m "Add blog post: Your Post Title"
git push origin main
```

Vercel deploys automatically in 1–2 minutes. Done.

## Editing or removing a post

- **Edit:** change the `.md` file, run `node build-blog.js` again, commit and push.
- **Remove:** delete the `.md` file **and** its generated folder `blog/<slug>/`, run `node build-blog.js`, commit and push.
