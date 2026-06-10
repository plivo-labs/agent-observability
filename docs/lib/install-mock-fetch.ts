import rawMockData from './mock-data.json'
import { handleMockRequest, type MockData } from './mock-handler'

// Spike note: in docs/ this read `import.meta.env.BASE_URL`. Under Next static
// export the site lives at the Pages subpath, so we hardcode the base here.
const BASE_URL = '/agent-observability'

function withPrefixedAssetPaths(data: MockData): MockData {
  const base = BASE_URL.replace(/\/$/, '')
  if (!base) return data
  return {
    ...data,
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
  if (typeof window === 'undefined') return
  // Guard against double-install (HMR / multiple island imports).
  if ((window as unknown as { __mockFetchInstalled?: boolean }).__mockFetchInstalled) return
  ;(window as unknown as { __mockFetchInstalled?: boolean }).__mockFetchInstalled = true

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
