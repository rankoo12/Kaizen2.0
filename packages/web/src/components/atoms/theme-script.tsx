/* Sets the appearance before first paint so there's no flash.
 *
 * Must stay in sync with KaizenApp: same storage key ('kaizen.appearance'), same
 * attribute ('data-appearance'), same three values. Aperture is the design's default —
 * it's a deliberate look, not a system preference, so it does not fall back to
 * prefers-color-scheme. */
const script = `
(function () {
  try {
    var stored = window.localStorage.getItem('kaizen.appearance');
    var valid = ['aperture', 'light', 'dark'];
    document.documentElement.setAttribute(
      'data-appearance',
      valid.indexOf(stored) !== -1 ? stored : 'aperture'
    );
  } catch (e) {
    document.documentElement.setAttribute('data-appearance', 'aperture');
  }
})();
`.trim();

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
