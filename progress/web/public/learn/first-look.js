// Paints the colour scheme this page last saw before anything draws, so a light scheme never
// flashes dark while the appearance loads (shared/look.js then applies the saved one and
// app.js keeps this copy fresh). A classic script, after /shared/theme.js. Kept per browser
// origin, so a fresh server (another port) starts from Ember once.
(function () {
  try {
    const theme = globalThis.ClaudeTheme;
    const saved = theme && localStorage.getItem('claude-learn-look');
    if (!saved) return;
    const appearance = theme.parseAppearance(saved);
    // A plain browser can't be see-through: the background stays solid, as look.js keeps it.
    if (!document.documentElement.classList.contains('native')) appearance.opacity.learn = 1;
    theme.applyAppearance(appearance, 'learn');
  } catch {
    // Nothing remembered: the Ember defaults in shared/theme.css stand until look.js applies.
  }
})();
