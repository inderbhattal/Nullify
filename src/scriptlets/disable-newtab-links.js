/** disable-newtab-links.js — Open links that would open a new tab in the same tab. */
export function disableNewtabLinks() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[target]');
    if (a && a.target !== '_self') {
      a.target = '_self';
    }
  }, true);
}
