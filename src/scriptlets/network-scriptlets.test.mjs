import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;

const { trustedReplaceFetchResponse, trustedReplaceXhrResponse } =
  await import('./trusted-replace-fetch-response.js');
const { m3uPrune } = await import('./m3u-prune.js');
const { preventXhr } = await import('./prevent-xhr.js');
const { preventFetch } = await import('./prevent-fetch.js');

/** Fresh XHR stand-in per test — statics, prototype getter, on* dispatch. */
function makeFakeXHRClass() {
  return class FakeXHR {
    static UNSENT = 0;
    static DONE = 4;
    open(method, url) { this._openedUrl = url; }
    send() { this._sent = true; }
    dispatchEvent(e) { this[`on${e.type}`]?.call(this, e); return true; }
    get responseText() { return this._responseText ?? ''; }
    get response() { return this._responseText ?? ''; }
  };
}

const jsonResponse = (body) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

// §3.8 — argument order was inverted vs uBO: arg 1 was consumed as the URL
// matcher, so the shipped rules (uBO order: pattern, replacement, propsToMatch)
// never intercepted anything.

test('trfr: shipped uBO arg order intercepts and replaces the body', async () => {
  globalThis.fetch = async () => jsonResponse('{"adPlacements":[{"ad":1}]}');
  trustedReplaceFetchResponse('adPlacements', 'no_ads', 'player?');

  const res = await window.fetch('https://www.youtube.com/youtubei/v1/player?key=x');
  const text = await res.text();
  assert.equal(text.includes('adPlacements'), false, 'body pattern must be stripped');
  assert.equal(text.includes('no_ads'), true);

  const other = await window.fetch('https://example.com/unrelated');
  assert.equal(await other.text(), '{"adPlacements":[{"ad":1}]}', 'non-matching URL untouched');
});

test('trfr: empty propsToMatch matches every URL', async () => {
  globalThis.fetch = async () => jsonResponse('body with adsOn flag');
  trustedReplaceFetchResponse('adsOn', 'adsOff');

  const res = await window.fetch('https://anything.example/x');
  assert.equal(await res.text(), 'body with adsOff flag');
});

// §5.38 — a content-type allowlist gated the replacement. uBO has no such
// gate, and YouTube's player response arrives without a usable content-type on
// some paths, so every shipped rule against it was skipped.

test('trfr: a response with no content-type is still rewritten (uBO has no gate)', async () => {
  globalThis.fetch = async () =>
    new Response('{"adPlacements":[{"ad":1}],"videoDetails":{"videoId":"abc"}}', { status: 200 });
  trustedReplaceFetchResponse('adPlacements', 'no_ads', 'player?');

  const res = await window.fetch('https://www.youtube.com/youtubei/v1/player?key=x');
  const text = await res.text();
  assert.equal(text.includes('adPlacements'), false, 'the gate must not skip an untyped body');
  assert.equal(text.includes('no_ads'), true);
  assert.equal(text.includes('videoDetails'), true, 'the rest of the body survives');
});

test('trfr: an unmatched body comes back as the original response, stream unread', async () => {
  globalThis.fetch = async () =>
    new Response('{"videoDetails":{"videoId":"abc"}}', {
      status: 200, headers: { 'content-type': 'application/octet-stream' },
    });
  trustedReplaceFetchResponse('adPlacements', 'no_ads', 'player?');

  const res = await window.fetch('https://www.youtube.com/youtubei/v1/player?key=x');
  assert.equal(res.bodyUsed, false, 'reading a clone must leave the body consumable');
  assert.equal(await res.text(), '{"videoDetails":{"videoId":"abc"}}');
});

test('trxr: shipped uBO arg order rewrites matching responses only', () => {
  const FakeXHR = makeFakeXHRClass();
  globalThis.XMLHttpRequest = FakeXHR;
  trustedReplaceXhrResponse('adPlacements', 'no_ads', 'player?');

  const xhr = new window.XMLHttpRequest();
  assert.ok(xhr instanceof FakeXHR, 'Proxy must preserve instanceof');
  xhr.open('GET', 'https://www.youtube.com/youtubei/v1/player?key=x');
  xhr._responseText = 'has adPlacements inside';
  assert.equal(xhr.responseText, 'has no_ads inside');

  const other = new window.XMLHttpRequest();
  other.open('GET', 'https://example.com/unrelated');
  other._responseText = 'has adPlacements inside';
  assert.equal(other.responseText, 'has adPlacements inside', 'non-matching URL untouched');
});

// §3.8 — m3u-prune had the same swap: it matched playlist URLs against the
// ad-segment pattern. uBO order is (m3uPattern, urlPattern).

