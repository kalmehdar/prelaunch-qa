# prelaunch-qa

A zero-dependency Node.js CLI that runs a 30-item pre-launch QA checklist
against any deployed website. No installs, no Puppeteer, no Chromium — pure
Node `https` + regex parsing. Built for the moment between "deployed to
production" and "told the client it's live."

## Why

When a small studio (or any solo dev) ships a new site, the last 15 minutes
of pre-launch checks are the most error-prone part of the day. You're tired,
you trust the staging build, and you forget to check the favicon. Then a
client emails the next morning asking why their site shows a placeholder
title in the browser tab.

This script automates the obvious-in-hindsight checks: SSL, redirects,
canonical URL, title/meta/og, alt tags, GDPR consent, exposed `.env`,
debug code leaks, page weight, response time, and 24 more.

It runs in about 8 seconds against a live site. The output is colour-coded
and actionable. Exits non-zero if any Critical or High check fails — wire
it into CI to gate "is this site really ready."

## Install

No install. Clone or download `prelaunch-qa.js` and run it with Node 18+.

```bash
curl -O https://raw.githubusercontent.com/kalmehdar/prelaunch-qa/main/prelaunch-qa.js
node prelaunch-qa.js https://example.com
```

## Usage

```bash
# Default: prints pass/fail per check, exits 0 on all green
node prelaunch-qa.js https://example.com

# JSON output for piping into CI / dashboards
node prelaunch-qa.js https://example.com --json

# Save a markdown report
node prelaunch-qa.js https://example.com --report=qa-report.md
```

## Configuration via env vars

| Variable | Default | Effect |
|---|---|---|
| `PRELAUNCH_NO_EMAILS` | `dev@,test@,admin@example` | Comma-separated email prefixes that should never appear in `mailto:` links. Catches dev/personal addresses that shouldn't ship. |
| `PRELAUNCH_FOOTER_CREDIT` | (unset) | Optional regex. If set, the script checks the footer contains a match. Use to assert your studio attribution stays on every build. |

## The 30 checks

| # | Check | Severity |
|---|---|---|
| 1 | SSL valid + HTTP -> HTTPS redirect | Critical |
| 2 | HTTPS canonical (not www / not http) | High |
| 3 | 200 on / and key paths | Critical |
| 4 | 404 page returns 404 (not soft-404) | High |
| 5 | robots.txt + sitemap.xml present | Medium |
| 6 | `<title>` set, <60 chars, not "Untitled" | High |
| 7 | `<meta name="description">` 50-160 chars | High |
| 8 | `<meta property="og:image">` absolute URL | Medium |
| 9 | `<link rel="canonical">` set | Medium |
| 10 | Viewport meta tag set | High |
| 11 | UTF-8 charset declared | Medium |
| 12 | JSON-LD present (LocalBusiness etc) | Low |
| 13 | All `<img>` have non-empty `alt` | High |
| 14 | No placeholder text in body (TBC/TBD/lorem) | High |
| 15 | Contact form action is real (not `#`) | Medium |
| 16 | No personal/dev email leaks | High |
| 17 | (Optional) studio attribution check | Low |
| 18 | /privacy, /terms, /cookies exist | Medium |
| 19 | No CSS/JS subresource 404s | High |
| 20 | Page weight under 1.5 MB | Medium |
| 21 | First byte under 1500ms | Medium |
| 22 | No exposed `.env` / `.git` / config paths | Critical |
| 23 | `<html lang="...">` set | Low |
| 24 | No `console.log` / `debugger` in inline JS | Medium |
| 25 | Cookie banner if tracking detected | High |
| 26 | OG + Twitter Card complete | Medium |
| 27 | Favicon at `/favicon.ico` | Low |
| 28 | GDPR consent on any data-collecting form | High |
| 29 | No placeholder `href="#"` links in nav | Medium |
| 30 | X-Forwarded-Proto HTTPS redirect note | Manual |

## Exit codes

- `0` — all green
- `1` — at least one Critical or High failed
- `2` — script error (network, malformed URL)

## In CI

```yaml
- name: Pre-launch QA
  run: |
    npx -y prelaunch-qa@latest https://your-site.com --json > qa.json || (cat qa.json; exit 1)
```

## License

MIT — see [LICENSE](LICENSE).

## Why does this exist

I run a small web studio. Every launch used to take ~75 minutes of clicking
around with DevTools open. Now it takes 8 seconds plus whatever the medium
items need. The tool pays for itself the second time you use it.

If you find a check that should be in the list, [open an issue](https://github.com/kalmehdar/prelaunch-qa/issues).
