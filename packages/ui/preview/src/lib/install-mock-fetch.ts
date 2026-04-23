import rawMockData from '../mock-data.json'
import { handleMockRequest, type MockData } from './mock-handler'

function withPrefixedAssetPaths(data: MockData): MockData {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  if (!base) return data
  return {
    sessions: data.sessions.map((session) => {
      const next: Record<string, unknown> = { ...session }
      for (const [key, value] of Object.entries(next)) {
        if (typeof value === 'string' && value.startsWith('/mock-')) {
          next[key] = base + value
        }
      }
      return next as MockData['sessions'][number]
    }),
  }
}

const mockData = withPrefixedAssetPaths(rawMockData as MockData)

export function installMockFetch() {
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const url = new URL(urlStr, location.href)
    const mocked = handleMockRequest(url.pathname, url.search, mockData)
    if (mocked) return mocked
    return originalFetch(input, init)
  }
}
