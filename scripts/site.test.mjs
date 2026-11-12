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
  assert.match(readme, /^# pstack for GitHub Copilot\r?\n/);
  assert.ok(readme.includes(`](${canonical})`));
});

test('each section labels itself with its own heading', () => {
  const sections = [...html.matchAll(/<section\b[^>]*aria-labelledby="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)];
  assert.ok(sections.length > 0);
  for (const [, id, section] of sections) {
    assert.match(section, new RegExp(`<h2\\b[^>]*id="${id}"[^>]*>`), `Missing heading: ${id}`);
  }
});

test('navigation and introduction lead to Double before installation', () => {
  const nav = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/)[1];
  const intro = html.match(/<p class="intro">([\s\S]*?)<\/p>/)[1];
  assert.match(nav, /href="#double"/);
  assert.match(intro, /href="#double"/);
  assert.ok(html.includes('id="double"'));
  assert.ok(html.indexOf('id="double"') < html.indexOf('id="install"'));
  const workflows = html.match(/<section aria-labelledby="workflows">([\s\S]*?)<\/section>/)[1];
  assert.match(workflows, /class="eyebrow">Adapted from upstream/);
});

test('Double documents its provenance, verifier selection, and supervision limits', () => {
  const section = html.match(/<section aria-labelledby="double">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(section, 'Missing Double section');
  const text = section.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  for (const href of [
    'https://github.com/doublexmax',
    'https://github.com/doublexmax/pstack-copilot/blob/main/skills/double/SKILL.md',
    'https://github.com/doublexmax/pstack-copilot/blob/main/agents/double.agent.md',
    'https://github.com/cursor/plugins/tree/main/pstack',
    '#try-double',
  ]) {
    assert.ok(section.includes(`href="${href}"`), `Missing Double link: ${href}`);
  }
  assert.match(text, /@doublexmax/);
  assert.match(text, /custom addition/i);
  assert.match(text, /not (?:available )?in upstream/i);
  assert.match(text, /cursor\/plugins/);
  assert.match(text, /worker session/i);
  assert.match(text, /double verifier/);
  assert.match(text, /vendor family/i);
  assert.match(text, /model tokens/i);
  assert.match(text, /refutes/i);
  assert.match(text, /silence[^.]*not[^.]*approval/i);
  assert.doesNotMatch(html, /on another model family/i);
  const example = html.match(/<h3 id="try-double">[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/);
  assert.equal(example?.[1], '/double');
  const install = html.match(/<section aria-labelledby="install">([\s\S]*?)<\/section>/)[1];
  assert.match(install, /Python/);
  assert.match(install, /runtime extension/i);
});
