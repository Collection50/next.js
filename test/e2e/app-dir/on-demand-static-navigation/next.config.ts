import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: { authInterrupts: true },
  cacheMaxMemorySize: process.env.ISR_CACHE_MEMORY_SIZE
    ? Number(process.env.ISR_CACHE_MEMORY_SIZE)
    : undefined,
}

export default nextConfig
