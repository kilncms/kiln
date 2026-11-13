import { defineConfig } from 'astro/config';

// A plain static build. Everything Kiln needs at run time (the editor files,
// its config, the /kiln sign-in page) is in public/ and is copied to dist/ as is.
export default defineConfig({});
