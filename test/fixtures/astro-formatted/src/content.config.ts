import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({ title: z.string(), summary: z.string().optional(), draft: z.boolean().optional() }),
});
export const collections = { posts };
