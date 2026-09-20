import { buildNavigatorPersona, detectChromeMajor } from '../shared/personas.js';
import { defineNavigatorValue } from './shared-utils.js';

// Module-scope guard. A global flag was page-writable — one inline script
// setting it disabled the scriptlet — and enumerable via Object.keys(window).
let appliedPersona = null;

export function personaSpoof(personaId = 'default') {
  // §5.9 — the persona table lived here as literals frozen at one Chrome
  // major, which dates the claim instead of hiding it. The strings now come
  // from the module the service worker's header rule is built from, carrying
  // the major of the browser this page really runs in. Detected here rather
  // than at module scope: the bundle loads in every frame that runs any
  // scriptlet, this runs only when a persona is set.
  const persona = buildNavigatorPersona(personaId, detectChromeMajor());
  if (!persona) return;

  if (appliedPersona === personaId) return;
  appliedPersona = personaId;

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
    brands: persona.brands,
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
      if (hintSet.has('uaFullVersion')) result.uaFullVersion = persona.uaFullVersion;
      if (hintSet.has('fullVersionList')) result.fullVersionList = persona.brands;
      return result;
    },
    toJSON() {
      return {
        brands: persona.brands,
        mobile: false,
        platform: persona.uaPlatform,
      };
    },
  };

  defineNavigatorValue('userAgentData', spoofed);
}
