/**
 * Cloudflare Worker — GitHub OAuth Proxy
 *
 * This is the only "server" the entire CMS stack needs.
 * It handles the GitHub OAuth code exchange (which requires a secret
 * that cannot be exposed client-side).
 *
 * Deploy to Cloudflare Workers (free tier).
 * Set these environment variables in your Worker settings:
 *   - GITHUB_CLIENT_ID      → from your GitHub OAuth App
 *   - GITHUB_CLIENT_SECRET  → from your GitHub OAuth App
 *   - ALLOWED_ORIGIN        → your site's URL (e.g. https://mysite.pages.dev)
 *
 * Routes:
 *   GET /auth/login        → redirects to GitHub OAuth
 *   GET /auth/callback     → exchanges code for token, redirects back to site
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204, env);
    }

    // Route: initiate login
    if (path === '/auth/login') {
      return handleLogin(url, env);
    }

    // Route: OAuth callback from GitHub
    if (path === '/auth/callback') {
      return handleCallback(url, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

/**
 * Redirect user to GitHub OAuth authorization page.
 * The 'state' param carries the page the user was on, so we can
 * redirect them back after login.
 */
function handleLogin(url, env) {
  const returnTo = url.searchParams.get('return_to') || '/';
  const state = btoa(JSON.stringify({ returnTo, nonce: crypto.randomUUID() }));

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${new URL(url).origin}/auth/callback`,
    scope: 'repo',      // needs repo scope to read/write files
    state,
  });

  const githubAuthUrl = `https://github.com/login/oauth/authorize?${params}`;
  return Response.redirect(githubAuthUrl, 302);
}

/**
 * Handle the OAuth callback from GitHub.
 * Exchange the code for an access token, then redirect the user
 * back to their site with the token in the URL fragment (#).
 * The fragment is never sent to a server — it stays in the browser.
 */
async function handleCallback(url, env) {
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');

  if (!code) {
    return new Response('Missing code parameter', { status: 400 });
  }

  // Parse state to get the return URL
  let returnTo = '/';
  try {
    const state = JSON.parse(atob(stateParam));
    returnTo = state.returnTo || '/';
  } catch {
    // ignore malformed state, just go home
  }

  // Exchange code for access token
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = await tokenResponse.json();

  if (tokenData.error || !tokenData.access_token) {
    return new Response(`GitHub OAuth error: ${tokenData.error_description || 'unknown'}`, {
      status: 400,
    });
  }

  // Redirect back to the site, passing the token in the URL fragment.
  // Fragment (#) is never sent to servers — it's browser-only.
  // The site's cms.js will pick it up and store it in localStorage.
  const redirectUrl = `${env.ALLOWED_ORIGIN}${returnTo}#cms-token=${tokenData.access_token}`;
  return Response.redirect(redirectUrl, 302);
}

function corsResponse(body, status = 200, env) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': env?.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
