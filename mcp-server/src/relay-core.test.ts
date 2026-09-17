import { describe, expect, it, vi } from "vitest";

import { DEFAULT_UPSTREAM_URL, resolveUpstreamUrl } from "./relay-core.ts";

describe("resolveUpstreamUrl", () => {
  it("uses the default when the variable is unset or blank", () => {
    expect(resolveUpstreamUrl(undefined)).toBe(DEFAULT_UPSTREAM_URL);
    expect(resolveUpstreamUrl("")).toBe(DEFAULT_UPSTREAM_URL);
    expect(resolveUpstreamUrl("   ")).toBe(DEFAULT_UPSTREAM_URL);
  });

  it("accepts an http URL on another port, trimmed", () => {
    expect(resolveUpstreamUrl(" http://127.0.0.1:41000/mcp ")).toBe("http://127.0.0.1:41000/mcp");
  });

  it("falls back and warns on an unparsable value or a non-http scheme", () => {
    const warn = vi.fn();
    expect(resolveUpstreamUrl("127.0.0.1:41000/mcp", warn)).toBe(DEFAULT_UPSTREAM_URL);
    expect(resolveUpstreamUrl("ftp://127.0.0.1/mcp", warn)).toBe(DEFAULT_UPSTREAM_URL);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toMatch(/unsupported protocol ftp:/);
  });
});
