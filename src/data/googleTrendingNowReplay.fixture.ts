/**
 * Offline replay of the shape returned by Google Trends' Trending Now feed.
 * It is deliberately checked in so development and tests never call Google.
 * `traffic` and article fields are optional in the live response, so absent
 * values are preserved rather than invented.
 */
export interface GoogleTrendingNowReplayResponse {
  default: {
    trendingSearchesDays: Array<{
      date: string
      trendingSearches: Array<{
        title: { query: string }
        formattedTraffic?: string
        traffic?: number
        categories?: string[]
        articles?: Array<{ title: string; url: string; source?: string; time?: string }>
      }>
    }>
  }
}

const queries: Array<[string, string]> = [
  ['iPhone 17 Pro release date', 'technology'], ['iPhone 17 Pro price', 'technology'], ['best gaming laptop 2026', 'technology'], ['ChatGPT new features', 'technology'], ['Samsung Galaxy S26 Ultra', 'technology'],
  ['Nintendo Switch 2 games', 'games'], ['GTA 6 release date', 'games'], ['EA FC 27 ratings', 'games'], ['Minecraft update', 'games'], ['Fortnite live event', 'games'],
  ['FIFA World Cup 2026 final', 'sports'], ['Premier League fixtures', 'sports'], ['Formula 1 standings', 'sports'], ['US Open tennis results', 'sports'], ['NBA playoff schedule', 'sports'],
  ['Dubai property prices', 'finance'], ['Bitcoin price today', 'finance'], ['gold price forecast', 'finance'], ['Nvidia earnings date', 'finance'], ['best savings account', 'finance'],
  ['Dubai weather this week', 'travel'], ['Japan cherry blossom forecast', 'travel'], ['cheap flights to Tokyo', 'travel'], ['best hotels in Paris', 'travel'], ['visa free countries', 'travel'],
  ['Wednesday season 3', 'arts & entertainment'], ['new Netflix movies', 'arts & entertainment'], ['Taylor Swift tour dates', 'arts & entertainment'], ['Marvel Avengers cast', 'arts & entertainment'], ['Oscar winners 2026', 'arts & entertainment'],
  ['Tesla Model Y price', 'autos & vehicles'], ['Toyota Land Cruiser 2026', 'autos & vehicles'], ['best electric SUV', 'autos & vehicles'], ['Formula 1 car launch', 'autos & vehicles'], ['driving licence renewal', 'autos & vehicles'],
  ['stock market today', 'business'], ['remote jobs hiring', 'business'], ['AI startup funding', 'business'], ['small business grants', 'business'], ['best project management software', 'business'],
  ['protein meal plan', 'health'], ['walking workout plan', 'health'], ['mental health awareness', 'health'], ['best sleep tracker', 'health'], ['healthy dinner recipes', 'health'],
  ['Apple WWDC announcements', 'technology'], ['Google Pixel 11 leaks', 'technology'], ['best AI tools for work', 'technology'], ['PlayStation 6 news', 'games'], ['Steam summer sale', 'games'],
  ['Champions League draw', 'sports'], ['cricket world cup schedule', 'sports'], ['UFC fight night results', 'sports'], ['Ethereum price prediction', 'finance'], ['mortgage rates today', 'finance'],
  ['summer holiday deals', 'travel'], ['Dubai hotels near beach', 'travel'], ['new movies this weekend', 'arts & entertainment'], ['concert tickets near me', 'arts & entertainment'], ['BMW iX3 release date', 'autos & vehicles'],
  ['car insurance comparison', 'autos & vehicles'], ['IPO calendar 2026', 'business'], ['best online MBA programs', 'business'], ['weight loss meal plan', 'health'], ['vitamin D deficiency symptoms', 'health'],
  ['MacBook Pro M6', 'technology'], ['Microsoft Surface Laptop', 'technology'], ['Call of Duty new season', 'games'], ['Roblox promo codes', 'games'], ['tennis grand slam schedule', 'sports'],
  ['NFL draft prospects', 'sports'], ['oil price today', 'finance'], ['currency exchange rates', 'finance'], ['Europe train travel pass', 'travel'], ['best places to visit in 2026', 'travel'],
  ['Disney Plus new releases', 'arts & entertainment'], ['K-pop concert dates', 'arts & entertainment'], ['Porsche electric Macan', 'autos & vehicles'], ['best family SUV', 'autos & vehicles'], ['business news today', 'business'],
  ['freelance jobs online', 'business'], ['pilates for beginners', 'health'], ['gluten free recipes', 'health'], ['Android 17 features', 'technology'], ['cybersecurity news', 'technology'],
  ['League of Legends Worlds', 'games'], ['best co-op games', 'games'], ['World Cup tickets', 'sports'], ['Olympics 2028 schedule', 'sports'], ['interest rate decision', 'finance'],
  ['best credit cards', 'finance'], ['UAE public holidays', 'travel'], ['travel insurance comparison', 'travel'], ['Grammy nominations 2026', 'arts & entertainment'], ['celebrity news today', 'arts & entertainment'],
  ['Ford Mustang hybrid', 'autos & vehicles'], ['EV charging stations near me', 'autos & vehicles'], ['job market report', 'business'], ['marketing trends 2026', 'business'], ['home workout routine', 'health']
]

export const googleTrendingNowReplay: GoogleTrendingNowReplayResponse = {
  default: {
    trendingSearchesDays: [{
      date: '2026-08-25',
      trendingSearches: queries.map(([query, category], index) => ({
        title: { query },
        categories: [category],
        ...(index % 4 === 0 ? { formattedTraffic: `${(index % 9 + 1) * 10}K+`, traffic: (index % 9 + 1) * 10_000 } : {}),
        ...(index === 0 ? { articles: [{ title: 'Product announcement drives search interest', url: 'https://news.google.com/', source: 'Replay fixture' }] } : {}),
      })),
    }],
  },
}

const REPLAY_HISTORY_DAYS = 365
const RECENT_REPLAY_DAYS = 30

/**
 * Deterministic replay-only historical interest. The final 30 values intentionally retain the
 * prior fixture generator so 24H, 7D, and 30D behavior remains unchanged.
 */
export const googleInterestReplayFixture: Record<string, number[]> = Object.fromEntries(
  queries.map(([query], index) => [query.toLocaleLowerCase('en-US'), Array.from({ length: REPLAY_HISTORY_DAYS }, (_, day) => {
    const recentDay = day - (REPLAY_HISTORY_DAYS - RECENT_REPLAY_DAYS)
    if (recentDay >= 0) {
      const baseline = 22 + (index * 13) % 48
      const lift = recentDay < 16 ? 0 : (recentDay - 15) * ((index % 5) + 1)
      const variation = ((index * 7 + recentDay * 3) % 9) - 4
      return Math.max(0, Math.min(100, baseline + lift + variation))
    }

    const baseline = 28 + (index * 11) % 42
    const seasonalVariation = ((index * 5 + day * 7) % 17) - 8
    const longTermDrift = Math.floor(day / 30) * ((index % 3) - 1)
    return Math.max(0, Math.min(100, baseline + seasonalVariation + longTermDrift))
  })]),
)
