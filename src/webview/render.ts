/**
 * The pure half of the webview render kit.
 *
 * This module deliberately imports nothing — not even `vscode` — so the unit
 * tests can state its semantics directly under `node --test`.
 */

/**
 * Whether a freshly rendered document should replace the one on screen.
 *
 * Assigning `webview.html` reloads the view, so an identical document must not
 * be pushed. This is the guard that keeps a "render again" request from
 * turning into a reload loop; it is the one rule of the kit that a unit test
 * can state in one line.
 */
export function documentNeedsRender(rendered: string | undefined, next: string): boolean {
  return rendered !== next;
}
