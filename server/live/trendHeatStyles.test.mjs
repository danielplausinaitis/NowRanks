import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync('src/styles/global.css', 'utf8')

describe('Heat presentation styles', () => {
  it('maps Stable to static and every escalating Heat level to an appropriately sized flame animation', () => {
    expect(stylesheet).toMatch(/\.heat--stable \{ color: #94a0b2; \}/)
    expect(stylesheet).toMatch(/\.heat--rising i \{ width: 7px; height: 7px; animation: heat-flicker 2\.6s/)
    expect(stylesheet).toMatch(/\.heat--fast i \{ width: 9px; height: 9px; animation: heat-flicker 1\.65s/)
    expect(stylesheet).toMatch(/\.heat--surging i \{ width: 11px; height: 11px; animation: heat-flicker 1\.05s/)
    expect(stylesheet).toMatch(/\.heat--exploding i \{ width: 13px; height: 13px;[\s\S]*heat-flicker \.62s/)
  })

  it('turns off Heat animation for reduced motion', () => {
    expect(stylesheet).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/)
  })
})
