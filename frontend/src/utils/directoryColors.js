export function getTopLevelDir(filePath) {
  if (!filePath) return "__root__"
  const parts = filePath.split("/")
  if (parts.length === 1) return "__root__"   // e.g. "main.py"
  return parts[0]   // e.g. "backend" from "backend/auth.py"
}

export function groupNodesByDirectory(nodes) {
  const groups = {}
  for (const node of nodes) {
    const dir = getTopLevelDir(node.file || node.id)
    if (!groups[dir]) groups[dir] = []
    groups[dir].push(node)
  }
  // Filter out directories with only 1 node — no hull needed
  // (single isolated node doesn't need a background region)
  return Object.fromEntries(
    Object.entries(groups).filter(([_, nodes]) => nodes.length >= 2)
  )
}

const PALETTE = [
  {
    fill:   "rgba(124, 58, 237, 0.06)",   // purple  — accent
    stroke: "rgba(124, 58, 237, 0.35)",
    label:  "#9d5ff0",
    name:   "purple"
  },
  {
    fill:   "rgba(59, 130, 246, 0.06)",   // blue
    stroke: "rgba(59, 130, 246, 0.35)",
    label:  "#60a5fa",
    name:   "blue"
  },
  {
    fill:   "rgba(34, 197, 94, 0.06)",    // green
    stroke: "rgba(34, 197, 94, 0.30)",
    label:  "#4ade80",
    name:   "green"
  },
  {
    fill:   "rgba(245, 158, 11, 0.06)",   // amber
    stroke: "rgba(245, 158, 11, 0.30)",
    label:  "#fbbf24",
    name:   "amber"
  },
  {
    fill:   "rgba(236, 72, 153, 0.06)",   // pink
    stroke: "rgba(236, 72, 153, 0.30)",
    label:  "#f472b6",
    name:   "pink"
  },
  {
    fill:   "rgba(20, 184, 166, 0.06)",   // teal
    stroke: "rgba(20, 184, 166, 0.30)",
    label:  "#2dd4bf",
    name:   "teal"
  },
  {
    fill:   "rgba(239, 68, 68, 0.06)",    // red
    stroke: "rgba(239, 68, 68, 0.30)",
    label:  "#f87171",
    name:   "red"
  },
  {
    fill:   "rgba(99, 102, 241, 0.06)",   // indigo
    stroke: "rgba(99, 102, 241, 0.30)",
    label:  "#818cf8",
    name:   "indigo"
  },
]

export function getDirectoryColor(dirName, allDirNames) {
  const sorted = [...allDirNames].sort()
  const index = sorted.indexOf(dirName)
  return PALETTE[index % PALETTE.length]
}

export function buildDirectoryColorMap(nodes) {
  const groups = groupNodesByDirectory(nodes)
  const dirNames = Object.keys(groups)
  const colorMap = {}
  for (const dir of dirNames) {
    colorMap[dir] = getDirectoryColor(dir, dirNames)
  }
  return colorMap
}
