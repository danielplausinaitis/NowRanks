/**
 * Conservative identity for labels echoed by a DataForSEO graph. This is
 * applies Unicode compatibility, case, and whitespace presentation variants.
 * Punctuation and words remain identity-bearing unless the narrow, observed
 * integer echo normalization below explicitly permits a formatting variant.
 */
export function normalizeDataForSeoProviderKeyword(value) {
  if (typeof value !== 'string') throw new Error('DataForSEO provider keyword must be a string')
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
  if (!normalized) throw new Error('DataForSEO provider keyword must not be empty')
  return normalized
}

/**
 * DataForSEO's Trends endpoints have been observed to echo a standalone
 * integer with only its optional dollar marker and thousands commas changed
 * (`$5,000` <-> `$5000`, `5,000` <-> `5000`). The rule never removes words,
 * reorders tokens, changes decimal content, or normalizes other punctuation.
 */
export function normalizeDataForSeoProviderEchoKeyword(value) {
  return normalizeDataForSeoProviderKeyword(value).replace(/(?<![\p{L}\p{N}])\$?(\d{1,3}(?:,\d{3})+|\d+(?!,))(?![\p{L}\p{N},]|\.\d)/gu, (_match, integer) => integer.replaceAll(',', ''))
}

/**
 * Proves returned graph-column ownership before any values are read. The
 * returned indexes are keyed by submitted request position solely as a lookup
 * result; a response position is never assumed to be a request position.
 */
export function mapDataForSeoGraphKeywordColumns({ requestedKeywords, returnedKeywords, normalizeKeyword = normalizeDataForSeoProviderKeyword, providerLabel = 'DataForSEO' }) {
  if (!Array.isArray(requestedKeywords) || !Array.isArray(returnedKeywords) || requestedKeywords.length !== returnedKeywords.length) {
    throw new Error(`${providerLabel} returned keyword count does not match request`)
  }
  const requestByNormalized = new Map()
  for (let requestIndex = 0; requestIndex < requestedKeywords.length; requestIndex += 1) {
    const raw = requestedKeywords[requestIndex]
    const normalized = normalizeKeyword(raw)
    const previous = requestByNormalized.get(normalized)
    if (previous) throw new Error(`Ambiguous ${providerLabel} provider keyword in request for normalized label ${JSON.stringify(normalized)}: ${JSON.stringify(previous.raw)} and ${JSON.stringify(raw)}`)
    requestByNormalized.set(normalized, { requestIndex, raw })
  }
  const returnedIndexByRequestIndex = Array(requestedKeywords.length)
  const seenReturned = new Set()
  for (let returnedIndex = 0; returnedIndex < returnedKeywords.length; returnedIndex += 1) {
    const raw = returnedKeywords[returnedIndex]
    const normalized = normalizeKeyword(raw)
    if (seenReturned.has(normalized)) throw new Error(`Ambiguous ${providerLabel} provider keyword in response for normalized label ${JSON.stringify(normalized)}: ${JSON.stringify(raw)}`)
    seenReturned.add(normalized)
    const request = requestByNormalized.get(normalized)
    if (!request) throw new Error(`${providerLabel} response contains unexpected keyword: ${raw}; normalized label ${JSON.stringify(normalized)}; submitted normalized labels ${JSON.stringify([...requestByNormalized.keys()])}`)
    returnedIndexByRequestIndex[request.requestIndex] = returnedIndex
  }
  if (returnedIndexByRequestIndex.some((index) => index === undefined)) throw new Error(`${providerLabel} response is missing a requested keyword`)
  return { requestedKeywords: [...requestedKeywords], returnedKeywords: [...returnedKeywords], returnedIndexByRequestIndex }
}
