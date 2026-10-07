import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: ({ image }) => z.object({
    title: z.string().max(80),
    summary: z.string().optional(),
    draft: z.boolean().optional(),
    cover: image().optional(),
    coverAlt: z.string().optional(),
    banner: z.string().optional(),
    bannerAlt: z.string().optional(),
    cta: z.object({ label: z.string(), href: z.string().url() }).optional(),
    website: z.string().url().optional(),
    kind: z.enum(['news', 'event']).default('news'),
    tags: z.array(z.string()).optional(),
  }),
});
export const collections = { posts };
