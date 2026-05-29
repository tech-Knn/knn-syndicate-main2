/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@knn/shared'],
  // Companies & Domains moved into the Platform hub. Redirect old bookmarks at the
  // routing layer → a real server 308, before any React renders (works for crawlers,
  // hard navigations, and non-JS clients alike). No stub page needed.
  async redirects() {
    return [
      { source: '/dashboard/companies', destination: '/dashboard/platform/companies', permanent: true },
      { source: '/dashboard/domains', destination: '/dashboard/platform/domains', permanent: true },
    ];
  },
  webpack: (config) => {
    // Internal packages use ESM ".js" import specifiers that resolve to ".ts"
    // sources (tsx/tsup handle this elsewhere). Teach webpack the same mapping so
    // value imports from @knn/shared (e.g. zod schemas) bundle correctly.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
