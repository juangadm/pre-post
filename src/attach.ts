/**
 * Put clips where GitHub will play them.
 *
 * A video plays inline in a PR only from GitHub's own attachment storage
 * (`github.com/user-attachments/assets/…`); a file on the assets branch is a
 * download link at best. Since 2026-09-01 `gh` uploads there with `--attach`
 * (gh 2.99+, a person's login or a classic PAT — the Actions GITHUB_TOKEN is
 * refused), rewriting a local reference in the text it posts into the
 * attachment URL.
 *
 * The description itself is written by the same code as always, so the clips
 * are uploaded on their own first: a temporary comment carries them up, their
 * URLs are read back, and the comment is deleted — the flow vercel-labs'
 * before-and-after settled on. Anything that goes wrong leaves the caller to
 * fall back to the assets branch.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { GitHub } from './github.js';

/** The first gh release whose `--attach` works on PRs and comments. */
export const MIN_GH_FOR_ATTACH = [2, 99, 0] as const;

export const UPDATE_GH_HINT = 'Update GitHub CLI to 2.99 or newer (https://cli.github.com, or `brew upgrade gh`) to play videos inline in the PR.';

const ATTACHMENT_URL = /https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/g;
const UPLOAD_MARKER = '<!-- pre-post:upload (temporary; deleted once the clips are uploaded) -->';

/** `gh version 2.101.0 (2026-09-20)` → [2, 101, 0]. */
export function parseGhVersion(output: string): number[] | null {
  const m = /gh version (\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function atLeast(version: number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    if ((version[i] ?? 0) !== min[i]) return (version[i] ?? 0) > min[i];
  }
  return true;
}

/** Whether this machine's gh can attach video, and if not the sentence that fixes it. */
export function ghAttachSupport(): { ok: true } | { ok: false; reason: string } {
  const probe = spawnSync('gh', ['--version'], { encoding: 'utf-8' });
  if (probe.error || probe.status !== 0) {
    return { ok: false, reason: 'Install GitHub CLI 2.99 or newer (https://cli.github.com) to play videos inline in the PR.' };
  }
  const version = parseGhVersion(probe.stdout);
  if (!version || !atLeast(version, MIN_GH_FOR_ATTACH)) return { ok: false, reason: UPDATE_GH_HINT };
  return { ok: true };
}

/** The attachment URLs in a comment body, in the order they appear. */
export function attachmentUrls(body: string): string[] {
  return body.match(ATTACHMENT_URL) ?? [];
}

function runGh(args: string[], cwd: string, token: string | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      cwd,
      // The token pre-post already uses, so gh acts as the same identity.
      env: token ? { ...process.env, GH_TOKEN: token } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `gh exited ${code}`)));
  });
}

/**
 * Upload `files` (all in one folder) as PR attachments. Returns file → URL.
 * Throws when any of them does not come back as an attachment.
 */
export async function uploadAttachments(
  gh: GitHub,
  ownerRepo: string,
  prNumber: number,
  files: string[],
  token?: string,
): Promise<Map<string, string>> {
  if (!files.length) return new Map();
  const dir = path.dirname(files[0]);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-upload-'));
  const bodyFile = path.join(scratch, 'body.md');
  // `--attach` rewrites references to the files it is given, resolved from
  // gh's working directory, so both use the same relative spelling.
  const refs = files.map(f => `./${path.basename(f)}`);
  fs.writeFileSync(bodyFile, [UPLOAD_MARKER, '', ...refs.map(r => `![clip](${r})`), ''].join('\n'));
  try {
    const out = await runGh([
      'pr', 'comment', String(prNumber), '--repo', ownerRepo, '--body-file', bodyFile,
      ...refs.flatMap(r => ['--attach', r]),
    ], dir, token);
    const id = /#issuecomment-(\d+)/.exec(out)?.[1];
    if (!id) throw new Error('gh did not say which comment it posted');
    const comment = await gh.request<{ body: string }>('GET', `/repos/${ownerRepo}/issues/comments/${id}`);
    const urls = attachmentUrls(comment.body ?? '');
    if (urls.length !== files.length) {
      // Kept, not deleted: the comment is the only place the uploads are listed.
      throw new Error(`expected ${files.length} attachment(s), GitHub returned ${urls.length}`);
    }
    // The attachment outlives the comment that carried it up.
    await gh.request('DELETE', `/repos/${ownerRepo}/issues/comments/${id}`).catch(() => undefined);
    return new Map(files.map((f, i) => [f, urls[i]]));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
