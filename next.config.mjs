/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // The app is the static page in public/index.html.
    return [{ source: "/app", destination: "/index.html" }];
  }
};

export default nextConfig;
