import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
      const [path, anchor] = href.slice(`${repository}/blob/main/`.length).split('#');
      const file = new URL(`../${path}`, site);
      assert.ok(existsSync(file), `Missing repository file: ${path}`);
      if (path === 'README.md' && anchor) {
        const headings = [...readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+([\w -]+)\r?$/gm)];
        assert.ok(headings.some(([, heading]) => heading.toLowerCase().replaceAll(' ', '-') === anchor),
          `Missing README section: ${anchor}`);
      }
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

test('README inventory matches the skill, playbook, principle, and agent files', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const skills = readdirSync(new URL('../skills/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  const playbooks = readdirSync(new URL('../skills/poteto-mode/playbooks/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'));
  const agents = readdirSync(new URL('../agents/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.agent.md'));
  const summary = readme.match(/(\d+) skills, (\d+) playbooks, (\d+) principles, and (\d+) agents\b/);
  assert.ok(summary, 'Missing package inventory summary');
  assert.deepEqual(summary.slice(1).map(Number), [
    skills.length, playbooks.length, skills.filter((entry) => entry.name.startsWith('principle-')).length, agents.length,
  ]);
  const installSection = readme.match(/(?:^|\n)## install\r?\n([\s\S]*?)(?:\r?\n## |$)/)?.[1] ?? '';
  for (const entry of agents) {
    const slug = entry.name.replace(/\.agent\.md$/, '');
    assert.ok(installSection.includes(`\`${slug}\``), `Install section must list agent ${slug}`);
  }
});

test('README all-skills table exposes the Steward skill', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const table = readme.match(/<summary>all skills<\/summary>([\s\S]*?)<\/details>/)?.[1];
  assert.ok(table, 'Missing all-skills table');
  assert.match(table, /^\| \[`\/steward`\]\(\.\/skills\/steward\/SKILL\.md\) \|/m);
});

test('guide overview covers stepping above poteto-mode with Steward', () => {
  const guideUrl = new URL('../docs/guide/README.md', import.meta.url);
  const guide = readFileSync(guideUrl, 'utf8');
  assert.match(guide, /^## Step above `\/poteto-mode` with `\/steward`\r?$/m);
  assert.match(guide, /copilot --agent steward/);
  assert.match(guide, /poteto-worker/);
  assert.match(guide, /skip steward/);
  assert.match(guide, /\]\(\.\/11-steward\.md\)/);
  for (const [, target] of guide.matchAll(/\]\((\.[^)#]+)\)/g)) {
    assert.ok(existsSync(new URL(target, guideUrl)), `Missing guide link target: ${target}`);
  }
});

test('Steward guide explains coordination and gives commands to copy', () => {
  const guideUrl = new URL('../docs/guide/11-steward.md', import.meta.url);
  const guide = readFileSync(guideUrl, 'utf8');
  const lines = guide.split(/\r?\n/);
  for (const responsibility of ['Outcome', 'Context and capability', 'Production commitments', 'Confidence']) {
    assert.ok(lines.includes(`### ${responsibility}`), `Missing Steward responsibility: ${responsibility}`);
  }
  for (const topic of [
    '<session_dir>/files/overview.md', 'open_canvas', 'poteto-worker', 'mode: "sync"', 'mode: "background"',
    'create_session', 'send_session_message', 'get_changes_overview', 'PSTACK_CONTEXT_V1',
    'arena cross-judge pool', 'rework critic', 'Double',
  ]) {
    assert.ok(guide.includes(topic), `Missing Steward guide topic: ${topic}`);
  }
  assert.match(guide, /^```mermaid\r?$/m);
  const examples = [...guide.matchAll(/^```(?:bash|text)\r?\n([\s\S]*?)^```\r?$/gm)]
    .flatMap(([, example]) => example.trimEnd().split(/\r?\n/));
  for (const command of [
    'copilot --agent steward', 'pstack --agent steward', '/steward', '/poteto-mode', 'skip steward', 'skip steward mode',
  ]) {
    assert.ok(examples.includes(command), `Missing Steward command example: ${command}`);
  }
  assert.ok(examples.some((line) => line.startsWith('/steward ')), 'Missing a Steward handoff prompt');
  assert.match(guide, /\]\(\.\/README\.md\)/);
  for (const [, target] of guide.matchAll(/\]\(([^)\s]+)\)/g)) {
    const url = new URL(target, guideUrl);
    if (url.protocol === 'file:') {
      assert.ok(existsSync(url), `Missing Steward guide link target: ${target}`);
    }
  }
});

test('README custom additions include Steward alongside Double', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const additions = readme.match(/(?:^|\n)### custom additions\r?\n([\s\S]*?)(?:\r?\n#{1,3} |$)/)?.[1];
  assert.ok(additions, 'Missing custom additions section');
  for (const slug of ['double', 'steward']) {
    assert.match(additions, new RegExp(`\\[\`?${slug}\`?\\]\\(\\./agents/${slug}\\.agent\\.md\\)`));
    assert.ok(additions.includes(`[\`/${slug}\`](./skills/${slug}/SKILL.md)`), `Missing /${slug} custom addition`);
  }
  assert.match(additions, /\[@doublexmax\]\(https:\/\/github\.com\/doublexmax\)/);
  assert.match(additions, /not (?:available )?in upstream/i);
  assert.match(additions, /\[`cursor\/plugins` `pstack`\]\(https:\/\/github\.com\/cursor\/plugins\/tree\/main\/pstack\)/);
});

test('each section labels itself with its own heading', () => {
  const sections = [...html.matchAll(/<section\b[^>]*aria-labelledby="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)];
  assert.ok(sections.length > 0);
  for (const [, id, section] of sections) {
    assert.match(section, new RegExp(`<h2\\b[^>]*id="${id}"[^>]*>`), `Missing heading: ${id}`);
  }
});

test('navigation and introduction lead to supervision and alignment before installation', () => {
  const nav = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/)[1];
  const intro = html.match(/<p class="intro">([\s\S]*?)<\/p>/)[1];
  for (const id of ['double', 'steward']) {
    assert.ok(nav.includes(`href="#${id}"`));
    assert.ok(intro.includes(`href="#${id}"`));
    assert.ok(html.indexOf(`id="${id}"`) < html.indexOf('id="install"'));
  }
  const description = html.match(/<meta name="description" content="([^"]+)">/)[1];
  assert.doesNotMatch(`${description} ${nav} ${intro}`.replace(/<[^>]*>/g, ''), /\b(?:double|steward)\b/i);
  const workflows = html.match(/<section aria-labelledby="workflows">([\s\S]*?)<\/section>/)[1];
  assert.match(workflows, /class="eyebrow">Adapted from upstream/);
});

test('capability sections send readers to detailed README instructions', () => {
  for (const [section, anchor] of [
    ['double', 'double-supervisor'],
    ['steward', 'steward-supervisor'],
    ['examples', 'attach-double'],
  ]) {
    const body = html.match(new RegExp(`<section aria-labelledby="${section}">([\\s\\S]*?)</section>`))?.[1];
    assert.ok(body?.includes(`/blob/main/README.md#${anchor}"`), `Missing README link in ${section}`);
  }
  const install = html.match(/<section aria-labelledby="install">([\s\S]*?)<\/section>/)[1];
  assert.match(install, /Python/);
  assert.match(install, /runtime extension/i);
});

test('README separates Double additions from upstream adaptations', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /\]\(#double-supervisor\)/);
  const double = readme.match(/(?:^|\n)## double supervisor\r?\n([\s\S]*?)(?:\r?\n## |$)/)?.[1];
  assert.ok(double, 'Missing Double supervisor section');
  assert.match(double, /^### attach double\r?$/m);
  assert.match(double, /\[@doublexmax\]\(https:\/\/github\.com\/doublexmax\)/);
  assert.match(double, /not (?:available )?in upstream/i);
  assert.match(double, /cursor\/plugins/);
  const steward = readme.match(/(?:^|\n)## steward supervisor\r?\n([\s\S]*?)(?:\r?\n## |$)/)?.[1];
  assert.ok(steward, 'Missing Steward supervisor section');
  assert.match(steward, /^### run steward\r?$/m);
  assert.match(steward, /poteto-worker/);
  assert.match(steward, /copilot --agent steward/);
  const upstream = readme.match(/(?:^|\n)## what changed from upstream\r?\n([\s\S]*?)(?:\r?\n## |$)/)[1];
  assert.match(upstream, /^### port adaptations\r?$/m);
  assert.match(upstream, /^### custom additions\r?$/m);
  assert.ok(upstream.indexOf('### port adaptations') < upstream.indexOf('### custom additions'));
  const additions = upstream.split('### custom additions')[1];
  assert.match(additions, /@doublexmax/);
  assert.match(additions, /not (?:available )?in upstream/i);
  assert.match(additions, /cursor\/plugins/);
  assert.match(additions, /\]\(\.\/docs\/upstream-sync\.md#local-only-files\)/);
  const alwaysOn = readme.match(/(?:^|\n)## always-on\r?\n([\s\S]*?)(?:\r?\n## |$)/)[1];
  assert.match(alwaysOn, /five user-scoped changes/);
  assert.match(alwaysOn, /~\/\.copilot\/extensions\/double\/extension\.mjs/);
  assert.match(alwaysOn, /`--uninstall`[^.]*double runtime extension/);
  assert.match(alwaysOn, /`--hooks skip`[^.]*double runtime extension[^.]*unchanged/);
  assert.match(alwaysOn, /`--hooks remove`[^.]*double runtime extension/);
  const skill = readme.split(/\r?\n/).find((line) => line.startsWith('| [`/double`]'));
  assert.match(skill, /prefer[^|]*vendor family/);
  assert.match(skill, /configured[^|]*pool/);
  assert.match(skill, /custom[^|]*@doublexmax/);
  assert.doesNotMatch(readme, /pstack also ships \[Double\]|on another model family/i);
});