test('m3u-prune: uBO arg order prunes matching lines from matching playlists', async () => {
  const playlist = '#EXTM3U\n#AD https://lura.live/prod/seg0.ts\nhttps://cdn.example.com/seg1.ts';
  globalThis.fetch = async () => new Response(playlist, { status: 200 });
  globalThis.XMLHttpRequest = makeFakeXHRClass();
  m3uPrune('lura.live/prod/', '/prog.m3u8');

  const res = await window.fetch('https://cdn.example.com/live/prog.m3u8');
  const text = await res.text();
  assert.equal(text.includes('lura.live/prod/'), false, 'ad line must be pruned');
  assert.equal(text.includes('seg1.ts'), true, 'content lines must survive');

  const other = await window.fetch('https://cdn.example.com/other.json');
  assert.equal(await other.text(), playlist, 'non-matching URL untouched');
});

test('m3u-prune: empty urlPattern applies to all playlists; XHR statics survive', () => {
  const FakeXHR = makeFakeXHRClass();
  globalThis.fetch = async () => new Response('x', { status: 200 });
  globalThis.XMLHttpRequest = FakeXHR;
  m3uPrune('ad-segment');

  // §5.33 — the old bare replacement function dropped the statics.
  assert.equal(window.XMLHttpRequest.DONE, 4, 'static constants must survive the patch');

  const xhr = new window.XMLHttpRequest();
  xhr.open('GET', 'https://cdn.example.com/any.m3u8');
  xhr._responseText = 'keep\n#AD ad-segment/0.ts\nkeep2';
  assert.equal(xhr.responseText, 'keep\nkeep2');
});

// §5.33 — prevent-xhr replaced XMLHttpRequest with a plain function: statics
// gone (readyState === XMLHttpRequest.DONE compared against undefined),
// onreadystatechange never fired, and the blocked flag was an own property.

test('prevent-xhr: statics survive and a blocked request completes properly', async () => {
  const FakeXHR = makeFakeXHRClass();
  globalThis.XMLHttpRequest = FakeXHR;
  preventXhr('doubleclick');

  assert.equal(window.XMLHttpRequest.DONE, 4, 'static constants must survive the patch');

  const xhr = new window.XMLHttpRequest();
  assert.ok(xhr instanceof window.XMLHttpRequest, 'Proxy must preserve instanceof');
  let stateChanges = 0;
  let loads = 0;
  xhr.onreadystatechange = function () {
    if (this.readyState === window.XMLHttpRequest.DONE) stateChanges++;
  };
  xhr.onload = () => { loads++; };

  xhr.open('GET', 'https://ad.doubleclick.net/gampad');
  xhr.send();
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(xhr.readyState, 4, 'blocked request must reach DONE');
  assert.equal(stateChanges, 1, 'onreadystatechange must fire and see DONE');
  assert.equal(loads, 1, 'onload must fire once');
  assert.equal(xhr._sent, undefined, 'the network must not be touched');
  assert.equal(
    Object.prototype.hasOwnProperty.call(xhr, '__blocked__'), false,
    'no detectable own marker property',
  );

  const passthrough = new window.XMLHttpRequest();
  passthrough.open('GET', 'https://example.com/data.json');
  passthrough.send();
  assert.equal(passthrough._openedUrl, 'https://example.com/data.json');
  assert.equal(passthrough._sent, true, 'non-matching requests must go through');
});

// §5.37 — prevent-fetch treated argument 1 as a raw substring, so uBO's
// `key:value` propsToMatch form (49 shipped rules) never matched anything.

test('prevent-fetch: uBO key:value propsToMatch form', async () => {
  let realCalls = 0;
  globalThis.fetch = async () => { realCalls++; return new Response('real'); };
  preventFetch('method:HEAD');

  const blocked = await window.fetch('https://example.com/probe', { method: 'HEAD' });
  assert.equal(await blocked.text(), '', 'HEAD request must be stubbed');
  assert.equal(realCalls, 0);

  const passed = await window.fetch('https://example.com/probe', { method: 'GET' });
  assert.equal(await passed.text(), 'real', 'other methods must pass through');
  assert.equal(realCalls, 1);
});

test('prevent-fetch: url: prefix, conjunction, and bare patterns still work', async () => {
  let realCalls = 0;
  globalThis.fetch = async () => { realCalls++; return new Response('real'); };
  preventFetch('url:gampad method:POST');

  const blocked = await window.fetch('https://pubads.g.doubleclick.net/gampad/ads', { method: 'POST' });
  assert.equal(await blocked.text(), '');
  const wrongMethod = await window.fetch('https://pubads.g.doubleclick.net/gampad/ads');
  assert.equal(await wrongMethod.text(), 'real', 'all conditions must hold');

  globalThis.fetch = async () => { realCalls++; return new Response('real'); };
  preventFetch('adsbygoogle');
  const bare = await window.fetch('https://example.com/adsbygoogle.js');
  assert.equal(await bare.text(), '', 'bare substring form must keep working');

  // Only the non-matching request should ever have reached the network. The
  // body assertions alone cannot show this — a scriptlet that let a blocked
  // request through and then discarded its body would pass them.
  assert.equal(realCalls, 1, 'exactly one request should have hit the real fetch');
});
