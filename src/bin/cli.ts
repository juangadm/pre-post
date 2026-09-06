#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { createRequire } from 'module';
import { Framework } from '../types.js';
import { runPr } from '../commands/pr.js';
import { runCompare } from '../commands/compare.js';
import { runLogin } from '../commands/login.js';
import { runPrune } from '../commands/prune.js';
import { doctorExitCode, runDoctor } from '../commands/doctor.js';
import { runDetect } from '../commands/detect.js';
import { NeedsHumanError } from '../errors.js';
import { buildSummary } from '../report.js';

const require = createRequire(import.meta.url);
const VERSION: string = (() => {
  try {
    return require('../../package.json').version;
  } catch {
    return '0.0.0';
  }
})();

const SUBCOMMANDS = ['pr', 'detect', 'login', 'prune', 'doctor', 'compare'] as const;
type Subcommand = typeof SUBCOMMANDS[number];

const argv = process.argv.slice(2);
const subcommand = SUBCOMMANDS.includes(argv[0] as Subcommand) ? (argv.shift() as Subcommand) : null;

/**
 * parseArgs throws a TypeError for an unknown flag, and an uncaught one prints
 * a Node-internal stack trace: eight lines of `node:internal/util/parse_args`
 * for a typo. The CLI is mostly read by agents, so the first line has to be the
 * thing to fix, not a frame from Node's parser.
 *
 * Only the parse is wrapped, and the message is Node's own — this reformats a
 * failure, it does not decide what counts as one.
 */
function parse() {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: OPTIONS,
    });
  } catch (err) {
    const message = (err as Error)?.message?.split('\n')[0] ?? 'could not parse the arguments';
    console.error(`pre-post: ${message}`);
    console.error('Run: pre-post --help');
    process.exit(2);
  }
}

const OPTIONS = {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    before: { type: 'string' },
    after: { type: 'string' },
    routes: { type: 'string' },
    'max-routes': { type: 'string' },
    framework: { type: 'string' },
    base: { type: 'string' },
    'no-local-baseline': { type: 'boolean' },
    viewports: { type: 'string' },
    mobile: { type: 'boolean', short: 'm' },
    tablet: { type: 'boolean', short: 't' },
    responsive: { type: 'boolean', short: 'r' },
    size: { type: 'string' },
    full: { type: 'boolean', short: 'f' },
    'viewport-only': { type: 'boolean' },
    scale: { type: 'string' },
    threshold: { type: 'string' },
    'min-changed-area': { type: 'string' },
    'max-height': { type: 'string' },
    wait: { type: 'string' },
    header: { type: 'string', multiple: true },
    cookie: { type: 'string', multiple: true },
    output: { type: 'string', short: 'o' },
    'dry-run': { type: 'boolean' },
    'no-comment': { type: 'boolean' },
    pr: { type: 'string' },
    json: { type: 'boolean' },
    days: { type: 'string' },
    quiet: { type: 'boolean', short: 'q' },
} as const;

const { values, positionals } = parse();

function printHelp(): void {
  console.log(`pre-post ${VERSION} — before/after screenshots for pull requests

USAGE
  pre-post pr [options]                 Detect routes, capture, diff, publish, comment on the PR
  pre-post <before> <after> [options]   Compare two URLs (or two PNG files)
  pre-post detect                       Print the routes this branch affects (JSON)
  pre-post ... --base <ref>             Compare against <ref> instead of the detected fork point
  pre-post login <url>                  Sign in once; the session is reused for captures
  pre-post prune [--days 90]            Delete screenshots for PRs closed longer ago
  pre-post doctor                       Check browser, GitHub auth, dev server

OPTIONS
  --before <url>            Production base URL (saved to .pre-post.json)
  --after <url>             Local base URL (auto-detected)
  --routes /a,/b            Explicit routes instead of detection
  --max-routes <n>          Cap on detected routes (default 6)
  --viewports desktop,mobile,1440x900   Viewports (default desktop)
  -r, --responsive          Desktop and mobile
  -m, --mobile  -t, --tablet  --size WxH   Single-viewport shorthands
  -f, --full | --viewport-only          Full page (default for pr) or first screen only
  --scale <n>               Device scale factor (default 2)
  --threshold <0..1>        Changed share of the canvas that counts (default 0.001)
  --min-changed-area <px2>  Changed area in CSS px² that counts (default 100)
                            A capture counts as changed when EITHER holds, so
                            a 0.04% diff on a full page is still a change if it
                            paints more than 100 CSS px².
  --max-height <px>         Full-page height cap in CSS px (default 2400)
  --wait <ms>               Extra wait after the page settles
  --header k=v              Extra request header (repeatable)
  --cookie name=value       Cookie for the production host (repeatable)
  -o, --output <dir>        Where to write images (default: temp dir)
  --no-local-baseline       Do not rebuild the baseline from the base commit
  --dry-run                 Capture and diff only; no upload, no comment
  --no-comment              Publish images but do not touch the PR
  --pr <number>             Target a specific PR
  --json                    Machine-readable output
  -q, --quiet               Only the final summary

ENVIRONMENT
  GH_TOKEN / GITHUB_TOKEN               GitHub token (default: gh auth token)
  VERCEL_AUTOMATION_BYPASS_SECRET       Bypass Vercel Deployment Protection
  PRE_POST_CONCURRENCY                  Parallel pages (default 6)
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH   Use a specific Chromium binary
`);
}

