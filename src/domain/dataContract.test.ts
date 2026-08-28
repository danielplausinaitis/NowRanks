import { describe, expect, it } from 'vitest'
import { GoogleTrendingNowSearchDataProvider } from '../data/googleTrendingNowProvider'
import { TIME_WINDOWS } from './config'
import { assertScorableTopicData, assertValidObservation } from './dataContract'
import { scoreTopics } from './scoring'
import type { SearchTopicData, TopicObservation } from './types'

const availableObservation = (candidateId: string, interest: number): TopicObservation => ({
  candidateId,
  date: '2026-08-25',
  observedAt: '2026-08-25T00:00:00.000Z',
  availability: 'available',
  interest,
})

function candidate(observations: TopicObservation[], comparability: 'comparable' | 'not-comparable' | 'unknown' = 'comparable'): SearchTopicData {
  return {
    id: 'candidate:example',
    topic: 'Example query',
    normalizedQuery: 'example query',
    category: 'Technology',
    provenance: {
      providerId: 'contract-test-provider',
      dataMode: 'test',
      sourceObservedAt: '2026-08-25T00:00:00.000Z',
      ingestedAt: '2026-08-25T00:01:00.000Z',
      geographicScope: { kind: 'global' },
      collectionMethod: 'deterministic-contract-test',
      crossQueryComparability: { status: comparability, basis: 'controlled test data' },
    },
    observations,
  }
}

describe('canonical live-data contract', () => {
  it('identifies the bundled Google source as replay data, including deterministic provenance', async () => {
    const [replayCandidate] = await new GoogleTrendingNowSearchDataProvider().getCandidates()
    expect(replayCandidate.provenance).toMatchObject({
      providerId: 'google-trending-now',
      dataMode: 'replay',
      geographicScope: { kind: 'global' },
      crossQueryComparability: { status: 'comparable' },
    })
  })

  it('keeps a zero interest measurement distinct from missing interest and never scores missing data as zero', () => {
    const zero = availableObservation('candidate:example', 0)
    const missing: TopicObservation = {
      candidateId: 'candidate:example',
      date: '2026-08-25',
      observedAt: '2026-08-25T00:00:00.000Z',
      availability: 'missing',
      interest: null,
      missingReason: 'not-reported',
    }

    expect(zero).toMatchObject({ availability: 'available', interest: 0 })
    expect(missing).toMatchObject({ availability: 'missing', interest: null })
    expect(() => assertValidObservation(zero)).not.toThrow()
    expect(() => assertValidObservation(missing)).not.toThrow()
    expect(() => scoreTopics([candidate([missing])])).toThrow(/missing interest data/i)
  })

  it('rejects malformed observations before they reach scoring', () => {
    const invalid = { ...availableObservation('candidate:example', 10), interest: -1 } as TopicObservation
    expect(() => assertValidObservation(invalid)).toThrow(/finite non-negative/i)
  })

  it('retains all four current ranking windows', () => {
    expect(TIME_WINDOWS).toEqual({ '24H': 1, '7D': 7, '30D': 30, '1Y': 365 })
  })

  it('records snapshot time, scoring mode, selected window, and ranked candidates', async () => {
    const [snapshot] = await new GoogleTrendingNowSearchDataProvider().getSnapshots()
    expect(snapshot).toMatchObject({
      date: '2026-08-24',
      snapshotAt: '2026-08-24T00:00:00.000Z',
      scoringMode: 'overallScore',
      selectedWindow: '30D',
    })
    expect(snapshot.entries[0]).toMatchObject({ rank: 1, finalScore: expect.any(Number) })
  })

  it('represents cross-query comparability and rejects non-comparable sources from scoring', () => {
    const nonComparable = candidate([availableObservation('candidate:example', 10)], 'not-comparable')
    expect(nonComparable.provenance.crossQueryComparability.status).toBe('not-comparable')
    expect(() => assertScorableTopicData([nonComparable])).toThrow(/not cross-query comparable/i)
    expect(() => scoreTopics([nonComparable])).toThrow(/not cross-query comparable/i)
  })

  it('keeps canonical replay candidates and observations deterministic', async () => {
    const first = new GoogleTrendingNowSearchDataProvider()
    const second = new GoogleTrendingNowSearchDataProvider()
    await expect(first.getAllTopicData()).resolves.toEqual(await second.getAllTopicData())
  })
})
