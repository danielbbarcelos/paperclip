// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import DOMPurify from "dompurify";

// Locks in the stored-XSS defense applied to mermaid-rendered SVG before it is
// injected via dangerouslySetInnerHTML in MarkdownBody's MermaidDiagramBlock.
// The component renders with flowchart.htmlLabels:false (native <text> labels,
// no <foreignObject>) and then calls DOMPurify.sanitize(svg) with default
// config; this test mirrors that call to guarantee scripts/handlers are
// stripped while the legitimate native-SVG diagram structure survives.
const sanitize = (svg: string) => DOMPurify.sanitize(svg);

describe("mermaid SVG sanitization", () => {
  // Shape of a native-SVG mermaid diagram (htmlLabels:false) carrying injected
  // script / event-handler / javascript: payloads.
  const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
    <style>.node{fill:#fff}</style>
    <g class="node" onclick="alert(1)"><rect width="50" height="20"/><text x="5" y="15">Node Label</text></g>
    <path d="M0 0 L10 10"/>
    <script>alert("xss")</script>
    <a xlink:href="javascript:alert(2)">link</a>
  </svg>`;

  it("strips <script> tags", () => {
    expect(sanitize(maliciousSvg)).not.toMatch(/<script/i);
  });

  it("strips inline event handlers", () => {
    expect(sanitize(maliciousSvg)).not.toMatch(/onclick/i);
  });

  it("strips javascript: URLs", () => {
    expect(sanitize(maliciousSvg)).not.toMatch(/javascript:/i);
  });

  it("preserves the native-SVG diagram structure and text labels", () => {
    const out = sanitize(maliciousSvg);
    expect(out).toMatch(/<svg/i);
    expect(out).toMatch(/<rect/i);
    expect(out).toMatch(/<path/i);
    expect(out).toContain("Node Label");
  });

  it("neutralizes script smuggled inside a foreignObject", () => {
    const out = sanitize(
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><script>alert(1)</script></foreignObject></svg>`,
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/alert/);
  });
});
