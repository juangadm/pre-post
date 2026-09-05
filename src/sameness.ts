/**
 * Are the two sides the same site at all?
 *
 * The backstop this file exists to be was first specified as "a diff near 100%
 * on every route means the two sides are different sites". Measured, that rule
 * is wrong in both directions, and it is worth writing down why so it is not
 * proposed again:
 *
 * | pair                                            | changed |
 * |-------------------------------------------------|---------|
 * | the marketing site vs an unrelated real site     |  2.66% desktop / 5.02% mobile |
 * | fixture pricing page vs an unrelated fixture     |  0.72% – 7.99% |
 * | the same site with a full theme change (fixture) | 99.14%  |
 * | the same site redesigned (fixture rung-7)        | 99.60%  |
 *
 * Web pages are mostly background, and a pixel diff counts pixels that differ,
 * so two *unrelated* pages agree on most of the canvas and read as a small
 * change — the same 1-8% band as the login-page run that started all of this
 * (4.53% / 1.99%). Meanwhile a legitimate redesign, the PR most worth
 * screenshotting, reads ~100%. A threshold at 100% would have missed every
 * real occurrence and fired on the best ones.
 *
 * What does separate them is the words on the page. A redesign changes how a
 * page looks, not what it says; a different site says something else entirely.
 * Measured over the same pairs, with common English words removed:
 *
 *   different sites   0.000, 0.000, 0.000, 0.071
 *   same site         0.200 (the weakest fixture), 0.417+, 1.000 for real pages
 *
 * The floor below sits in that empty band.
 */

/**
 * Words too common to say anything about which site you are on. Without this,
 * two unrelated English pages score 0.18 on shared articles and prepositions
 * alone, which is close enough to the weakest same-site pair (0.20) to make the
 * test unusable.
 */
const STOP_WORDS = new Set(
  ('the and for you your are with that this from all not our but can has have was were will more than then ' +
   'when who how why into out off over under new get set use using its about here there they them their ' +
   'his her she him one two any some each own too very just also only same such per via yes non')
    .split(' '),
);

/** The distinctive words a page shows a reader. */
export function pageWords(text: string): Set<string> {
  const found = text.toLowerCase().match(/[a-z0-9']{3,}/g) ?? [];
  return new Set(found.filter(w => !STOP_WORDS.has(w)));
}

/**
 * A page with almost nothing to say cannot answer this question: an image or a
 * canvas with six words on it scores near zero against anything, including
 * itself one version later. Below this many distinct words, the answer is "do
 * not know" rather than "different".
 */
export const MIN_WORDS = 10;

/** The floor, from the measurements above: 0.071 was different, 0.200 was not. */
export const SAME_SITE_FLOOR = 0.1;

/**
 * How much of the smaller vocabulary the larger one also has.
 *
 * Containment rather than Jaccard because the two sides legitimately differ in
 * length — a branch that adds a section should not read as a different site for
 * having more words than the baseline.
 *
 * Returns null when either side is too text-poor to judge.
 */
export function textOverlap(before: string, after: string): number | null {
  const a = pageWords(before);
  const b = pageWords(after);
  if (a.size < MIN_WORDS || b.size < MIN_WORDS) return null;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared++;
  return shared / small.size;
}

/**
 * Do the captures, taken together, say these are two different sites?
 *
 * Every judgeable route has to disagree, and at least one has to be judgeable.
 * One route sharing no words is ordinary — a branch can rewrite a page — while
 * every route on the site sharing none is not a change, it is the wrong site.
 * Requiring unanimity is what keeps this from firing on real work.
 */
export function looksLikeDifferentSites(routes: Array<{ textOverlap?: number | null }>): boolean {
  const judged = routes
    .map(r => r.textOverlap)
    .filter((v): v is number => typeof v === 'number');
  return judged.length > 0 && judged.every(v => v < SAME_SITE_FLOOR);
}

/** The one sentence a human needs when the two sides are not the same site. */
export function differentSitesHint(beforeUrl: string, beforeDetail: string, afterUrl: string): string {
  return `Pre and Post are not the same site: no route shows any of the same words on both sides. ` +
    `Pre is ${beforeUrl} (${beforeDetail}) and Post is ${afterUrl}. ` +
    `Nothing was published, because a diff between two different sites is not a review of this branch. ` +
    `Re-run with --before pointing at this site's own deployment.`;
}
