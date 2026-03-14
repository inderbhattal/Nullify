/** noeval.js — Prevent use of eval(). */
export function noeval() {
  window.eval = function () {
    throw new EvalError('AdBlock: eval() blocked');
  };
}
