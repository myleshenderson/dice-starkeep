/**
 * The sign-in page Dice shows in the cloud to a person with no session.
 *
 * Dice's own screens are a Flutter build that knows nothing about Starkeep
 * sessions, so the page is one static document with one link: the platform's
 * `/auth/start`, which sends the browser to the managed login page and brings
 * it back to Dice's root with the session cookies set. No password passes
 * through Dice.
 */

const html = (href) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in to Dice</title>
  <style>
    html, body { height: 100%; margin: 0; }
    body { background: #0f1412; color: #e6ebe8; font-family: -apple-system, system-ui, sans-serif;
           display: flex; align-items: center; justify-content: center; }
    main { text-align: center; padding: 32px; }
    h1 { font-size: 28px; font-weight: 600; margin: 0 0 8px; }
    p { margin: 0 0 24px; color: #9aa6a0; }
    a { display: inline-block; background: #7fcfb8; color: #0f1412; text-decoration: none;
        font-weight: 600; padding: 12px 28px; border-radius: 999px; }
  </style>
</head>
<body>
  <main>
    <h1>Dice</h1>
    <p>Sign in with your Starkeep account to play.</p>
    <a href="${href}">Sign in</a>
  </main>
</body>
</html>
`;

/** A 200 with the page, never cached: the next load may already be signed in. */
export function signInPage(href) {
  return new Response(html(href), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
