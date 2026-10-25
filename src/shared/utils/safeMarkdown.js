import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Render remote Markdown for the changelog modal.
 * The source is a remote document, so the HTML is sanitized before it is
 * handed to dangerouslySetInnerHTML.
 * @param {string} markdown
 * @returns {string} sanitized HTML
 */
export function renderSafeMarkdown(markdown) {
  const html = marked.parse(markdown ?? "", { async: false });
  return DOMPurify.sanitize(html);
}
