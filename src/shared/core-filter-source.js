export const CORE_FILTER_SOURCE_ID = '__core';

export const COSMETIC_SELECTOR_DENYLIST = {
  'mail.google.com': [
    // EasyList periodically ships Gmail layout selectors that now match the
    // active reading pane/message body. Drop them at ingestion instead of
    // relying on exception CSS to undo a bad hide rule after it is emitted.
    '.nH.PS',
    '.aeF > .nH > .nH[role="main"] > .aKB',
  ],
};

const COSMETIC_SELECTOR_DENYSETS = new Map(
  Object.entries(COSMETIC_SELECTOR_DENYLIST).map(([domain, selectors]) => [
    domain,
    new Set(selectors),
  ])
);

export function shouldSkipDomainCosmeticSelector(domain, selector) {
  const normalizedDomain = String(domain || '').trim().toLowerCase();
  const normalizedSelector = String(selector || '').trim();
  return COSMETIC_SELECTOR_DENYSETS.get(normalizedDomain)?.has(normalizedSelector) === true;
}

export function shouldSkipGenericCosmeticForHostname(hostname, excludedDomains = []) {
  const normalizedHostname = String(hostname || '').trim().toLowerCase();
  return (excludedDomains || []).some(
    (domain) => normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`)
  );
}

export const CORE_FILTER_SOURCE = {
  cosmetic: {
    generic: [
      '.ad', '.ads', '.ad-block', '.ad-container', '.ad-banner', '.ad-unit',
      '.ad-wrapper', '.adsbygoogle', '.advertisement', '.advertisements',
      '.advertising', '.banner-ads', '.display-ads', '#ad', '#ads',
      '#ad-container', '#ad-banner', '#advertisement', '#sidebar-ad',
      '.sponsored', '.sponsor', '[id^="ad_"]', '[class^="ad_"]',
      '[id*="advertisement"]', '[class*="advertisement"]',
      '#google_ads_iframe_*', '.google-ad', '#carbonads', '.carbon-ads',
      '#cookie-banner', '.cookie-banner', '.cookie-notice', '#gdpr-banner',
      '.gdpr-notice', '.privacy-banner', '#privacy-notice',
      '.newsletter-overlay', '.newsletter-popup', '#newsletter-modal',
      '.social-share-bar', '.social-floating', '.addthis_toolbox',
    ],
    domainSpecific: {
      'google.com': [
        'div[data-text-ad]',
        'div[data-ad-block]',
        '.commercial-unit-desktop-top',
        '.commercial-unit-desktop-rhs',
        '#tads',
        '#tadsb',
        '#res .g .psli',
        '#res .g .pslt',
        '#center_col .mitem',
        '.commercial-unit-mobile-top',
        '.commercial-unit-mobile-bottom',
        '.mod > ._e4b',
        'div[data-pcu]',
        'div[data-hveid] > div:has(div[data-pcu])',
        '#media_result_grouping',
        '.mnr-c > .O9S7Ff',
        '.pla-unit-container',
        '.pla-unit',
      ],
      'youtube.com': [
        '.ytd-promoted-video-renderer',
        '.ytd-ad-slot-renderer',
        'ytd-action-companion-ad-renderer',
        'ytd-display-ad-renderer',
        'ytd-video-masthead-ad-v3-renderer',
        '#masthead-ad',
        '.ytp-ad-module',
      ],
      'reddit.com': [
        '.promotedlink', '[data-promoted="true"]', '.ad-result',
        '[data-adtype]', '.ad-container--reddit',
      ],
      'facebook.com': [
        '._7jyg._7jyi', '._5jmm._3ah0',
        '[data-pagelet="AdsFeedUnit"]',
      ],
      'twitter.com': [
        '[data-testid="placementTracking"]',
        '[data-testid="UserCell"] + [data-testid="UserCell"]',
      ],
      'x.com': [
        '[data-testid="placementTracking"]',
      ],
      'cnn.com': [
        // `.ad-slot-header:remove()` was invalid as a raw selector —
        // `:remove()` is a uBO procedural operator, not CSS. Removed; the
        // `.ad-slot-header` rule below still hides the element.
        'div.ad-slot-header',
        '.ad-slot',
        '.ad-slot-header',
        '[class*="ad-slot"]',
        '.ad-slot__wrapper',
        '.ad-slot__ad-wrapper',
        '.ad-slot-dynamic',
        '.ad-slot-header__wrapper',
        '[class*="banner-ad"]',
        '[data-ad-format]',
        '.ad-container',
        '.el__ad',
        '.cnn-ad',
        '.commercialContent',
        '.ad-feedback-link',
        '.ad-feedback__modal',
        '.zn-body__paragraph--sponsored',
        '#ad-slot-header',
        '#js-outbrain-rightrail-ads-module',
        '#partner-zone',
        '#sponsored-outbrain-1',
        '.stack__ads',
        '.zone__ads',
        '[data-zone-label="Paid Partner Content"]',
        '[data-zone-label="PAID PARTNER CONTENT"]',
        '.featured-product__card',
        '.product-offer-card-container_related-products',
      ],
      'greenhouse.io': [
        // `section:has(h2:has-text(Featured Jobs))` was invalid:
        // `:has-text(...)` is a uBO procedural operator whose argument
        // also needs quoting. Raw CSS fallbacks below cover the
        // straightforward cases.
        '.featured-jobs',
        '.job-post:has(.featured)',
        '.featured',
      ],
      'greenhouse.com': [
        '#api-v1-tracking',
        '.tracking-pixel',
      ],
      'nytimes.com': [
        '.ad-container', '.ad-unit-wrapper', '#dfp-ad-top',
        '[id^="dfp-ad"]', '.nytd-ads-wrapper',
      ],
      'forbes.com': [
        '.fbs-ad', '.fbs-ad--slot', '[data-ad-unit]',
      ],
      'dailymail.co.uk': [
        '.article-text .sponsored-links', '.mol-ads-below-module',
        '[data-mol-fe-page-type="ad"]',
      ],
    },
    exceptions: {},
  },
  scriptlets: [
    { type: 'scriptlet', domains: ['example.com'], name: 'abort-on-property-read', args: ['_sp_'] },
    { type: 'scriptlet', domains: ['somesite.com'], name: 'set-constant', args: ['adblockEnabled', 'false'] },
  ],
};
