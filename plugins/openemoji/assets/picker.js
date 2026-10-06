// OpenEmoji picker for tsbb composers. Progressive: the <details> already
// works without this file (popular emoji + shortcodes); this adds search,
// groups, recents and inserting at the caret. No inline styles and no
// innerHTML, because the board's CSP allows neither.
(() => {
  'use strict';

  const GROUP_ICONS = {
    'Smileys & Emotion': 'smile', 'People & Body': 'users', 'Animals & Nature': 'leaf',
    'Food & Drink': 'coffee', 'Travel & Places': 'globe', Activities: 'trophy',
    Objects: 'lightbulb', Symbols: 'hash', Flags: 'flag',
  };
  const RECENT_KEY = 'tsbb:recent-emoji';
  const SVG = 'http://www.w3.org/2000/svg';
  let indexPromise = null;

  const key = (char) => Array.from(char, (c) => c.codePointAt(0).toString(16)).join('-');

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const child of children || []) node.append(child);
    return node;
  }

  function icon(base, name) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'oe-icon');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', `${base}/sprite.svg#oi-${name}`);
    svg.append(use);
    return svg;
  }

  function readRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(list) ? list.filter((c) => typeof c === 'string').slice(0, 24) : [];
    } catch {
      return [];
    }
  }

  function pushRecent(char) {
    const list = [char, ...readRecent().filter((c) => c !== char)].slice(0, 24);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {
      // storage blocked: recents just do not persist
    }
  }

  function loadIndex(base) {
    if (!indexPromise) {
      indexPromise = fetch(`${base}/index.json`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((index) => ({
          groups: index.groups,
          emoji: index.emoji.map(([char, name, group, words]) => ({
            char, name, group, search: `${name} ${words}`.toLowerCase(),
          })),
        }))
        .catch((err) => {
          indexPromise = null;
          throw err;
        });
    }
    return indexPromise;
  }

  function search(emoji, query) {
    const q = query.toLowerCase().trim().replace(/\s+/g, ' ');
    const terms = q.split(' ').filter(Boolean);
    if (!terms.length) return [];
    const ranked = [];
    emoji.forEach((e, i) => {
      if (!terms.every((t) => e.search.includes(t))) return;
      const name = e.name.toLowerCase();
      ranked.push([name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3, i, e]);
    });
    ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return ranked.slice(0, 200).map((r) => r[2]);
  }

  function insert(textarea, char) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.value = textarea.value.slice(0, start) + char + textarea.value.slice(end);
    const caret = start + char.length;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function enhance(details) {
    const base = details.dataset.base;
    const form = details.closest('form');
    const textarea = form && form.querySelector('textarea[name="body"]');
    if (!base || !textarea) return;
    const panel = details.querySelector('.oe-panel');

    function pick(char) {
      pushRecent(char);
      insert(textarea, char);
    }

    panel.addEventListener('click', (event) => {
      const cell = event.target.closest('.oe-cell');
      if (cell && cell.dataset.char) pick(cell.dataset.char);
    });

    details.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        details.open = false;
        details.querySelector('summary').focus();
      }
    });

    let built = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || built) return;
      built = true;
      let index;
      try {
        index = await loadIndex(base);
      } catch {
        built = false;
        return; // the popular row and shortcodes still work
      }

      const input = el('input', { type: 'search', class: 'oe-search-input', placeholder: 'Search emoji', 'aria-label': 'Search emoji' });
      const tabs = el('div', { class: 'oe-tabs', role: 'tablist' });
      const grid = el('div', { class: 'oe-grid' });
      let tab = readRecent().length ? 'recent' : 0;

      function cell(e) {
        return el('button', { type: 'button', class: 'oe-cell', 'data-char': e.char, title: e.name, 'aria-label': e.name }, [
          el('img', { src: `${base}/64/${key(e.char)}.webp`, alt: e.char, width: '24', height: '24', loading: 'lazy' }),
        ]);
      }

      function show() {
        const q = input.value.trim();
        tabs.hidden = Boolean(q);
        const byChar = new Map(index.emoji.map((e) => [e.char, e]));
        const list = q
          ? search(index.emoji, q)
          : tab === 'recent'
            ? readRecent().map((c) => byChar.get(c)).filter(Boolean)
            : index.emoji.filter((e) => e.group === tab);
        grid.replaceChildren(...(list.length ? list.map(cell) : [el('p', { class: 'oe-empty', text: q ? 'No emoji match.' : 'Nothing here yet.' })]));
        for (const button of tabs.children) button.setAttribute('aria-selected', String(button.dataset.tab === String(tab)));
      }

      const tabIds = [...(readRecent().length ? ['recent'] : []), ...index.groups.map((_, i) => i)];
      for (const id of tabIds) {
        const label = id === 'recent' ? 'Recent' : index.groups[id];
        const button = el('button', { type: 'button', class: 'oe-tab', role: 'tab', title: label, 'aria-label': label, 'data-tab': String(id) }, [
          icon(base, id === 'recent' ? 'clock' : GROUP_ICONS[label] || 'smile'),
        ]);
        button.addEventListener('click', () => {
          tab = id;
          show();
        });
        tabs.append(button);
      }

      input.addEventListener('input', show);
      const searchRow = el('label', { class: 'oe-search' }, [icon(base, 'search'), input]);
      panel.prepend(searchRow, tabs, grid);
      details.classList.add('oe-enhanced');
      show();
      input.focus();
    });
  }

  function init() {
    document.querySelectorAll('details.oe-picker').forEach(enhance);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
