import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.join(
  __dirname,
  "..",
  "..",
  "src",
  "app",
  "(dashboard)",
  "dashboard",
  "translator",
  "page.js",
);
const page = fs.readFileSync(pagePath, "utf8");

// Issue #28: Monaco 0.55.1 ships a vendored DOMPurify that is inside the
// advisory range, and no Monaco release bundles a patched copy yet. The
// mitigation is that translator payloads only ever reach the editor as model
// text in plaintext/JSON modes — never as sanitized HTML.
describe("translator editor keeps untrusted payloads out of HTML sinks", () => {
  it("only mounts Monaco in plaintext or JSON mode", () => {
    expect(page).toContain('step.lang === "text" ? "plaintext" : "json"');
    expect(page).not.toMatch(/defaultLanguage=\{?["'](?:markdown|html)["']/);
  });

  it("passes payloads as editor value, not markup", () => {
    expect(page).toContain("value={content}");
    expect(page).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=/);
  });

  it("does not enable Monaco markdown/HTML features via loader config", () => {
    expect(page).not.toMatch(/loader\.config|monaco\.languages/);
  });
});
