import { describe, expect, it } from "vitest";
import {
  computeConvexHull,
  expandHull,
} from "../hullUtils.js";

describe("computeConvexHull", () => {
  it("returns an empty array for fewer than two points", () => {
    expect(computeConvexHull([])).toEqual([]);
    expect(computeConvexHull([{ x: 0, y: 0 }])).toEqual([]);
  });

  it("returns both points when there are exactly two", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
    ];

    expect(computeConvexHull(points)).toEqual(points);
  });

  it("computes the outer hull of a set of points", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 1, y: 1 },
    ];

    const hull = computeConvexHull(points);

    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ x: 1, y: 1 });
  });
});

describe("expandHull", () => {
  it("returns the original hull for fewer than three points", () => {
    const hull = [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
    ];

    expect(expandHull(hull)).toEqual(hull);
  });

  it("expands a three-point hull", () => {
    const hull = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ];

    const expanded = expandHull(hull, 10);

    expect(expanded).toHaveLength(3);
    expect(expanded).not.toEqual(hull);
  });
});
