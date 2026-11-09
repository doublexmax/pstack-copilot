# Publishing and measuring search discovery

The project overview is a standalone static page in `site/`. It has no JavaScript,
build dependencies, analytics, or third-party assets. The full guide stays in the
repository. Keep the page's installation steps consistent with `README.md`.

## Publish after merge

1. In repository Settings > Pages, select **GitHub Actions** as the publishing
   source. The `Deploy project page` workflow publishes only `site/` on relevant
   pushes to `main`; it never publishes a PR preview. Run it manually if Pages was
   enabled after the merge.
2. Check that `https://doublexmax.github.io/pstack-copilot/` returns HTTP 200,
   displays its content without JavaScript, and loads its stylesheet and links.
3. Set the repository About website to that URL. Suggested description:
   `Multi-agent engineering workflows, skills, and playbooks for GitHub Copilot, with Azure DevOps integration.`
   Suggested topics: `github-copilot`, `ai-agents`, `agent-skills`, `azure-devops`.
   These repository settings are not changed by merging a PR.
4. Link the published page from a public profile README or a relevant article
   where it helps readers. Avoid unrelated link drops or keyword stuffing.

## Verify with Google

1. In [Google Search Console](https://search.google.com/search-console), add the
   **URL-prefix** property `https://doublexmax.github.io/pstack-copilot/`.
   Do not use a Domain property: GitHub owns the `github.io` domain.
2. Choose HTML-tag verification. Add the exact `google-site-verification` meta tag
   Google supplies inside `site/index.html`'s `<head>`, deploy it, and click Verify.
   Keep the tag in place. This requires the maintainer's Google account; no
   placeholder token is included in the page.
3. Inspect the homepage URL and run **Test live URL**. Confirm successful fetch,
   crawling allowed, and indexing allowed. Check the actual host-level
   `https://doublexmax.github.io/robots.txt` for blocks: a `robots.txt` inside this
   project's subdirectory would not control crawling. A missing robots file
   returning 404 does not block crawling.
4. Submit `https://doublexmax.github.io/pstack-copilot/sitemap.xml` under Sitemaps,
   then request indexing of the homepage once. The sitemap lists only the
   canonical homepage, not source files or the verification tag.

The page's canonical URL points to itself, not GitHub: the landing page is a
distinct overview, not a second copy of the entire README. Search Console for the
Pages property cannot inspect or submit the `github.com` repository URL.

## Validate and measure

Run `node --test scripts/site.test.mjs` before publishing. CI also runs this test.
For a local preview, run `python3 -m http.server 8000 --directory site` and open
`http://localhost:8000/`. Local checks establish page structure, not Google's
ability or decision to index the deployed URL.

After deployment, record the live inspection result. Check weekly until the
indexed inspection says **URL is on Google**. After roughly a month, review
Search Console impressions, clicks, and queries. A live test passing, a sitemap
being accepted, or an indexing request being submitted is not proof of indexing.
An empty `site:` search is not definitive either.

If the page remains unindexed, use Search Console's reported reason to choose the
next fix instead of repeatedly submitting it. Add individual guide pages only
when reader needs or search data justify maintaining them.

Google [does not guarantee indexing](https://developers.google.com/search/docs/essentials/technical).
See its [ownership verification instructions](https://support.google.com/webmasters/answer/9008080)
and [URL Inspection documentation](https://support.google.com/webmasters/answer/9012289).
