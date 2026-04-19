const script = `
(function () {
  try {
    var stored = window.localStorage.getItem('kaizen:theme');
    var valid = ['nebula', 'deep-space', 'solar-flare'];
    var theme = valid.indexOf(stored) !== -1 ? stored : 'nebula';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'nebula');
  }
})();
`.trim();

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
