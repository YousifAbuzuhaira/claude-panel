// A quick check: pick an option, then see why each one is right or wrong. No Claude call.
// Used on a page and in Review; `onAnswer` tells the helper, `onWrong` is "this question is wrong".
import { GLYPH, action, h } from './core.js';
import { renderInlines } from './blocks.js';

/** `shown`: the option already chosen, or null. An option's own `i` is its place in the page. */
export function renderCheck(block, { shown = null, label = null, onAnswer, onWrong }) {
  const options = block.options || [];
  const where = (option, index) => option.i ?? index;
  const box = h('div.check-options');
  const why = h('p.check-result');
  const section = h(`section.check${block.guess ? '.guess' : ''}`, null,
    h('div.check-label', null, label || (block.guess ? 'Guess first' : 'Quick check')),
    h('p.check-q', null, renderInlines(block.q)),
    box, why);

  function draw(chosen) {
    const answered = chosen !== null;
    box.replaceChildren(...options.map((option, index) => {
      const place = where(option, index);
      const picked = answered && place === chosen;
      const state = !answered ? '' : option.right ? '.right' : picked ? '.wrong' : '.other';
      return h(`button.check-option${state}`, {
        type: 'button',
        disabled: answered,
        onclick: () => {
          draw(place);
          onAnswer(place);
        },
      }, h('span.check-mark', null, !answered ? GLYPH.empty : option.right ? GLYPH.check : picked ? GLYPH.close : GLYPH.empty),
      h('span.check-text', null, renderInlines(option.inlines),
        answered ? h('span.check-why', null, renderInlines(option.why)) : null));
    }));
    const hit = options.find((option, index) => where(option, index) === chosen);
    why.textContent = !answered ? '' : block.guess ? 'Now see what the page says.' : hit?.right ? 'Right.' : 'Not quite: the reason is under each option.';
    if (answered && onWrong && !section.querySelector('.check-flag')) {
      const flag = action('This question is wrong', event => onWrong(section, event.currentTarget), 'faint');
      flag.classList.add('check-flag');
      flag.title = 'Removes it from this page and from Review';
      section.append(flag);
    }
  }
  draw(shown);
  return section;
}
