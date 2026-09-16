import { describe, expect, it } from 'vitest'
import { CATEGORIES as backendCategories } from './categories.mjs'
import { CATEGORIES as frontendCategories } from '../src/domain/types.ts'

describe('shared category taxonomy', () => {
  it('uses identical canonical values in the browser and backend boundary', () => {
    expect(frontendCategories).toEqual(backendCategories)
  })
})
