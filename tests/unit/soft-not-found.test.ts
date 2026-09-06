import { describe, it, expect } from 'vitest';
import { softNotFoundWarning } from '../../src/run';
import { RouteCaptureOutcome } from '../../src/types';

describe('softNotFoundWarning', () => {
  const outcome = (route: string, baselineHash?: string): RouteCaptureOutcome =>
    ({ route, resolvedRoute: route, viewport: 'desktop', status: 'changed', baselineHash });

  it('says nothing when each route had its own baseline', () => {
    expect(softNotFoundWarning([outcome('/a', 'h1'), outcome('/b', 'h2')], 'https://acme.com')).toBeNull();
  });

  it('flags a host that served one identical page for several routes', () => {
    const warning = softNotFoundWarning(
      [outcome('/a', 'same'), outcome('/b', 'same'), outcome('/c', 'same')],
      'https://acme.com',
    );
    expect(warning).toContain('acme.com');
    expect(warning).toContain('3 routes');
    expect(warning).toContain('/a, /b, /c');
  });

  it('does not count one route captured at several viewports', () => {
    const twice = [outcome('/a', 'same'), { ...outcome('/a', 'same'), viewport: 'mobile' }];
    expect(softNotFoundWarning(twice, 'https://acme.com')).toBeNull();
  });

  it('ignores outcomes with no baseline to fingerprint', () => {
    expect(softNotFoundWarning([outcome('/a'), outcome('/b')], 'https://acme.com')).toBeNull();
  });
});
