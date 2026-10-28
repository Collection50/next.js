/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  cacheComponents: true,
  cacheHandler:
    process.env.FALLBACK_SHELL_CUSTOM_CACHE === '1'
      ? require.resolve('./cache-handler.js')
      : undefined,
  cacheMaxMemorySize:
    process.env.FALLBACK_SHELL_CUSTOM_CACHE === '1' ? 0 : undefined,
}

module.exports = nextConfig
