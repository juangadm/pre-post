import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';

// Module-level mock for child_process (required for ESM)
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { uploadImage, uploadBeforeAfter, checkRepoVisibility, uploadToGist } from '../../src/upload';

const mockExecSync = vi.mocked(execSync);

// Create a minimal valid PNG for testing
function createMinimalPng(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length
    0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x01, // width = 1
    0x00, 0x00, 0x00, 0x01, // height = 1
    0x08, 0x06, 0x00, 0x00, 0x00, // 8-bit RGBA
    0x1f, 0x15, 0xc4, 0x89, // CRC
    0x00, 0x00, 0x00, 0x0a, // IDAT length
    0x49, 0x44, 0x41, 0x54, // IDAT
    0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, // compressed data
    0x0d, 0x0a, 0x2d, 0xb4, // CRC
    0x00, 0x00, 0x00, 0x00, // IEND length
    0x49, 0x45, 0x4e, 0x44, // IEND
    0xae, 0x42, 0x60, 0x82, // CRC
  ]);
}

describe('uploadImage', () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('0x0.st upload', () => {
    it('uploads to 0x0.st by default', async () => {
      mockFetch.mockResolvedValueOnce({
        text: async () => 'https://0x0.st/abcd.png',
      });

      const image = createMinimalPng();
      const result = await uploadImage(image, 'test.png');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://0x0.st',
        expect.objectContaining({
          method: 'POST',
          headers: { 'User-Agent': 'before-after-cli/1.0' },
        })
      );
      expect(result).toBe('https://0x0.st/abcd.png');
    });

    it('uploads to custom 0x0.st URL', async () => {
      mockFetch.mockResolvedValueOnce({
        text: async () => 'https://0x0.st/xyz123.png',
      });

      const image = createMinimalPng();
      const result = await uploadImage(image, 'test.png', 'https://0x0.st');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://0x0.st',
        expect.objectContaining({ method: 'POST' })
      );
      expect(result).toBe('https://0x0.st/xyz123.png');
    });

    it('sends image as FormData with file blob', async () => {
      mockFetch.mockResolvedValueOnce({
        text: async () => 'https://0x0.st/test.png',
      });

      const image = createMinimalPng();
      await uploadImage(image, 'myfile.png');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.body).toBeInstanceOf(FormData);
      const formData = options.body as FormData;
      expect(formData.get('file')).toBeInstanceOf(Blob);
    });

    it('throws on non-URL response', async () => {
      mockFetch.mockResolvedValueOnce({
        text: async () => 'Error: rate limited',
      });

      const image = createMinimalPng();
      await expect(uploadImage(image, 'test.png')).rejects.toThrow('Upload failed: Error: rate limited');
    });

    it('trims whitespace from response URL', async () => {
      mockFetch.mockResolvedValueOnce({
        text: async () => '  https://0x0.st/file.png\n',
      });

      const image = createMinimalPng();
      const result = await uploadImage(image, 'test.png');
      expect(result).toBe('https://0x0.st/file.png');
    });
  });

  describe('Vercel Blob upload', () => {
    it('uploads to Vercel Blob with PUT', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: 'https://blob.vercel-storage.com/myfile-abc123.png' }),
      });

      const image = createMinimalPng();
      const result = await uploadImage(image, 'test.png', 'https://blob.vercel.com/v1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://blob.vercel.com/v1/test.png',
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
          body: image,
        })
      );
      expect(result).toBe('https://blob.vercel-storage.com/myfile-abc123.png');
    });

    it('throws on failed Vercel Blob upload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        statusText: 'Unauthorized',
      });

      const image = createMinimalPng();
      await expect(
        uploadImage(image, 'test.png', 'https://blob.vercel.com/v1')
      ).rejects.toThrow('Upload failed: Unauthorized');
    });
  });

  describe('generic PUT upload', () => {
    it('uploads to S3-compatible endpoint with PUT', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/plain']]),
        json: async () => { throw new Error('not json'); },
      });

      const image = createMinimalPng();
      const result = await uploadImage(image, 'test.png', 'https://my-bucket.s3.amazonaws.com');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://my-bucket.s3.amazonaws.com/test.png',
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
        })
      );
      // Falls back to constructed URL
      expect(result).toBe('https://my-bucket.s3.amazonaws.com/test.png');
    });

    it('returns URL from JSON response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) => name === 'content-type' ? 'application/json' : null,
        },
        json: async () => ({ url: 'https://cdn.example.com/images/test.png' }),
      });

      const image = createMinimalPng();
      const result = await uploadImage(image, 'test.png', 'https://upload.example.com');

      expect(result).toBe('https://cdn.example.com/images/test.png');
    });

    it('returns URL from Location header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) => name === 'location' ? 'https://cdn.example.com/test.png' : null,
        },
      });

      const image = createMinimalPng();
      const result = await uploadImage(image, 'test.png', 'https://upload.example.com');

      expect(result).toBe('https://cdn.example.com/test.png');
    });

    it('throws on failed PUT upload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        statusText: 'Internal Server Error',
      });

      const image = createMinimalPng();
      await expect(
        uploadImage(image, 'test.png', 'https://upload.example.com')
      ).rejects.toThrow('Upload failed: Internal Server Error');
    });
  });
});

