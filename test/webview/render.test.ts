import assert from "node:assert/strict";
import test from "node:test";

import { documentNeedsRender } from "../../src/webview/render";

test("an identical document is not pushed to the view", () => {
  // `webview.html = same` reloads the iframe and throws away the scroll
  // position and the caret. The rule is one line, so it is stated as one line;
  // it moved here from `libraryHtml` when every webview host started sharing
  // it (`WebviewDocument.paint()`).
  assert.equal(documentNeedsRender(undefined, "<html></html>"), true);
  assert.equal(documentNeedsRender("<html></html>", "<html></html>"), false);
  assert.equal(documentNeedsRender("<html></html>", "<html> </html>"), true);
});
