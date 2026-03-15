/**
 * battery-spoof.js
 *
 * Spoofs the Battery Status API to return a fixed state.
 * Prevents websites from using battery levels as a fingerprinting signal.
 */
export function batterySpoof() {
  if (!navigator.getBattery) return;

  const spoofedBattery = {
    charging: true,
    chargingTime: 0,
    dischargingTime: Infinity,
    level: 1,
    onchargingchange: null,
    onchargingtimechange: null,
    ondischargingtimechange: null,
    onlevelchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };

  navigator.getBattery = () => Promise.resolve(spoofedBattery);
}
