import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const site = new URL('../site/', import.meta.url);
const html = readFileSync(new URL('index.html', site), 'utf8');
const canonical = 'https://doublexmax.github.io/pstack-copilot/';

test('project page contains indexable content and canonical metadata', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>pstack for GitHub Copilot \| Multi-agent engineering workflows<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{50,200}">/);
  assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`));
  assert.equal((html.match(/rel="canonical"/g) ?? []).length, 1);
  assert.equal((html.match(/<h1>/g) ?? []).length, 1);
  assert.match(html, /<h1>pstack for GitHub Copilot<\/h1>/);
  assert.doesNotMatch(html, /noindex|<script\b/i);
  assert.match(html, /copilot skill add/);
  assert.match(html, /install-always-on\.mjs --dry-run/);
  assert.match(html, /\/setup-pstack/);
  assert.match(html, /Reproduce it first/);
  assert.match(html, /review this PR/);
});

test('page links resolve to local assets, sections, or existing repository paths', () => {
  const repository = 'https://github.com/doublexmax/pstack-copilot';
  for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
    if (href.startsWith('#')) {
      assert.ok(html.includes(`id="${href.slice(1)}"`), `Missing section: ${href}`);
    } else if (href.startsWith(`${repository}/blob/main/`)) {
      const path = href.slice(`${repository}/blob/main/`.length);
      assert.ok(existsSync(new URL(`../${path}`, site)), `Missing repository file: ${path}`);
    } else if (!href.startsWith('https://')) {
      assert.ok(existsSync(new URL(href, site)), `Missing asset: ${href}`);
    }
  }
  assert.ok(html.includes(`href="${repository}"`));
  assert.match(html, /href="style\.css"/);
});

test('sitemap lists only the canonical public page', () => {
  const sitemap = readFileSync(new URL('sitemap.xml', site), 'utf8');
  assert.match(sitemap, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]), [canonical]);
});

test('README links to the public project overview', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /^# pstack for GitHub Copilot\n/);
  assert.ok(readme.includes(`](${canonical})`));
});
