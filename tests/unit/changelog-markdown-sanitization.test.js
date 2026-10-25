// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderSafeMarkdown } from "@/shared/utils/safeMarkdown.js";
import { GITHUB_CONFIG } from "@/shared/constants/config.js";

// Remote changelog content is rendered into the dashboard. Every payload here
// must survive `marked` but be neutralised before it reaches innerHTML.
const XSS_PAYLOADS = [
  '<script>alert("xss")</script>',
  '<img src="x" onerror="alert(1)">',
  '<svg onload="alert(1)"></svg>',
  '<iframe src="https://evil.example"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="data:text/html,<script>alert(1)</script>">data</a>',
  "[md link](javascript:alert(1))",
  '<div onclick="alert(1)">click</div>',
];

describe("changelog markdown rendering is sanitized", () => {
  it.each(XSS_PAYLOADS)("neutralises %s", (payload) => {
    const html = renderSafeMarkdown(payload);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror\s*=/i);
    expect(html).not.toMatch(/onload\s*=/i);
    expect(html).not.toMatch(/onclick\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<iframe/i);
  });

  it("keeps ordinary changelog markdown", () => {
    const html = renderSafeMarkdown(
      "## v0.7.0\n\n**bold** and [docs](https://example.com)\n\n- one\n- two\n\n`code`"
    );
    expect(html).toContain("<h2");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<code>code</code>");
  });

  it("fetches the changelog from the default branch", () => {
    expect(GITHUB_CONFIG.changelogUrl).toContain("/refs/heads/main/");
    expect(GITHUB_CONFIG.changelogUrl).not.toContain("/refs/heads/master/");
  });
});
