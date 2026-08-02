import { ABORT_MESSAGE } from './shared-utils.js';

/** noeval.js — Prevent use of eval(). */
export function noeval() {
  window.eval = function () {
    throw new EvalError(ABORT_MESSAGE);
  };
}
