import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string().max(80),
    date: z.coerce.date(),
    summary: z.string().optional(),
    description: z.string().max(160).optional(),
    image: z.string().optional(),
    draft: z.boolean().optional(),
    order: z.number().optional(),
  }),
});
export const collections = { posts };
