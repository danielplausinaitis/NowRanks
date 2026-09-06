import { describe, expect, it } from 'vitest'
import { createAnalytics } from './events'

describe('analytics', () => {
  it('is safe when no provider is configured', () => expect(() => createAnalytics().track('app_open')).not.toThrow())
})
