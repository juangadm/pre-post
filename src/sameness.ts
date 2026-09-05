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
 */
function containment(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared++;
  return shared / small.size;
}

/** Overlap of two pages' body text, or null when either is too text-poor to judge. */
export function textOverlap(before: string, after: string): number | null {
  const a = pageWords(before);
  const b = pageWords(after);
  if (a.size < MIN_WORDS || b.size < MIN_WORDS) return null;
  return containment(a, b);
}

/**
 * Overlap of two pages' titles, or null when either says nothing distinctive.
 *
 * No `MIN_WORDS` here: a title is a handful of words by nature, and it is the
 * one place a site almost always names itself. That makes it the corroborating
 * signal for a run with only one route to go on — a branch that rewrites a
 * page's copy keeps the site's name in the tab, a different site does not.
 */
export function titleOverlap(before: string, after: string): number | null {
  const a = pageWords(before);
  const b = pageWords(after);
  if (!a.size || !b.size) return null;
  return containment(a, b);
}

/** What this needs from each capture: which page it was, and how the two sides compared. */
export interface RouteEvidence {
  route?: string;
  textOverlap?: number | null;
  titleOverlap?: number | null;
}

/**
 * Do the captures, taken together, say these are two different sites?
 *
 * Every judgeable page has to disagree, and the evidence has to be about
 * *pages*, not captures. One route shot at three viewports is one page's word
 * list three times over; counting it as three agreeing witnesses is how a run
 * that detected a single route — an explicit `--routes /`, or the `/` fallback
 * when the diff names none — could reject the one thing this function's own
 * rule permits: a branch that rewrote a page.
 *
 * So captures are folded per route, keeping each route's *strongest* showing of
 * shared words, and a run with only one page to go on asks the title as well. A
 * title is where a site names itself, so a rewritten page keeps it and a
 * different site does not. Without a usable title there is no second witness
 * and the run is published, which is the right way to be wrong here: publishing
 * a diff someone can look at beats refusing to on one page's say-so.
 */
export function looksLikeDifferentSites(routes: RouteEvidence[]): boolean {
  const pages = new Map<string, { text: number | null; title: number | null }>();
  for (const [i, r] of routes.entries()) {
    const key = r.route ?? `#${i}`;
    const seen = pages.get(key);
    // The best showing across viewports: any viewport that found shared words
    // clears the page, so a single narrow layout cannot condemn it alone.
    pages.set(key, {
      text: strongest(seen?.text, r.textOverlap),
      title: strongest(seen?.title, r.titleOverlap),
    });
  }

  const judged = [...pages.values()].filter(p => p.text !== null);
  if (judged.length === 0 || !judged.every(p => (p.text as number) < SAME_SITE_FLOOR)) return false;
  if (judged.length > 1) return true;
  const { title } = judged[0];
  return title !== null && title < SAME_SITE_FLOOR;
}

/** The higher of two overlaps, treating "could not judge" as no evidence. */
function strongest(a: number | null | undefined, b: number | null | undefined): number | null {
  if (typeof a !== 'number') return typeof b === 'number' ? b : null;
  if (typeof b !== 'number') return a;
  return Math.max(a, b);
}

/** What to do about it, when the caller says nothing: the `pr` path, which chose Pre itself. */
export const DEFAULT_DIFFERENT_SITES_FIX = "re-run with --before pointing at this site's own deployment";

/**
 * The one sentence a human needs when the two sides are not the same site.
 *
 * `beforeDetail` is how Pre was chosen ("production deployment for 26aa6cd"),
 * absent when a caller was handed both URLs by hand and has no provenance to
 * report. `fix` is the remedy, which is the caller's to name: telling someone
 * to pass `--before` is right when the tool picked the baseline and wrong in
 * the two-URL mode, where both sides came in as positional arguments and that
 * flag is not how the command is invoked. Advice that does not apply to the
 * mode you are in is the failure this project keeps finding — it is what sent
 * someone to sign in to a macOS system service.
 */
export function differentSitesHint(
  beforeUrl: string,
  beforeDetail: string | undefined,
  afterUrl: string,
  fix: string = DEFAULT_DIFFERENT_SITES_FIX,
): string {
  const pre = beforeDetail ? `${beforeUrl} — ${beforeDetail}` : beforeUrl;
  return `Pre (${pre}) and Post (${afterUrl}) share no wording on any route, so they are not the same site: ${fix}.`;
}
