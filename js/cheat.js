/* ═══════════════════════════════════════════════════════════
   cheat.js — the way out, for when there is no way out

   Dial 6 7 6 7 … on the keypad, thirteen times over, and the
   worked detector appears in the editor. It is meant to be
   passed on to someone who has been stuck for an hour, which
   is why it is not in the README.

   Three things it has to get right:

     · the presses are read off the keypad, not off what came
       back from Python. A cheat that only works once your
       detector works is no use to anyone who needs it.

     · what it puts in the editor is never written to storage.
       Reload and your own code is back, exactly as you left
       it — that is the only way out of the cheat, and it has
       to be a way back to your own work, not to the answer.

     · Ctrl+Z puts your code back straight away. The badge
       stays lit through it: the page remembers having been
       shown the answer, and only a reload forgets.
   ═══════════════════════════════════════════════════════════ */

const Cheat = (() => {

  /* Two keys, alternating, thirteen times. Long enough that nobody dials it
     by accident, short enough to pass on across a room. */
  const CODE = '67676767676767676767676767';

  const hooks = {};
  let badge = null;
  let buf = '';
  let swapped = false;      // is the editor showing the worked detector
  let before = null;        // what was in it before it did

  /**
   * One key off the pad — mouse or PC keyboard, both arrive here. Never a
   * character out of the detector.
   */
  function press(ch) {
    if (!ch) return;
    buf = (buf + ch).slice(-CODE.length);
    if (buf !== CODE) return;
    buf = '';
    fire();
  }

  function fire() {
    const src = window.DTMF_SOLUTION;
    if (!src) return;                       // solution.js was not loaded
    if (!swapped) before = Editor.getSource();
    swapped = true;

    // persist: false — their code stays in storage, whatever happens here
    Editor.setSource(src, { persist: false });
    light();
    if (hooks.onFire) hooks.onFire();
  }

  /** Put back what the user had. Answers whether there was anything to undo. */
  function undo() {
    if (!swapped) return false;
    swapped = false;
    Editor.setSource(before === null ? '' : before);
    before = null;
    if (hooks.onUndo) hooks.onUndo();
    return true;
  }

  /** Once on, on until the page is reloaded. */
  function light() {
    if (badge) badge.hidden = false;
  }

  function init(opts) {
    Object.assign(hooks, opts || {});
    badge = document.getElementById('cheat-badge');

    /* Capture, so this runs before CodeMirror's own keymap: the swap is one
       edit and the undo of it is this, not the editor's history, which would
       go on to undo whatever the user had done before. */
    window.addEventListener('keydown', e => {
      if (!swapped) return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key !== 'z' && e.key !== 'Z') return;
      if (!undo()) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  return { init, press, isOn: () => !!(badge && !badge.hidden) };
})();
