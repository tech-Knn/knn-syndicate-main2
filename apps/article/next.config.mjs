/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@knn/shared'],
  webpack: (config) => {
    // Internal packages use ESM ".js" import specifiers that resolve to ".ts"
    // sources. Teach webpack the same mapping so value imports from @knn/shared
    // (articleTeaser / articleParagraphs) bundle correctly.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
