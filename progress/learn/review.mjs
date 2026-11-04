// Quick checks coming back over days. Pure: a plain object the helper keeps in review.json.
// A fixed ladder, since expanding and uniform spacing did no better than each other, with a daily
// cap so nothing piles up. What's over the cap just waits; it is never shown as a debt.
export const LADDER = [1, 3, 7, 21, 60]; // days
export const DAILY_CAP = 8;
const DAY = 86_400_000;

export const emptyReview = () => ({ v: 1, items: {}, day: { date: '', count: 0 } });
export const itemKey = (courseId, n, id) => `${courseId}/${n}/${id}`;

export function parseKey(key) {
  const [courseId, n, id] = String(key).split('/');
  return { courseId, n: Number(n), id };
}

const localDate = at => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const blank = (concepts, guess) => ({ box: 0, due: null, last: null, right: 0, wrong: 0, bestGap: 0, choice: null, concepts: concepts || [], guess: Boolean(guess), flagged: false });

/** An answer on the page. Only the first counts; a guess is kept but never comes back. */
export function answerOnPage(state, key, { right, choice, concepts, guess }, at = Date.now()) {
  const known = state.items[key];
  if (known && known.last !== null) return known;
  const item = known || blank(concepts, guess);
  state.items[key] = item;
  item.choice = choice;
  return step(item, right, at);
}

function step(item, right, at) {
  const gap = item.last === null ? 0 : Math.floor((at - item.last) / DAY);
  item.last = at;
  if (right) {
    item.right++;
    item.bestGap = Math.max(item.bestGap, gap);
    item.due = at + LADDER[item.box] * DAY;
    item.box = Math.min(item.box + 1, LADDER.length - 1);
  } else {
    item.wrong++;
    item.box = 0;
    item.due = at + DAY;
  }
  return item;
}

/** An answer in the Review tab: it moves the question and counts toward today's cap. */
export function answerInReview(state, key, right, at = Date.now()) {
  const item = state.items[key];
  if (!item) return null;
  const date = localDate(at);
  if (state.day.date !== date) state.day = { date, count: 0 };
  state.day.count++;
  return step(item, right, at);
}

/** Today's questions, oldest first, and how many more are due than today's cap allows. */
export function dueToday(state, at = Date.now(), cap = DAILY_CAP) {
  const today = localDate(at);
  const done = state.day.date === today ? state.day.count : 0;
  const due = Object.entries(state.items)
    .filter(([, item]) => !item.flagged && !item.guess && item.due !== null && localDate(item.due) <= today)
    .sort((a, b) => a[1].due - b[1].due)
    .map(([key]) => key);
  const room = Math.max(0, cap - done);
  return { due: due.slice(0, room), waiting: Math.max(0, due.length - room), done };
}

/** When the next question comes back after today, or null. */
export function nextDue(state, at = Date.now()) {
  const today = localDate(at);
  const later = Object.values(state.items).filter(item => !item.flagged && !item.guess && item.due !== null && localDate(item.due) > today).map(item => item.due);
  return later.length ? Math.min(...later) : null;
}

/** "This question is wrong": gone from the page and from review. */
export function flagItem(state, key, { concepts, guess } = {}) {
  const item = state.items[key] || blank(concepts, guess);
  state.items[key] = item;
  item.flagged = true;
  return item;
}

export const isFlagged = (state, key) => Boolean(state.items[key]?.flagged);

/** How long each concept has been recalled across: its best right answer after a gap, in days. */
export function recallDays(state) {
  const out = {};
  for (const item of Object.values(state.items)) {
    if (item.flagged || item.guess || !item.bestGap) continue;
    for (const id of item.concepts) out[id] = Math.max(out[id] || 0, item.bestGap);
  }
  return out;
}

export function dropCourse(state, courseId) {
  for (const key of Object.keys(state.items)) if (key.startsWith(`${courseId}/`)) delete state.items[key];
}

export function swapConcept(state, fromId, toId) {
  for (const item of Object.values(state.items)) item.concepts = [...new Set(item.concepts.map(id => (id === fromId ? toId : id)))];
}
