import { normalizeSearchVolumeQuery } from './dataForSeoSearchVolume.mjs'

export const DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORD_WORDS = 10
export const DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORD_CHARACTERS = 80

const NON_SUBJECT_WORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'vs', 'versus', 'with',
  'after', 'before', 'latest', 'live', 'official', 'update', 'updates',
])

function requiredQuery(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value
}

function compactWhitespace(value) {
  return value.trim().replace(/\s+/g, ' ')
}

export function searchVolumeKeywordWordCount(value) {
  return compactWhitespace(requiredQuery(value, 'Search Volume keyword')).split(' ').length
}

function isSelectableVariant(value) {
  return searchVolumeKeywordWordCount(value) <= DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORD_WORDS
}

function terms(value) {
  return new Set(value.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [])
}

function rawVariants(candidate) {
  const values = [candidate?.rawVariants, candidate?.geoAppearances?.map((entry) => entry?.query)]
    .flat()
    .filter((value) => typeof value === 'string' && value.trim())
  return [...new Set(values.map((value) => requiredQuery(value, 'Discovery raw variant')))]
}

function bestRawVariant(candidate, canonicalQuery) {
  const canonicalTerms = terms(canonicalQuery)
  const candidates = rawVariants(candidate).filter(isSelectableVariant)
  return candidates.sort((left, right) => {
    const leftTerms = terms(left); const rightTerms = terms(right)
    const leftOverlap = [...leftTerms].filter((term) => canonicalTerms.has(term)).length
    const rightOverlap = [...rightTerms].filter((term) => canonicalTerms.has(term)).length
    return (rightOverlap - leftOverlap)
      || (searchVolumeKeywordWordCount(right) - searchVolumeKeywordWordCount(left))
      || (compactWhitespace(right).length - compactWhitespace(left).length)
      || left.localeCompare(right)
  })[0] ?? null
}

function fitToProviderCharacterLimit(words) {
  const retained = []
  for (const word of words) {
    const next = [...retained, word].join(' ')
    if (next.length > DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORD_CHARACTERS) break
    retained.push(word)
  }
  if (retained.length) return retained.join(' ')
  // A single pathological token can otherwise still violate the transport contract.
  return words[0].slice(0, DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORD_CHARACTERS)
}

/**
 * DataForSEO keyword transport accepts ordinary word characters and a small
 * ASCII punctuation subset. This does not touch canonical candidate text.
 */
export function sanitizeSearchVolumeKeyword(value) {
  const selectedVariant = requiredQuery(value, 'Selected Search Volume keyword')
  const reasons = []
  let keyword = selectedVariant
  if (/\u00a0/u.test(keyword)) { keyword = keyword.replace(/\u00a0/gu, ' '); reasons.push('non-breaking-space-to-space') }
  if (/[™®©]/u.test(keyword)) { keyword = keyword.replace(/[™®©]/gu, ' '); reasons.push('unsupported-symbol-removed') }
  const normalized = keyword.normalize('NFKC')
  if (normalized !== keyword) { keyword = normalized; reasons.push('unicode-normalized') }
  if (/[‐‑‒–—―−]/u.test(keyword)) { keyword = keyword.replace(/[‐‑‒–—―−]/gu, ' '); reasons.push('unicode-dash-to-space') }
  if (/[‘’‚‛]/u.test(keyword)) { keyword = keyword.replace(/[‘’‚‛]/gu, "'"); reasons.push('curly-apostrophe-to-ascii') }
  if (/[“”„‟]/u.test(keyword)) { keyword = keyword.replace(/[“”„‟]/gu, ' '); reasons.push('curly-double-quote-removed') }
  if (/&/u.test(keyword)) { keyword = keyword.replace(/&/gu, ' and '); reasons.push('ampersand-to-and') }
  if (/[^\p{L}\p{N}'\-\s]/u.test(keyword)) { keyword = keyword.replace(/[^\p{L}\p{N}'\-\s]/gu, ' '); reasons.push('unsupported-symbol-removed') }
  const collapsed = compactWhitespace(keyword)
  if (collapsed !== keyword) reasons.push('whitespace-collapsed')
  keyword = collapsed
  const edgeClean = keyword.replace(/^[\s'\-]+|[\s'\-]+$/gu, '')
  if (edgeClean !== keyword) reasons.push('edge-punctuation-trimmed')
  return { providerKeyword: edgeClean, keywordSanitized: reasons.length > 0, sanitizationReason: reasons }
}

