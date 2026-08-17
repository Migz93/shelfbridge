import assert from "node:assert/strict";
import test from "node:test";
import { decodeXmlEntities } from "../../src/server/sync/goodreads.js";

test("decodeXmlEntities decodes named and numeric entities", () => {
  assert.equal(decodeXmlEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeXmlEntities("&#65;&#66;&#67;"), "ABC");
  assert.equal(decodeXmlEntities("&#x41;&#x42;&#x43;"), "ABC");
});

test("decodeXmlEntities does not double-unescape an already-escaped entity", () => {
  assert.equal(decodeXmlEntities("&amp;lt;"), "&lt;");
});

test("decodeXmlEntities leaves XML-invalid numeric entities unescaped instead of producing control characters", () => {
  // NUL, most C0 controls, and surrogate code points are valid Unicode but
  // invalid in an XML document — a malformed/malicious entity for one of
  // these must fall back to the original escaped text, not decode into an
  // actual control character.
  assert.equal(decodeXmlEntities("a&#0;b"), "a&#0;b");
  assert.equal(decodeXmlEntities("a&#1;b"), "a&#1;b");
  assert.equal(decodeXmlEntities("a&#xD800;b"), "a&#xD800;b");
  // Tab, LF, CR are explicitly valid XML control characters.
  assert.equal(decodeXmlEntities("a&#9;b"), "a\tb");
  assert.equal(decodeXmlEntities("a&#10;b"), "a\nb");
});

test("decodeXmlEntities rejects an out-of-range codepoint", () => {
  assert.equal(decodeXmlEntities("a&#99999999;b"), "a&#99999999;b");
});
