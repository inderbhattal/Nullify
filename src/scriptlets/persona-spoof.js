const PERSONAS = {
  windows: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Win32',
    uaPlatform: 'Windows',
    platformVersion: '15.0.0',
  },
  mac: {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    uaPlatform: 'macOS',
    platformVersion: '13.0.0',
  },
  linux: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    uaPlatform: 'Linux',
    platformVersion: '6.0.0',
  },
};

const BRANDS = [
  { brand: 'Chromium', version: '122' },
  { brand: 'Not(A:Brand', version: '24' },
  { brand: 'Google Chrome', version: '122' },
];

function defineGetter(target, key, getter) {
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      get: getter,
    });
    return true;
  } catch {
    return false;
  }
}

function defineNavigatorValue(key, value) {
  if (defineGetter(Navigator.prototype, key, () => value)) return;
  defineGetter(navigator, key, () => value);
}

export function personaSpoof(personaId = 'default') {
  const persona = PERSONAS[personaId];
  if (!persona) return;

  if (globalThis.__nullifyPersonaSpoof === personaId) return;
  globalThis.__nullifyPersonaSpoof = personaId;

  defineNavigatorValue('userAgent', persona.userAgent);
  defineNavigatorValue('appVersion', persona.userAgent.replace(/^Mozilla\/5\.0\s*/, ''));
  defineNavigatorValue('platform', persona.platform);

  if (!navigator.userAgentData) return;

  const original = navigator.userAgentData;
  const architectureMap = {
    'Win32': 'x86',
    'MacIntel': 'x86',
    'Linux x86_64': 'x86',
  };

  const spoofed = {
    brands: BRANDS,
    mobile: false,
    platform: persona.uaPlatform,
    async getHighEntropyValues(hints = []) {
      const base = typeof original.getHighEntropyValues === 'function'
        ? await original.getHighEntropyValues(hints)
        : {};
      const result = { ...base };
      const hintSet = new Set(hints);
      if (hintSet.has('platformVersion')) result.platformVersion = persona.platformVersion;
      if (hintSet.has('architecture')) result.architecture = architectureMap[persona.platform] || 'x86';
      if (hintSet.has('bitness')) result.bitness = '64';
      if (hintSet.has('model')) result.model = '';
      if (hintSet.has('uaFullVersion')) result.uaFullVersion = '122.0.0.0';
      if (hintSet.has('fullVersionList')) result.fullVersionList = BRANDS;
      return result;
    },
    toJSON() {
      return {
        brands: BRANDS,
        mobile: false,
        platform: persona.uaPlatform,
      };
    },
  };

  defineNavigatorValue('userAgentData', spoofed);
}
