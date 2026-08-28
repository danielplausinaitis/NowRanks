import type { Category, LeaderboardSnapshot, SearchDataProvider, SearchTopic, SearchTopicData, TimeWindow, TopicObservation } from '../domain/types'
import { rankEntries } from '../domain/leaderboard'

const topicSeeds: Array<[string, Category]> = [
  ['iPhone 17 Pro release date','Technology'],['iPhone 17 Pro price','Technology'],['best gaming laptop 2026','Technology'],['ChatGPT new features','Technology'],['Samsung Galaxy S26 Ultra','Technology'],['Nintendo Switch 2 games','Gaming'],['GTA 6 release date','Gaming'],['EA FC 27 ratings','Gaming'],['Minecraft update','Gaming'],['Fortnite live event','Gaming'],['FIFA World Cup 2026 final','Sports'],['Premier League fixtures','Sports'],['Formula 1 standings','Sports'],['US Open tennis results','Sports'],['NBA playoff schedule','Sports'],['Dubai property prices','Finance'],['Bitcoin price today','Finance'],['gold price forecast','Finance'],['Nvidia earnings date','Finance'],['best savings account','Finance'],['Dubai weather this week','Travel'],['Japan cherry blossom forecast','Travel'],['cheap flights to Tokyo','Travel'],['best hotels in Paris','Travel'],['visa free countries','Travel'],['Wednesday season 3','Entertainment'],['new Netflix movies','Entertainment'],['Taylor Swift tour dates','Entertainment'],['Marvel Avengers cast','Entertainment'],['Oscar winners 2026','Entertainment'],['Tesla Model Y price','Cars'],['Toyota Land Cruiser 2026','Cars'],['best electric SUV','Cars'],['Formula 1 car launch','Cars'],['driving licence renewal','Cars'],['stock market today','Business'],['remote jobs hiring','Business'],['AI startup funding','Business'],['small business grants','Business'],['best project management software','Business'],['protein meal plan','Health'],['walking workout plan','Health'],['mental health awareness','Health'],['best sleep tracker','Health'],['healthy dinner recipes','Health'],['Apple WWDC announcements','Technology'],['Google Pixel 11 leaks','Technology'],['best AI tools for work','Technology'],['PlayStation 6 news','Gaming'],['Steam summer sale','Gaming'],['Champions League draw','Sports'],['cricket world cup schedule','Sports'],['UFC fight night results','Sports'],['Ethereum price prediction','Finance'],['mortgage rates today','Finance'],['summer holiday deals','Travel'],['Dubai hotels near beach','Travel'],['new movies this weekend','Entertainment'],['concert tickets near me','Entertainment'],['BMW iX3 release date','Cars'],['car insurance comparison','Cars'],['IPO calendar 2026','Business'],['best online MBA programs','Business'],['weight loss meal plan','Health'],['vitamin D deficiency symptoms','Health'],['MacBook Pro M6','Technology'],['Microsoft Surface Laptop','Technology'],['Call of Duty new season','Gaming'],['Roblox promo codes','Gaming'],['tennis grand slam schedule','Sports'],['NFL draft prospects','Sports'],['oil price today','Finance'],['currency exchange rates','Finance'],['Europe train travel pass','Travel'],['best places to visit in 2026','Travel'],['Disney Plus new releases','Entertainment'],['K-pop concert dates','Entertainment'],['Porsche electric Macan','Cars'],['best family SUV','Cars'],['business news today','Business'],['freelance jobs online','Business'],['pilates for beginners','Health'],['gluten free recipes','Health'],['Android 17 features','Technology'],['cybersecurity news','Technology'],['League of Legends Worlds','Gaming'],['best co-op games','Gaming'],['World Cup tickets','Sports'],['Olympics 2028 schedule','Sports'],['interest rate decision','Finance'],['best credit cards','Finance'],['UAE public holidays','Travel'],['travel insurance comparison','Travel'],['Grammy nominations 2026','Entertainment'],['celebrity news today','Entertainment'],['Ford Mustang hybrid','Cars'],['EV charging stations near me','Cars'],['job market report','Business'],['marketing trends 2026','Business'],['home workout routine','Health'],['seasonal allergy relief','Health'],['iPad Pro M5','Technology'],['best password manager','Technology'],['Valorant patch notes','Gaming'],['FIFA game release date','Gaming'],['Wimbledon tickets','Sports'],['football transfer news','Sports'],['silver price today','Finance'],['tax deadline 2026','Finance'],['best beaches in Europe','Travel'],['airport transfer Dubai','Travel'],['TV shows to watch','Entertainment'],['movie release dates 2026','Entertainment'],['Honda CR-V hybrid','Cars'],['used car prices','Cars'],['leadership courses online','Business'],['startup business ideas','Business'],['high protein breakfast','Health'],['running shoes for beginners','Health']
]

const dates = Array.from({ length: 31 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`)
function series(index: number, candidateId: string): TopicObservation[] {
  const base = 190 + ((index * 73) % 1400)
  const growth = ((index * 19) % 38) - 10
  const acceleration = index % 5 === 0 ? 2.8 : index % 3 === 0 ? 1.1 : 0.35
  const volatility = index % 7 === 0 ? 0.58 : 0.14
  return dates.map((date, day) => {
    const progress = Math.max(0, day - 16)
    const pulse = Math.sin((index + 2) * (day + 1)) * base * volatility
    return { candidateId, date, observedAt: `${date}T00:00:00.000Z`, availability: 'available', interest: Math.max(15, Math.round(base + day * growth + progress * progress * acceleration + pulse)) }
  })
}

const data: SearchTopicData[] = topicSeeds.map(([topic, category], index) => {
  const id = `topic-${index + 1}`
  return {
    id,
    topic,
    normalizedQuery: topic.toLocaleLowerCase('en-US'),
    category,
    provenance: {
      providerId: 'mock-search-data',
      dataMode: 'test',
      sourceObservedAt: '2026-08-31T00:00:00.000Z',
      ingestedAt: '2026-08-31T00:00:00.000Z',
      geographicScope: { kind: 'global' },
      collectionMethod: 'deterministic-test-data',
      crossQueryComparability: { status: 'comparable', basis: 'controlled test data' },
    },
    observations: series(index, id),
  }
})
const yesterdayData = data.map((item, index) => ({
  ...item,
  observations: item.observations.map((observation, day) => observation.availability === 'missing'
    ? observation
    : { ...observation, interest: Math.max(1, observation.interest - (day > 23 ? ((index % 9) - 4) * 120 : 0)) }),
}))

export class MockSearchDataProvider implements SearchDataProvider {
  async getCandidates(): Promise<SearchTopic[]> { return data.map(({ observations, ...candidate }) => candidate) }
  async getObservations(topicId: string, window: TimeWindow): Promise<TopicObservation[]> { const item = data.find((candidate) => candidate.id === topicId); if (!item) return []; const count = window === '24H' ? 1 : window === '7D' ? 7 : window === '30D' ? 30 : 365; return item.observations.slice(-count) }
  async getAllTopicData() { return data }
  async getSnapshots(): Promise<LeaderboardSnapshot[]> {
    return [
      { date: '2026-08-24', snapshotAt: '2026-08-24T00:00:00.000Z', scoringMode: 'overallScore', selectedWindow: '30D', entries: rankEntries(yesterdayData) },
      { date: '2026-08-25', snapshotAt: '2026-08-25T00:00:00.000Z', scoringMode: 'overallScore', selectedWindow: '30D', entries: rankEntries(data) },
    ]
  }
}