describe('uploadBeforeAfter', () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
    mockExecSync.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uploads both images in parallel via HTTP when uploadUrl provided', async () => {
    mockFetch
      .mockResolvedValueOnce({ text: async () => 'https://0x0.st/before.png' })
      .mockResolvedValueOnce({ text: async () => 'https://0x0.st/after.png' });

    const beforeImage = createMinimalPng();
    const afterImage = createMinimalPng();

    const result = await uploadBeforeAfter(
      { image: beforeImage, filename: 'before.png' },
      { image: afterImage, filename: 'after.png' },
      'https://0x0.st'
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.beforeUrl).toBe('https://0x0.st/before.png');
    expect(result.afterUrl).toBe('https://0x0.st/after.png');
  });

  it('uses custom upload URL for both images', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
      });

    const beforeImage = createMinimalPng();
    const afterImage = createMinimalPng();

    await uploadBeforeAfter(
      { image: beforeImage, filename: 'before.png' },
      { image: afterImage, filename: 'after.png' },
      'https://my-bucket.s3.amazonaws.com'
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://my-bucket.s3.amazonaws.com/before.png',
      expect.anything()
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://my-bucket.s3.amazonaws.com/after.png',
      expect.anything()
    );
  });

  it('handles upload failure gracefully', async () => {
    mockFetch
      .mockResolvedValueOnce({ text: async () => 'Error: server down' })
      .mockResolvedValueOnce({ text: async () => 'https://0x0.st/after.png' });

    const beforeImage = createMinimalPng();
    const afterImage = createMinimalPng();

    await expect(
      uploadBeforeAfter(
        { image: beforeImage, filename: 'before.png' },
        { image: afterImage, filename: 'after.png' },
        'https://0x0.st'
      )
    ).rejects.toThrow('Upload failed');
  });
});

