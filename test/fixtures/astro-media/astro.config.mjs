import { defineConfig } from 'astro/config';
import kiln from './src/lib/kiln-astro.mjs';
export default defineConfig({ integrations: [kiln()] });
