import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

// Two collections of markdown files. Kiln's source mode edits these files:
// each value on the page says which file and which field it came from
// (src/lib/kiln-astro.mjs stamps that), and the site rebuilds after a publish.
const events = defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/events' }) });
const site = defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/site' }) });

export const collections = { events, site };
