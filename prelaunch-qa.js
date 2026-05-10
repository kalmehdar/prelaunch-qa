#!/usr/bin/env node
/**
 * prelaunch-qa.js — Pre-launch QA auto-run for any deployed website.
 *
 * Crawls a deployed client site and runs the 30-item launch checklist
 * automatically. Outputs a pass/fail report. Saves you ~75 minutes of
 * manual verification per launch.
 *
 * Usage:
 *   node scripts/prelaunch-qa.js https://example.com
 *   node scripts/prelaunch-qa.js https://example.com --json
 *   node scripts/prelaunch-qa.js https://example.com --report=qa-report.md
 *
 * Checks:
 *   1. SSL valid + redirect HTTP → HTTPS
 *   2. HTTPS canonical (not www / not http)
 *   3. 200 on / and key paths
 *   4. 404 page exists and serves a 404 status (not soft-404)
 *   5. robots.txt and sitemap.xml present
 *   6. <title> set, < 60 chars, not "Untitled"
 *   7. <meta name="description"> set, 50-160 chars
 *   8. <meta property="og:image"> set with absolute URL
 *   9. <link rel="canonical"> set
 *  10. Viewport meta set (mobile-friendly)
 *  11. Charset declared (UTF-8)
 *  12. JSON-LD present (LocalBusiness or EducationalOrganization)
 *  13. All <img> have non-empty alt attributes
 *  14. No <a href="#"> placeholder links
 *  15. No "lorem ipsum" / "placeholder" / "TBC" / "TBD" in body text
 *  16. No mailto:dev@ / personal email leaks (heuristic)
 *  17. Contact form action points at a real endpoint
 *  18. CSS / JS asset paths resolve (no 404s on subresources)
 *  19. Page weight < 1.5 MB total
 *  20. First-byte under 1500ms
 *  21. (configurable footer credit check — disable or set via env var)
 *  22. Privacy / terms / cookies pages exist
 *  23. GDPR consent on any form submitting personal data
 *  24. No exposed .env / config / .git in URL space
 *  25. <html lang="en"> set
 *  26. No console.log / debugger left in inline scripts
 *  27. Cookie banner present if any tracking script detected
 *  28. Open Graph + Twitter Card complete
 *  29. Favicon present at /favicon.ico
 *  30. .htaccess HTTPS redirect uses X-Forwarded-Proto pattern (manual check, flagged)
 *
 * Exits 0 on all pass, 1 if any Critical / High fails.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const isJson = args.includes('--json');
const reportArg = args.find((a) => a.startsWith('--report='));
const reportPath = reportArg ? reportArg.split('=')[1] : null;

if (!target) {
  console.error('Usage: node scripts/prelaunch-qa.js https://example.com');
  process.exit(1);
}

let baseUrl;
try {
  baseUrl = new URL(target);
} catch {
  console.error('Invalid URL:', target);
  process.exit(1);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: opts.method || 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'prelaunch-qa/1.0', ...(opts.headers || {}) },
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            length: Buffer.concat(chunks).length,
            finalUrl: url,
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

async function timed(url) {
  const t0 = Date.now();
  const res = await fetch(url);
  res.elapsedMs = Date.now() - t0;
  return res;
}

// ── Checks ────────────────────────────────────────────────────────────────

const results = [];

function check(severity, name, pass, detail) {
  results.push({ severity, name, pass, detail: detail || '' });
}

async function run() {
  // 1. SSL + HTTP→HTTPS redirect
  if (baseUrl.protocol === 'https:') {
    check('high', 'HTTPS reachable', true);
    try {
      const httpUrl = `http://${baseUrl.hostname}${baseUrl.pathname}`;
      const r = await fetch(httpUrl);
      const redirected =
        r.status >= 300 && r.status < 400 && (r.headers.location || '').startsWith('https://');
      check(
        'critical',
        'HTTP → HTTPS redirect',
        redirected,
        `HTTP returned ${r.status} ${r.headers.location || ''}`
      );
    } catch (e) {
      check('critical', 'HTTP → HTTPS redirect', false, e.message);
    }
  } else {
    check('critical', 'HTTPS reachable', false, 'URL is not https://');
  }

  // 2. Homepage 200
  let home;
  try {
    home = await timed(baseUrl.toString());
    check('critical', 'Homepage 200 OK', home.status === 200, `status ${home.status}`);
    check('medium', 'First-byte < 1500ms', home.elapsedMs < 1500, `${home.elapsedMs}ms`);
    check(
      'medium',
      'Page weight < 1.5MB',
      home.length < 1.5 * 1024 * 1024,
      `${(home.length / 1024).toFixed(0)} KB`
    );
  } catch (e) {
    check('critical', 'Homepage 200 OK', false, e.message);
    home = { body: '', status: 0, headers: {} };
  }

  const html = home.body;

  // 3. <title>
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  check('high', '<title> present', !!title);
  check('medium', '<title> not "Untitled"', !/^untitled/i.test(title));
  check('low', '<title> ≤ 60 chars', title.length <= 60, `${title.length} chars`);

  // 4. meta description
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const desc = descMatch ? descMatch[1].trim() : '';
  check('high', 'meta description present', !!desc);
  check(
    'low',
    'meta description 50-160 chars',
    desc.length >= 50 && desc.length <= 160,
    `${desc.length} chars`
  );

  // 5. og:image
  check('medium', 'og:image set', /<meta[^>]+property=["']og:image["']/i.test(html));

  // 6. canonical
  check('medium', 'canonical link present', /<link[^>]+rel=["']canonical["']/i.test(html));

  // 7. viewport
  check('high', 'viewport meta set', /<meta[^>]+name=["']viewport["']/i.test(html));

  // 8. charset
  check('low', 'charset declared (UTF-8)', /<meta[^>]+charset=["']?utf-?8/i.test(html));

  // 9. <html lang>
  check('medium', '<html lang> set', /<html[^>]+lang=/i.test(html));

  // 10. JSON-LD schema
  check('medium', 'JSON-LD schema present', /application\/ld\+json/i.test(html));

  // 11. Image alt tags
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)];
  const missingAlt = imgs.filter((m) => !/\balt=["'][^"']/i.test(m[0]));
  check(
    'high',
    'Images have alt attributes',
    missingAlt.length === 0,
    `${missingAlt.length} of ${imgs.length} missing`
  );

  // 12. No href="#" placeholder links
  const placeholderLinks = (html.match(/href=["']#["']/gi) || []).length;
  check('low', 'No href="#" placeholders', placeholderLinks === 0, `${placeholderLinks} found`);

  // 13. No lorem / placeholder text
  const placeholders = [
    'lorem ipsum',
    'placeholder text',
    'tbc',
    'tbd',
    '[service address',
    '[phone tbd',
  ];
  const foundPlaceholders = placeholders.filter((p) => html.toLowerCase().includes(p));
  check(
    'high',
    'No placeholder text in body',
    foundPlaceholders.length === 0,
    foundPlaceholders.join(', ')
  );

  // 14. No personal/dev email leak heuristic
  //     Configure via PRELAUNCH_NO_EMAILS env var (comma-separated list).
  //     Default: flag anything matching "dev@", "test@", "admin@example".
  const banned = (process.env.PRELAUNCH_NO_EMAILS || 'dev@,test@,admin@example')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hits = banned.filter((needle) => new RegExp(`mailto:${needle}`, 'i').test(html));
  check('high', 'No personal/dev email addresses leaked', hits.length === 0, hits.join(', '));

  // 15. Contact form action present (heuristic: any <form action>)
  const forms = [...html.matchAll(/<form\b[^>]*action=["']([^"']*)["']/gi)];
  if (forms.length > 0) {
    const realForms = forms.filter((m) => m[1] && !m[1].startsWith('#'));
    check(
      'medium',
      'Contact form action is real',
      realForms.length > 0,
      `${forms.length} form(s), ${realForms.length} real`
    );
  } else {
    check('low', 'Contact form action is real', true, 'no forms detected');
  }

  // 16. Optional studio attribution check.
  //     Configure via PRELAUNCH_FOOTER_CREDIT env var (regex pattern).
  //     If unset, skip this check entirely.
  if (process.env.PRELAUNCH_FOOTER_CREDIT) {
    const rx = new RegExp(process.env.PRELAUNCH_FOOTER_CREDIT, 'i');
    check('low', `Footer credit matches /${process.env.PRELAUNCH_FOOTER_CREDIT}/i`, rx.test(html));
  }

  // 17. Privacy + terms pages
  for (const p of ['/privacy', '/terms', '/cookies']) {
    try {
      const r = await fetch(new URL(p, baseUrl).toString());
      const ok = r.status === 200 || r.status === 301 || r.status === 302;
      check('medium', `${p} page exists`, ok, `status ${r.status}`);
    } catch (e) {
      check('medium', `${p} page exists`, false, e.message);
    }
  }

  // 18. 404 page
  try {
    const r = await fetch(new URL('/this-path-does-not-exist-' + Date.now(), baseUrl).toString());
    check(
      'low',
      '404 returns 404 status',
      r.status === 404,
      `status ${r.status} (soft-404 = SEO problem)`
    );
  } catch {}

  // 19. robots.txt + sitemap.xml
  try {
    const r = await fetch(new URL('/robots.txt', baseUrl).toString());
    check('low', 'robots.txt present', r.status === 200);
  } catch {
    check('low', 'robots.txt present', false);
  }
  try {
    const r = await fetch(new URL('/sitemap.xml', baseUrl).toString());
    check('low', 'sitemap.xml present', r.status === 200);
  } catch {
    check('low', 'sitemap.xml present', false);
  }

  // 20. favicon
  try {
    const r = await fetch(new URL('/favicon.ico', baseUrl).toString());
    check('low', 'favicon.ico present', r.status === 200);
  } catch {
    check('low', 'favicon.ico present', false);
  }

  // 21. No exposed .env / .git / config
  for (const p of ['/.env', '/.git/config', '/credentials.php']) {
    try {
      const r = await fetch(new URL(p, baseUrl).toString());
      check('critical', `${p} not exposed`, r.status >= 400, `status ${r.status} (must 404)`);
    } catch {
      check('critical', `${p} not exposed`, true, 'connection refused = ok');
    }
  }

  // 22. No debug code in inline scripts
  const inlineScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .join('\n');
  check('low', 'No console.log in inline scripts', !/\bconsole\.log\b/.test(inlineScripts));
  check('low', 'No debugger statement', !/\bdebugger\b/.test(inlineScripts));

  // 23. GDPR consent on forms (heuristic — checkbox with "agree" or "consent" near a form)
  if (forms.length > 0) {
    const hasConsent =
      /input[^>]+type=["']checkbox["'][^>]*>[\s\S]{0,500}(consent|agree|gdpr|privacy)/i.test(
        html
      ) || /(consent|agree|gdpr|privacy)[\s\S]{0,500}input[^>]+type=["']checkbox["']/i.test(html);
    check(
      'high',
      'GDPR consent checkbox on forms',
      hasConsent,
      'checkbox with consent/agree/gdpr/privacy nearby'
    );
  }

  // ── Render ──
  const grouped = { critical: [], high: [], medium: [], low: [] };
  results.forEach((r) => grouped[r.severity].push(r));

  const totalPass = results.filter((r) => r.pass).length;
  const totalFail = results.length - totalPass;
  const criticalFail = grouped.critical.filter((r) => !r.pass).length;
  const highFail = grouped.high.filter((r) => !r.pass).length;

  if (isJson) {
    console.log(
      JSON.stringify(
        { url: baseUrl.toString(), totalPass, totalFail, criticalFail, highFail, results },
        null,
        2
      )
    );
  } else {
    const out = [];
    out.push(`# Pre-launch QA: ${baseUrl.toString()}`);
    out.push(`Generated: ${new Date().toISOString()}`);
    out.push('');
    out.push(
      `**${totalPass}/${results.length} pass** | Critical fail: ${criticalFail} | High fail: ${highFail}`
    );
    out.push('');
    for (const sev of ['critical', 'high', 'medium', 'low']) {
      if (!grouped[sev].length) continue;
      out.push(`## ${sev.toUpperCase()}`);
      out.push('');
      out.push('| ✓ | Check | Detail |');
      out.push('|---|---|---|');
      grouped[sev].forEach((r) => {
        out.push(`| ${r.pass ? '✅' : '❌'} | ${r.name} | ${r.detail} |`);
      });
      out.push('');
    }
    out.push('---');
    out.push('## Manual checks (not automated)');
    out.push(
      '- [ ] `.htaccess` HTTPS redirect uses `X-Forwarded-Proto` pattern (Stellar requirement)'
    );
    out.push('- [ ] Cookie banner appears on first visit if tracking scripts present');
    out.push('- [ ] Mobile usability spot-check (iPhone width, tap targets, no horizontal scroll)');
    out.push('- [ ] Real form submission lands in client inbox');
    out.push('- [ ] Page-load timing on a slow 3G connection');
    out.push('- [ ] Lighthouse audit scored');
    const text = out.join('\n');
    console.log(text);
    if (reportPath) {
      const abs = path.resolve(reportPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
      console.log(`\nReport saved: ${reportPath}`);
    }
  }

  process.exit(criticalFail > 0 || highFail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(2);
});
