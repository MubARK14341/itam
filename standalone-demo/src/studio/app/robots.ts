import type { MetadataRoute } from "next";
import { shouldBlockIndexing } from "@/lib/deployment-indexing";

export default function robots(): MetadataRoute.Robots {
  if (shouldBlockIndexing(process.env)) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return { rules: { userAgent: "*", allow: "/" } };
}