function num(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`Invalid value for ${flag}: ${v}`);
    process.exit(2);
  }
  return n;
}

function kv(list: string[] | undefined): Record<string, string> | undefined {
  if (!list?.length) return undefined;
  const out: Record<string, string> = {};
  for (const item of list) {
    const sep = item.search(/[=:]/);
    if (sep === -1) {
      console.error(`Expected key=value, got: ${item}`);
      process.exit(2);
    }
    out[item.slice(0, sep).trim()] = item.slice(sep + 1).trim();
  }
  return out;
}

function viewportsFromFlags(): string[] | undefined {
  if (values.viewports) return values.viewports.split(',').map(s => s.trim()).filter(Boolean);
  if (values.responsive) return ['desktop', 'mobile'];
  if (values.mobile) return ['mobile'];
  if (values.tablet) return ['tablet'];
  if (values.size) return [values.size];
  return undefined;
}

/** `before`/`after` come from flags for `pr` and `compare`, from positionals otherwise. */
function resolveTargets(): { before?: string; after?: string } {
  if (subcommand === 'pr' || subcommand === 'compare') return { before: values.before, after: values.after };
  return { before: positionals[0], after: positionals[1] };
}

const quiet = values.quiet || values.json;
const log = (msg: string) => { if (!quiet) console.error(msg); };

function output(result: Parameters<typeof buildSummary>[0]): void {
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(buildSummary(result));
  console.log(`Files: ${result.outputDir}`);
  if (result.markdown && !result.commentUrl) console.log('\n' + result.markdown);
}

async function main(): Promise<void> {
  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help || (!subcommand && positionals.length < 2)) {
    printHelp();
    if (!values.help && !subcommand && positionals.length > 0) process.exit(2);
    return;
  }

  const common = {
    routes: values.routes ? values.routes.split(',').map(r => r.trim()).filter(Boolean) : undefined,
    viewports: viewportsFromFlags(),
    fullPage: values['viewport-only'] ? false : values.full ? true : undefined,
    scale: num(values.scale, '--scale'),
    threshold: num(values.threshold, '--threshold'),
    minChangedArea: num(values['min-changed-area'], '--min-changed-area'),
    maxHeight: num(values['max-height'], '--max-height'),
    maxRoutes: num(values['max-routes'], '--max-routes'),
    wait: num(values.wait, '--wait'),
    headers: kv(values.header),
    output: values.output,
    log,
  };
  const { before, after } = resolveTargets();

  switch (subcommand) {
    case 'pr': {
      // before/after come from flags here; positionals would be silently dropped.
      if (positionals.length) {
        console.error(`pre-post pr takes no positional arguments (got: ${positionals.join(' ')}). Use --before and --after.`);
        process.exit(2);
      }
      const cookies = values.cookie ? Object.entries(kv(values.cookie)!).map(([name, value]) => ({ name, value })) : undefined;
      const result = await runPr({
        ...common,
        before,
        after,
        framework: values.framework as Framework | undefined,
        base: values.base,
        cookies,
        dryRun: values['dry-run'],
        localBaseline: !values['no-local-baseline'],
        comment: !values['no-comment'],
        pr: num(values.pr, '--pr'),
        version: VERSION,
      });
      output(result);
      if (result.outcomes.length && result.outcomes.every(o => o.status === 'error')) process.exit(1);
      return;
    }
    case 'detect': {
      const detection = runDetect({ maxRoutes: common.maxRoutes, framework: values.framework as Framework | undefined, base: values.base });
      console.log(JSON.stringify(detection, null, values.json ? 2 : 0));
      return;
    }
    case 'login': {
      if (!positionals[0]) {
        console.error('Usage: pre-post login <url>');
        process.exit(2);
      }
      await runLogin(positionals[0]);
      return;
    }
    case 'prune': {
      const result = await runPrune({ days: num(values.days, '--days'), dryRun: values['dry-run'] });
      console.log(values['dry-run'] ? 'Would remove:' : 'Removed:', result.removed.length ? result.removed.join(', ') : 'nothing');
      console.log('Kept:', result.kept.length ? result.kept.join(', ') : 'nothing');
      return;
    }
    case 'doctor': {
      const checks = await runDoctor();
      for (const c of checks) {
        // Advisory failures are worth reading and are not failures of the
        // command, so they must not look like the ones that are.
        const status = c.ok ? 'ok' : c.required ? 'FAIL' : 'note';
        console.log(`${c.name.padEnd(10)} ${status.padEnd(4)}  ${c.detail}`);
      }
      const code = doctorExitCode(checks);
      console.log(code === 0
        ? 'ready — pre-post pr can run'
        : `not ready — fix: ${checks.filter(c => c.required && !c.ok).map(c => c.name).join(', ')}`);
      process.exit(code);
    }
    case 'compare':
    default: {
      if (!before || !after) {
        console.error('Two URLs (or two PNG files) are required.');
        process.exit(2);
      }
      output(await runCompare({ ...common, before, after }));
      return;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    if (err instanceof NeedsHumanError) {
      console.error(`\n${err.message}`);
      process.exit(3);
    }
    console.error(err?.stack && process.env.PRE_POST_DEBUG ? err.stack : `Error: ${err?.message || err}`);
    process.exit(1);
  });
