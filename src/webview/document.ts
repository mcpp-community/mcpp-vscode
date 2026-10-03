/**
 * One webview document: the CSP nonce and the render-only-on-change rule every
 * webview host in this extension shares (library view, cache view, settings
 * panel, package detail page).
 *
 * Assigning `webview.html` reloads the document — it throws away the scroll
 * position, any half-typed input and the focus. Two properties make a host
 * safe against pointless and looping reloads:
 *
 * 1. **The nonce is per view, not per render.** The CSP nonce is embedded in
 *    the document, so a fresh nonce per render makes every render a *different*
 *    document and no comparison can ever say "unchanged" — that is exactly how
 *    the library view once reloaded itself forever (flicker, unclickable rows,
 *    a pegged CPU).
 * 2. **`paint()` assigns only when the document changed**, via
 *    `documentNeedsRender` in `./render`.
 *
 * A hidden `WebviewView` loses its context (`retainContextWhenHidden` is not
 * supported), so the next resolve is a brand-new, empty webview: the host
 * calls `invalidate()` on resolve and on dispose, and the comparison starts
 * from nothing again.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import { documentNeedsRender } from "./render";

/** What an html renderer embeds: the CSP source, the script nonce, the stylesheet. */
export interface WebviewAssets {
  cspSource: string;
  nonce: string;
  styleUri: string;
}

/** One webview's document state: its nonce and the html currently on screen. */
export class WebviewDocument {
  private readonly nonce = randomBytes(16).toString("base64");
  private current: string | undefined;

  /** @param stylesheet the stylesheet file, joined onto the media root. */
  constructor(private readonly stylesheet: string) {}

  /** The webview was (re)resolved or disposed: it is a fresh, empty document. */
  invalidate(): void {
    this.current = undefined;
  }

  assets(mediaRoot: vscode.Uri, webview: vscode.Webview): WebviewAssets {
    return {
      cspSource: webview.cspSource,
      nonce: this.nonce,
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, this.stylesheet)).toString(),
    };
  }

  /** Put the document on screen, but only when it says something new. */
  paint(webview: vscode.Webview, html: string): void {
    if (!documentNeedsRender(this.current, html)) {
      return;
    }
    this.current = html;
    webview.html = html;
  }
}
