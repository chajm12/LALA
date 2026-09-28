import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  distDir: process.env.LALA_ISOLATED_BUILD === "1" ? ".next-quality" : ".next",
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
