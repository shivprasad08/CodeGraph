import { describe, expect, it } from "vitest";
import {
  getTopLevelDir,
  groupNodesByDirectory,
  getDirectoryColor,
  buildDirectoryColorMap,
} from "../directoryColors.js";

describe("getTopLevelDir", () => {
  it("returns the top-level directory", () => {
    expect(getTopLevelDir("backend/auth/main.py")).toBe("backend");
  });

  it("handles root-level files", () => {
    expect(getTopLevelDir("main.py")).toBe("__root__");
  });

  it("handles empty paths", () => {
    expect(getTopLevelDir("")).toBe("__root__");
    expect(getTopLevelDir(null)).toBe("__root__");
  });
});

describe("groupNodesByDirectory", () => {
  it("groups nodes by their top-level directory", () => {
    const nodes = [
      { id: "1", file: "backend/main.py" },
      { id: "2", file: "backend/cache.py" },
      { id: "3", file: "frontend/App.jsx" },
      { id: "4", file: "frontend/api.js" },
    ];

    const groups = groupNodesByDirectory(nodes);

    expect(Object.keys(groups).sort()).toEqual(["backend", "frontend"]);
    expect(groups.backend).toHaveLength(2);
    expect(groups.frontend).toHaveLength(2);
  });

  it("filters directories containing only one node", () => {
    const nodes = [
      { id: "1", file: "backend/main.py" },
      { id: "2", file: "backend/cache.py" },
      { id: "3", file: "frontend/App.jsx" },
    ];

    const groups = groupNodesByDirectory(nodes);

    expect(groups.backend).toHaveLength(2);
    expect(groups.frontend).toBeUndefined();
  });
});

describe("directory colors", () => {
  it("returns a deterministic color for a directory", () => {
    const directories = ["backend", "frontend"];

    const first = getDirectoryColor("backend", directories);
    const second = getDirectoryColor("backend", directories);

    expect(first).toEqual(second);
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("fill");
    expect(first).toHaveProperty("stroke");
    expect(first).toHaveProperty("label");
  });

  it("builds a color map for grouped directories", () => {
    const nodes = [
      { id: "1", file: "backend/main.py" },
      { id: "2", file: "backend/cache.py" },
      { id: "3", file: "frontend/App.jsx" },
      { id: "4", file: "frontend/api.js" },
    ];

    const colorMap = buildDirectoryColorMap(nodes);

    expect(Object.keys(colorMap).sort()).toEqual([
      "backend",
      "frontend",
    ]);
  });
});