describe('private repo fallback', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  describe('checkRepoVisibility', () => {
    it('returns "private" for private repos', () => {
      mockExecSync
        .mockReturnValueOnce('https://github.com/owner/private-repo.git\n')
        .mockReturnValueOnce('private\n');

      expect(checkRepoVisibility()).toBe('private');
    });

    it('returns "private" for internal repos', () => {
      mockExecSync
        .mockReturnValueOnce('git@github.com:owner/internal-repo.git\n')
        .mockReturnValueOnce('internal\n');

      expect(checkRepoVisibility()).toBe('private');
    });

    it('returns "public" for public repos', () => {
      mockExecSync
        .mockReturnValueOnce('https://github.com/owner/public-repo.git\n')
        .mockReturnValueOnce('public\n');

      expect(checkRepoVisibility()).toBe('public');
    });

    it('returns "unknown" when git remote fails', () => {
      mockExecSync.mockImplementation(() => { throw new Error('not a git repo'); });

      expect(checkRepoVisibility()).toBe('unknown');
    });

    it('returns "unknown" when gh api fails', () => {
      mockExecSync
        .mockReturnValueOnce('https://github.com/owner/repo.git\n')
        .mockImplementationOnce(() => { throw new Error('gh not found'); });

      expect(checkRepoVisibility()).toBe('unknown');
    });

    it('returns "unknown" for non-GitHub remotes', () => {
      mockExecSync
        .mockReturnValueOnce('https://gitlab.com/owner/repo.git\n');

      expect(checkRepoVisibility()).toBe('unknown');
    });
  });

  describe('uploadBeforeAfter with private repo', () => {
    const mockFetch = vi.fn();
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = mockFetch;
      mockFetch.mockReset();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('falls back to gist when repo is private', async () => {
      mockExecSync
        // checkRepoVisibility
        .mockReturnValueOnce('https://github.com/owner/private-repo.git\n')  // git remote get-url
        .mockReturnValueOnce('private\n')  // gh api repos/... --jq .visibility
        // uploadToGist for before image
        .mockReturnValueOnce('https://gist.github.com/owner/abc123\n')  // gh gist create
        .mockReturnValueOnce('https://gist.githubusercontent.com/owner/abc123/raw/before.png\n')  // gh api gists/...
        // uploadToGist for after image
        .mockReturnValueOnce('https://gist.github.com/owner/def456\n')
        .mockReturnValueOnce('https://gist.githubusercontent.com/owner/def456/raw/after.png\n');

      const result = await uploadBeforeAfter(
        { image: createMinimalPng(), filename: 'before.png' },
        { image: createMinimalPng(), filename: 'after.png' },
      );

      expect(result.beforeUrl).toContain('gist.githubusercontent.com');
      expect(result.afterUrl).toContain('gist.githubusercontent.com');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('uses git-native when repo is public', async () => {
      mockExecSync
        // checkRepoVisibility
        .mockReturnValueOnce('https://github.com/owner/public-repo.git\n')  // git remote get-url
        .mockReturnValueOnce('public\n')  // gh api repos/... --jq .visibility
        // uploadGitNative calls (before)
        .mockReturnValueOnce('/tmp/repo\n')  // git rev-parse --show-toplevel
        .mockReturnValueOnce('main\n')       // git rev-parse --abbrev-ref HEAD
        .mockReturnValueOnce('https://github.com/owner/public-repo.git\n')  // git remote get-url
        .mockReturnValueOnce('')             // git add
        // uploadGitNative calls (after)
        .mockReturnValueOnce('/tmp/repo\n')
        .mockReturnValueOnce('main\n')
        .mockReturnValueOnce('https://github.com/owner/public-repo.git\n')
        .mockReturnValueOnce('')
        // commitAndPushScreenshots
        .mockReturnValueOnce('')  // git commit
        .mockReturnValueOnce('');  // git push

      const result = await uploadBeforeAfter(
        { image: createMinimalPng(), filename: 'before.png' },
        { image: createMinimalPng(), filename: 'after.png' },
      );

      expect(result.beforeUrl).toContain('raw.githubusercontent.com');
      expect(result.afterUrl).toContain('raw.githubusercontent.com');
    });

    it('falls back to git-native when visibility is unknown', async () => {
      mockExecSync
        // checkRepoVisibility — gh api fails
        .mockReturnValueOnce('https://github.com/owner/repo.git\n')  // git remote get-url
        .mockImplementationOnce(() => { throw new Error('gh not authenticated'); })  // gh api fails
        // uploadGitNative calls (before)
        .mockReturnValueOnce('/tmp/repo\n')
        .mockReturnValueOnce('main\n')
        .mockReturnValueOnce('https://github.com/owner/repo.git\n')
        .mockReturnValueOnce('')
        // uploadGitNative calls (after)
        .mockReturnValueOnce('/tmp/repo\n')
        .mockReturnValueOnce('main\n')
        .mockReturnValueOnce('https://github.com/owner/repo.git\n')
        .mockReturnValueOnce('')
        // commitAndPushScreenshots
        .mockReturnValueOnce('')
        .mockReturnValueOnce('');

      const result = await uploadBeforeAfter(
        { image: createMinimalPng(), filename: 'before.png' },
        { image: createMinimalPng(), filename: 'after.png' },
      );

      expect(result.beforeUrl).toContain('raw.githubusercontent.com');
      expect(result.afterUrl).toContain('raw.githubusercontent.com');
    });
  });
});

describe('uploadImage - real service integration', () => {
  const SKIP_REAL_UPLOAD = process.env.TEST_REAL_UPLOAD !== 'true';

  it.skipIf(SKIP_REAL_UPLOAD)('uploads to 0x0.st (real)', async () => {
    const image = createMinimalPng();
    const result = await uploadImage(image, 'test-before-after.png');

    expect(result).toMatch(/^https:\/\/0x0\.st\/.+/);
    console.log('Uploaded to:', result);
  });
});
