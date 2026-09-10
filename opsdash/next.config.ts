import type { NextConfig } from 'next';

const config: NextConfig = {
  // The money path is exact-decimal end to end; a stray `any` in a route
  // handler is how a float sneaks back in. Fail the build instead.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
};

export default config;
