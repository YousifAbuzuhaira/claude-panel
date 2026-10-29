// The colour scheme every page wears, and how see-through its background is: the twin of
// widget/Theme.ps1. Three colours (bg, accent, text) make every role, the same way in both;
// tests/theme-vectors.json holds the expected values for both.
//
// A classic script, not a module: web pages load it with <script src="/shared/theme.js">,
// mac/panel.html loads it over file://, and node tests import it and read globalThis.ClaudeTheme.
;(function (root) {
  'use strict'

  const DEFAULT_COLORS = { bg: '#1C1D20', accent: '#E08A5F', text: '#E8E6E3' }
  const DEFAULT_OPACITY = { panel: 0.92, learn: 0.96, games: 0.95 }
  // Below this a native window's empty background no longer takes clicks.
  const MIN_OPACITY = 0.15
  const ROLES = [
    'ink', 'dim', 'faint', 'accent', 'accentSoft', 'selected', 'onAccent',
    'green', 'red', 'gold', 'blue', 'greenSoft', 'redSoft', 'goldSoft', 'blueSoft',
    'line', 'rule', 'edge', 'hover', 'pressed', 'surface', 'surface2', 'button', 'well',
    'codeBg', 'codeInline', 'codeInk', 'scroll', 'popup', 'cardFill', 'veil',
  ]
  const DARK_STATUS = { green: '#5FB98A', red: '#E0696B', gold: '#E6BE47', blue: '#7FB2E5' }
  const LIGHT_STATUS = { green: '#2F8A5B', red: '#C23B3E', gold: '#9A6B00', blue: '#2C6CB0' }

  // --- Colour arithmetic (bytes, rounded as Theme.ps1 rounds) ---------------------------------

  function parseHex(hex) {
    if (typeof hex !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(hex)) return null
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
  }

  const byte = value => Math.min(255, Math.max(0, Math.floor(value + 0.5)))
  const mix = (a, b, t) => [0, 1, 2].map(i => byte(a[i] * (1 - t) + b[i] * t))
  const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0')

  // '#AARRGGBB', the same text Theme.ps1 writes, so the two can be compared.
  const format = (rgb, alpha = 1) => `#${hex2(byte(alpha * 255))}${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`

  function luminance(rgb) {
    const weights = [0.2126, 0.7152, 0.0722]
    let sum = 0
    for (let i = 0; i < 3; i++) {
      let c = rgb[i] / 255
      c = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      sum += weights[i] * c
    }
    return sum
  }

  function contrast(a, b) {
    const la = luminance(a)
    const lb = luminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }

  // --- The palette ------------------------------------------------------------------------------

  /** Every role as '#AARRGGBB', from {bg, accent, text} and this window's background opacity. */
  function derivePalette(colors, opacity) {
    const bg = parseHex(colors && colors.bg) || parseHex(DEFAULT_COLORS.bg)
    const accent = parseHex(colors && colors.accent) || parseHex(DEFAULT_COLORS.accent)
    const text = parseHex(colors && colors.text) || parseHex(DEFAULT_COLORS.text)
    const black = [0, 0, 0]
    const white = [255, 255, 255]

    // Dark or light by which of black and white reads better on the background.
    const isDark = contrast(bg, white) >= contrast(bg, black)
    const status = isDark ? DARK_STATUS : LIGHT_STATUS

    // Text on an accent fill: whichever of bg and text stands out more, or a plain dark or light.
    let onAccent = contrast(text, accent) > contrast(bg, accent) ? text : bg
    if (contrast(onAccent, accent) < 3) onAccent = luminance(accent) > 0.3 ? [0x1c, 0x1d, 0x20] : [0xf5, 0xf3, 0xef]

    const op = Math.min(1, Math.max(MIN_OPACITY, Number.isFinite(opacity) ? opacity : 1))
    // Secondary text: further from the text on a dark scheme than a light one, so both read alike;
    // and nearer the text as the background clears, so it stays legible over whatever shows through.
    const [dimT, faintT] = isDark ? [0.43, 0.62] : [0.36, 0.52]
    const clear = Math.max(0.35, Math.min(1, (op - 0.15) / 0.65))
    const p = {}
    p.ink = format(text)
    p.dim = format(mix(text, bg, dimT * clear))
    p.faint = format(mix(text, bg, faintT * clear))
    p.accent = format(accent)
    p.accentSoft = format(accent, 0.33)
    p.selected = format(accent, 0.15)
    p.onAccent = format(onAccent)
    for (const name of ['green', 'red', 'gold', 'blue']) {
      const rgb = parseHex(status[name])
      p[name] = format(rgb)
      p[`${name}Soft`] = format(rgb, 0.27)
    }
    p.line = format(text, 0.19)
    p.rule = format(text, 0.15)
    p.edge = format(text, 0.2)
    p.hover = format(text, 0.09)
    p.pressed = format(text, 0.14)
    p.surface = format(text, 0.08)
    p.surface2 = format(text, 0.045)
    p.button = format(text, 0.14)
    p.well = format(text, 0.03)
    p.codeBg = isDark ? format(black, 0.3) : format(text, 0.05)
    p.codeInline = format(text, 0.13)
    p.codeInk = format(mix(text, accent, 0.15))
    p.scroll = format(text, 0.22)
    // Tooltips and menus: solid, a step off the background.
    p.popup = format(mix(bg, text, 0.1))
    p.cardFill = format(bg, op)
    p.veil = format(bg, 0.85)
    p.isDark = isDark
    return p
  }

  /** '#AARRGGBB' to a CSS colour. */
  function cssColor(argb) {
    const a = parseInt(argb.slice(1, 3), 16)
    const r = parseInt(argb.slice(3, 5), 16)
    const g = parseInt(argb.slice(5, 7), 16)
    const b = parseInt(argb.slice(7, 9), 16)
    if (a === 255) return `#${argb.slice(3).toLowerCase()}`
    return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`
  }

  /** camelCase role to its CSS variable: accentSoft -> --accent-soft, surface2 -> --surface2. */
  const cssName = role => `--${role.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`

  // --- The appearance --------------------------------------------------------------------------

  function clampOpacity(value, fallback) {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(1, Math.max(MIN_OPACITY, n))
  }

  /** The person's choice, field by field: anything missing or malformed is today's look. */
  function parseAppearance(value) {
    const out = {
      preset: 'ember',
      colors: { ...DEFAULT_COLORS },
      opacity: { ...DEFAULT_OPACITY },
    }
    let saved = value
    if (typeof value === 'string') {
      try { saved = JSON.parse(value) } catch { saved = null }
    }
    if (!saved || typeof saved !== 'object') return out
    if (typeof saved.preset === 'string' && saved.preset) out.preset = saved.preset.replace(/[^A-Za-z0-9_-]/g, '')
    for (const key of ['bg', 'accent', 'text']) {
      const hex = saved.colors && saved.colors[key]
      if (parseHex(hex)) out.colors[key] = hex.toUpperCase()
    }
    for (const key of ['panel', 'learn', 'games']) {
      if (saved.opacity && saved.opacity[key] != null) out.opacity[key] = clampOpacity(saved.opacity[key], DEFAULT_OPACITY[key])
    }
    return out
  }

  /** Presets.json to [{name, label, bg, accent, text}], keeping only well-formed ones. */
  function parsePresets(value) {
    let data = value
    if (typeof value === 'string') {
      try { data = JSON.parse(value) } catch { data = null }
    }
    const list = (data && Array.isArray(data.presets) ? data.presets : []).filter(
      p => p && typeof p.name === 'string' && parseHex(p.bg) && parseHex(p.accent) && parseHex(p.text),
    )
    return list.length ? list : [{ name: 'ember', label: 'Ember', ...DEFAULT_COLORS }]
  }

  /**
   * Sets every role as a CSS variable on `el` (default: the root element) for this window's group
   * ('panel', 'learn' or 'games'), plus color-scheme, so form controls follow light or dark.
   */
  function applyAppearance(appearance, group, el) {
    const a = parseAppearance(appearance)
    const target = el || (root.document && root.document.documentElement)
    const palette = derivePalette(a.colors, a.opacity[group] ?? 1)
    if (target && target.style) {
      for (const role of ROLES) target.style.setProperty(cssName(role), cssColor(palette[role]))
      target.style.setProperty('color-scheme', palette.isDark ? 'dark' : 'light')
      target.dataset.scheme = palette.isDark ? 'dark' : 'light'
    }
    return palette
  }

  root.ClaudeTheme = {
    DEFAULT_COLORS,
    DEFAULT_OPACITY,
    MIN_OPACITY,
    ROLES,
    parseHex,
    contrast,
    derivePalette,
    cssColor,
    cssName,
    parseAppearance,
    parsePresets,
    applyAppearance,
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
