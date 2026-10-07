import { describe, expect, it } from "vitest";
import {
  computeBlastRadius,
  detectBrokenPipelines,
} from "../blastRadius.js";

describe("computeBlastRadius", () => {
  it("finds reverse dependencies", () => {
    const graph = {
      nodes: [
        { id: "A" },
        { id: "B" },
        { id: "C" },
      ],
      edges: [
        { source: "B", target: "A", type: "imports" },
        { source: "C", target: "B", type: "calls" },
      ],
    };

    const result = computeBlastRadius(graph, ["A"]);

    expect(result.affected.has("A")).toBe(true);
    expect(result.affected.has("B")).toBe(true);
    expect(result.affected.has("C")).toBe(true);

    expect(result.affected.get("B").depth).toBe(1);
    expect(result.affected.get("B").severity).toBe("critical");

    expect(result.affected.get("C").depth).toBe(2);
    expect(result.affected.get("C").severity).toBe("high");
  });

  it("respects maxDepth", () => {
    const graph = {
      nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
      edges: [
        { source: "B", target: "A", type: "imports" },
        { source: "C", target: "B", type: "imports" },
      ],
    };

    const result = computeBlastRadius(graph, ["A"], 1);

    expect(result.affected.has("A")).toBe(true);
    expect(result.affected.has("B")).toBe(true);
    expect(result.affected.has("C")).toBe(false);
  });

  it("calculates affected-node statistics", () => {
    const graph = {
      nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
      edges: [
        { source: "B", target: "A", type: "imports" },
        { source: "C", target: "A", type: "calls" },
      ],
    };

    const result = computeBlastRadius(graph, ["A"]);

    expect(result.stats.total).toBe(2);
    expect(result.stats.byDepth[0]).toBe(1);
    expect(result.stats.byDepth[1]).toBe(2);
    expect(result.stats.bySeverity.critical).toBe(2);
  });

  it("ignores unsupported edge types", () => {
    const graph = {
      nodes: [{ id: "A" }, { id: "B" }],
      edges: [
        { source: "B", target: "A", type: "unrelated" },
      ],
    };

    const result = computeBlastRadius(graph, ["A"]);

    expect(result.affected.size).toBe(1);
    expect(result.stats.total).toBe(0);
  });
});

describe("detectBrokenPipelines", () => {
  it("detects an entry point reaching an affected node", () => {
    const entryPoint = {
      id: "main",
      is_entry_point: true,
    };

    const graph = {
      nodes: [
        entryPoint,
        { id: "service" },
        { id: "database", issue_severity: "high" },
      ],
      edges: [
        { source: "main", target: "service", type: "calls" },
        { source: "service", target: "database", type: "calls" },
      ],
    };

    const broken = detectBrokenPipelines(graph, new Set(["database"]));

    expect(broken).toHaveLength(1);
    expect(broken[0].entryPoint.id).toBe("main");
    expect(broken[0].affectedInPath).toContain("database");
    expect(broken[0].risk).toBe("high");
  });
});
