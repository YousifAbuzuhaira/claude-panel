// The games hub: the four games and Learn. Links carry the token along in the hash (api.js also
// keeps it for this tab). In the macOS window app Learn opens in a window of its own, as /learn
// opens it; anywhere else (or with a modifier held) it is a plain link.
import { openWindow, withToken } from '../shared/api.js';
import { isNative, watchAppearance } from '../shared/look.js';
import { markSeeThrough } from './legible.js';

for (const link of document.querySelectorAll('a.game-link')) link.href = withToken(link.getAttribute('href'));

const learn = document.getElementById('learn');
learn.href = withToken('../learn/');
learn.addEventListener('click', async event => {
  if (!isNative() || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  if (!(await openWindow('learn'))) location.href = learn.href;
});

watchAppearance('games', (appearance, palette) => markSeeThrough(palette));
