/** prevent-add-event-listener.js — Block addEventListener calls matching a pattern. */
export function preventAddEventListener(eventType, pattern) {
  const re = pattern ? patternToRegex(pattern) : null;
  const origAEL = EventTarget.prototype.addEventListener;

  EventTarget.prototype.addEventListener = function (type, fn, ...rest) {
    if (type === eventType || !eventType) {
      const src = typeof fn === 'function' ? fn.toString() : String(fn);
      if (!re || re.test(src)) return;
    }
    return origAEL.call(this, type, fn, ...rest);
  };
}

function patternToRegex(p) {
  if (p.startsWith('/') && p.endsWith('/')) return new RegExp(p.slice(1, -1));
  return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
