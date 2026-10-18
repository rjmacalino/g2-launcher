import jetbrainsUrl from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2?url'
import firaUrl from '@fontsource/fira-mono/files/fira-mono-latin-500-normal.woff2?url'

// The code view's own font (G2-81), bundled so code looks the same on
// every phone: the code is drawn on the phone, and a system monospace font
// differs between them (Consolas on the PC simulator, Menlo on an iPhone,
// something else on Android). Both candidates are SIL Open Font License,
// from the @fontsource packages; medium weight, which held up better than
// regular on the glasses' green.
export const CODE_FONTS = { jetbrains: jetbrainsUrl, fira: firaUrl } as const
export type CodeFontName = keyof typeof CODE_FONTS

const FALLBACK = 'Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", "Courier New", monospace'

export function codeFontStack(): string {
  return family ? `"${family}", ${FALLBACK}` : FALLBACK
}

let family = ''
let loaded = false
let ready: Promise<void> | null = null

export function isCodeFontLoaded(): boolean {
  return loaded
}

// Code must never wait long for its font (G2-91: opening code took 30 s
// on the glasses, cause unknown): past this, it draws with the fallbacks.
const LOAD_TIMEOUT_MS = 2000

// Loads the font once; resolves even if it fails, leaving the fallbacks.
export function loadCodeFont(name: CodeFontName = 'fira'): Promise<void> {
  if (ready) return ready
  const loading = (async () => {
    try {
      // A name per font, so a second font is never hidden behind the first.
      const face = new FontFace(`JarvisCode-${name}`, `url(${CODE_FONTS[name]})`, {
        weight: '500',
      })
      document.fonts.add(await face.load())
      family = face.family
      loaded = true
    } catch {
      // The system monospace fonts still line up; only the look differs.
    }
  })()
  ready = Promise.race([loading, new Promise<void>(done => setTimeout(done, LOAD_TIMEOUT_MS))])
  return ready
}
