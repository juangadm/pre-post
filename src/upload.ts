/**
 * Image upload for generating shareable URLs.
 * Default: git-native (commits to .pre-post/, serves via blob+SHA URLs).
 * Opt-in: 0x0.st, Vercel Blob, generic PUT via --upload-url.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DEFAULT_UPLOAD_URL = 'https://0x0.st';

/**
 * Upload an image and return a public URL.
 * Auto-detects upload method from URL pattern.
 */
export async function uploadImage(
  image: Buffer,
  filename: string,
  uploadUrl: string = DEFAULT_UPLOAD_URL
): Promise<string> {
  // 0x0.st uses multipart form upload
  if (uploadUrl.includes('0x0.st')) {
    return upload0x0st(image, filename, uploadUrl);
  }

  // Vercel Blob uses PUT with specific headers
  if (uploadUrl.includes('blob.vercel')) {
    return uploadVercelBlob(image, filename, uploadUrl);
  }

  // Generic PUT upload (common for S3-compatible services)
  return uploadGenericPut(image, filename, uploadUrl);
}

async function upload0x0st(image: Buffer, filename: string, url: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', new Blob([image]), filename);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': 'before-after-cli/1.0' },
    body: formData,
  });

  const result = (await response.text()).trim();
  if (!result.startsWith('http')) {
    throw new Error(`Upload failed: ${result}`);
  }
  return result;
}

async function uploadVercelBlob(image: Buffer, filename: string, url: string): Promise<string> {
  const response = await fetch(`${url}/${filename}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: image,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.statusText}`);
  }

  const result = await response.json() as { url: string };
  return result.url;
}

async function uploadGenericPut(image: Buffer, filename: string, url: string): Promise<string> {
  const response = await fetch(`${url}/${filename}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: image,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.statusText}`);
  }

  // Try to parse JSON response, fall back to URL from location header or constructed URL
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const result = await response.json() as { url?: string };
    if (result.url) return result.url;
  }

  return response.headers.get('location') || `${url}/${filename}`;
}

/**
 * Resolve owner/repo from environment variables or git remote URL.
 * Supports standard GitHub URLs, SSH URLs, and proxy/non-standard URLs.
 */
function resolveOwnerRepo(): string {
  const envOwnerRepo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if (envOwnerRepo) return envOwnerRepo;

  const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();

  // Standard GitHub: https://github.com/owner/repo.git or git@github.com:owner/repo.git
  const githubMatch = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (githubMatch) return githubMatch[1];

  // Fallback: extract last two path segments from any URL (covers proxies, mirrors, etc.)
  const fallbackMatch = remoteUrl.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (fallbackMatch) return fallbackMatch[1];

  throw new Error(
    `Cannot parse owner/repo from: ${remoteUrl}\n` +
    'Fix: set GH_REPO=owner/repo'
  );
}

/**
 * Write an image to .pre-post/ in the repo root and stage it.
 * Returns filename + ownerRepo — caller constructs blob+SHA URL after commit.
 */
export function uploadGitNative(
  image: Buffer,
  filename: string,
): { filename: string; ownerRepo: string } {
  const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  const ownerRepo = resolveOwnerRepo();

  const destDir = path.join(repoRoot, '.pre-post');
  fs.mkdirSync(destDir, { recursive: true });

  const dest = path.join(destDir, filename);
  fs.writeFileSync(dest, image);
  execSync(`git add -f "${dest}"`);

  return { filename, ownerRepo };
}

/**
 * Commit and push all staged .pre-post/ screenshots in one batch.
 * Returns the full 40-char commit SHA.
 */
export function commitAndPushScreenshots(): string {
  execSync('git commit -m "chore: add pre/post screenshots"');
  execSync('git push origin HEAD');

  const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Failed to get commit SHA after push (got: "${sha}")`);
  }
  return sha;
}

/**
 * Construct a GitHub blob URL with full SHA for an image in .pre-post/.
 * Blob URLs are same-origin on GitHub — the markdown renderer resolves them
 * with the viewer's auth, so they work for both public and private repos.
 */
function buildBlobUrl(ownerRepo: string, sha: string, filename: string): string {
  return `https://github.com/${ownerRepo}/blob/${sha}/.pre-post/${filename}?raw=true`;
}

/**
 * Upload before/after images and return URLs.
 * When uploadUrl is provided, uses the HTTP-based upload path.
 * Otherwise, uses git-native (commit to .pre-post/) with blob+SHA URLs.
 */
export async function uploadBeforeAfter(
  before: { image: Buffer; filename: string },
  after: { image: Buffer; filename: string },
  uploadUrl?: string
): Promise<{ beforeUrl: string; afterUrl: string }> {
  // If an explicit upload URL is provided, use HTTP upload
  if (uploadUrl) {
    const [beforeUrl, afterUrl] = await Promise.all([
      uploadImage(before.image, before.filename, uploadUrl),
      uploadImage(after.image, after.filename, uploadUrl),
    ]);
    return { beforeUrl, afterUrl };
  }

  // Default: git-native with blob+SHA URLs.
  // Works for both public and private repos — blob URLs are same-origin on GitHub,
  // so the markdown renderer resolves them with the viewer's authentication context.
  const beforeResult = uploadGitNative(before.image, before.filename);
  const afterResult = uploadGitNative(after.image, after.filename);
  const sha = commitAndPushScreenshots();

  const beforeUrl = buildBlobUrl(beforeResult.ownerRepo, sha, beforeResult.filename);
  const afterUrl = buildBlobUrl(afterResult.ownerRepo, sha, afterResult.filename);

  return { beforeUrl, afterUrl };
}
