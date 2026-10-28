const store = new Map()

module.exports = class CacheHandler {
  async get(key) {
    return store.get(key) ?? null
  }

  async set(key, value, ctx) {
    store.set(key, {
      value,
      lastModified: Math.floor(performance.timeOrigin + performance.now()),
      cacheControl: ctx.cacheControl,
    })
    console.log('cache-handler:set', key)
  }

  async revalidateTag() {}

  resetRequestCache() {}
}