function validateProviderKeyword(value) {
  if (!value) throw new Error('Could not derive a non-empty DataForSEO Search Volume provider keyword')
  if (value.length > DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORD_CHARACTERS) throw new Error('DataForSEO Search Volume provider keyword must not exceed 80 characters')
  if (searchVolumeKeywordWordCount(value) > DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORD_WORDS) throw new Error('DataForSEO Search Volume provider keyword must not exceed 10 words')
  if (/[^\p{L}\p{N}'\-\s]/u.test(value) || /^[\s'\-]|[\s'\-]$/u.test(value)) throw new Error('DataForSEO Search Volume provider keyword contains unsupported punctuation')
  return value
}

function finalProviderKeyword(selectedVariant) {
  const sanitized = sanitizeSearchVolumeKeyword(selectedVariant)
  // The provider character limit is applied before the word limit so that a
  // long but otherwise coherent phrase is shortened in the documented order.
  const characterBounded = fitToProviderCharacterLimit(sanitized.providerKeyword.split(' '))
  const providerKeyword = characterBounded.split(' ').slice(0, DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORD_WORDS).join(' ')
  return { ...sanitized, providerKeyword: validateProviderKeyword(providerKeyword) }
}

/**
 * Derives a transport-only provider keyword.  Canonical topic identity is never
 * derived from this value: cache keys, topic IDs, titles, and history retain the
 * original canonical query.
 */
export function prepareSearchVolumeKeyword(candidate) {
  const canonicalQuery = requiredQuery(candidate?.query, 'Canonical candidate query')
  if (isSelectableVariant(canonicalQuery)) {
    const prepared = finalProviderKeyword(canonicalQuery)
    return { canonicalQuery, selectedVariant: canonicalQuery, ...prepared, keywordShortened: false, shorteningReason: 'canonical-within-provider-limit' }
  }

  const variant = bestRawVariant(candidate, canonicalQuery)
  if (variant) {
    const prepared = finalProviderKeyword(variant)
    return { canonicalQuery, selectedVariant: variant, ...prepared, keywordShortened: true, shorteningReason: 'raw-discovery-variant-within-provider-limit' }
  }

  const words = compactWhitespace(canonicalQuery).split(' ')
  const subjectWords = words.filter((word) => !NON_SUBJECT_WORDS.has(word.toLocaleLowerCase('en-US')))
  const sourceWords = subjectWords.length >= 1 ? subjectWords : words
  const selectedVariant = sourceWords.join(' ')
  const prepared = finalProviderKeyword(selectedVariant)
  return {
    canonicalQuery,
    selectedVariant,
    ...prepared,
    keywordShortened: true,
    shorteningReason: subjectWords.length < words.length ? 'fallback-remove-non-subject-words' : 'fallback-leading-subject-terms',
  }
}

export function prepareSearchVolumeLookups(candidates) {
  const preparations = (candidates ?? []).map((candidate) => ({ candidate, ...prepareSearchVolumeKeyword(candidate) }))
  const providerKeywords = []
  const seenProviderKeywords = new Set()
  for (const preparation of preparations) {
    const key = normalizeSearchVolumeQuery(preparation.providerKeyword)
    if (seenProviderKeywords.has(key)) continue
    seenProviderKeywords.add(key)
    providerKeywords.push(preparation.providerKeyword)
  }
  return { preparations, providerKeywords }
}

/**
 * Re-associates provider rows with canonical candidates.  One provider keyword
 * may intentionally serve several distinct long canonical topics; each gets its
 * own cloned baseline row, keyed by its canonical normalizedQuery.
 */
export function mapSearchVolumeRecordsToCandidates({ records, preparations, providerId = null, retrievedAt = null, geographicScope = null }) {
  const byProviderKeyword = new Map()
  for (const record of records ?? []) {
    const key = normalizeSearchVolumeQuery(record.query ?? record.normalizedQuery)
    if (!byProviderKeyword.has(key)) byProviderKeyword.set(key, record)
  }
  return (preparations ?? []).map((preparation) => {
    const providerKeyword = preparation.providerKeyword
    const providerRecord = byProviderKeyword.get(normalizeSearchVolumeQuery(providerKeyword))
    const canonicalNormalizedQuery = preparation.candidate.normalizedQuery
    const diagnostics = {
      canonicalQuery: preparation.canonicalQuery,
      selectedVariant: preparation.selectedVariant,
      providerKeyword,
      keywordShortened: preparation.keywordShortened,
      keywordSanitized: preparation.keywordSanitized,
      sanitizationReason: preparation.sanitizationReason,
      shorteningReason: preparation.shorteningReason,
    }
    if (!providerRecord) {
      return {
        providerId,
        sourceId: `${providerId ?? 'unreturned-provider-keyword'}:${canonicalNormalizedQuery}`,
        query: preparation.canonicalQuery,
        normalizedQuery: canonicalNormalizedQuery,
        availability: 'missing',
        searchVolume: null,
        monthlyHistory: null,
        retrievedAt,
        geographicScope,
        providerKeywordDiagnostics: diagnostics,
        provenance: { providerId, retrievedAt, geographicScope, providerKeywordDiagnostics: diagnostics },
      }
    }
    return {
      ...providerRecord,
      sourceId: `${providerRecord.providerId}:${canonicalNormalizedQuery}`,
      query: preparation.canonicalQuery,
      normalizedQuery: canonicalNormalizedQuery,
      providerKeywordDiagnostics: diagnostics,
      provenance: { ...providerRecord.provenance, providerKeywordDiagnostics: diagnostics },
    }
  })
}
