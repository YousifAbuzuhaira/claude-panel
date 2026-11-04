// Review: quick checks coming back, one at a time, up to a few a day.
import { GLYPH, S, act, action, formatDate, h, nav, short, toast } from './core.js';
import { renderCheck } from './checks.js';

const R = { items: [], at: 0, right: 0, seen: 0, next: null, waiting: 0 };
let ui = null;

export function buildReviewView(host) {
  const head = h('div.review-head', null, h('h2.review-title', null, 'Review'), h('span.dim.review-count'));
  const body = h('div.review-body');
  host.append(h('div.review-view', null, head, body));
  ui = { count: head.lastChild, body };
}

export async function refreshReview() {
  const result = await act('review.list');
  if (!result) return;
  Object.assign(R, { items: result.items || [], at: 0, right: 0, seen: 0, next: result.next, waiting: result.waiting || 0 });
  showReview();
}

function finished() {
  const parts = [];
  if (R.seen) parts.push(h('p', null, `${R.right} of ${R.seen} right today.`));
  parts.push(h('p.dim', null, R.seen ? 'That is enough for today.' : 'Nothing to review right now.'));
  parts.push(h('p.dim', null, R.next
    ? `The next one comes back on ${formatDate(new Date(R.next).toISOString())}.`
    : 'Quick checks you answer on a page come back here after a day, then after longer and longer gaps.'));
  return parts;
}

function showReview() {
  if (!ui) return;
  const item = R.items[R.at];
  S.reviewDue = Math.max(0, R.items.length - R.at);
  nav.showReviewCount();
  ui.count.textContent = item ? `${R.at + 1} of ${R.items.length}` : '';
  if (!item) {
    ui.body.replaceChildren(...finished());
    return;
  }
  const next = h('button.ui-btn.primary', { type: 'button', hidden: true, onclick: () => { R.at++; showReview(); } }, R.at + 1 < R.items.length ? 'Next' : 'Finish');
  const check = renderCheck(item.check, {
    label: 'Remember this?',
    onAnswer: async choice => {
      const result = await act('review.answer', { key: item.key, choice });
      if (!result) return;
      R.seen++;
      if (result.right) R.right++;
      next.hidden = false;
      next.focus();
    },
    onWrong: async () => {
      if ((await act('check.flag', { key: item.key })) === undefined) return;
      toast('Removed from this page and from Review');
      R.at++;
      showReview();
    },
  });
  const from = action(`${short(item.courseTitle, 40)} ${GLYPH.dot} ${short(item.pageTitle, 50)}`, () => nav.openCourse(item.courseId, item.n), 'faint');
  from.title = 'Open this page';
  ui.body.replaceChildren(check, h('div.review-foot', null, from, next));
}
