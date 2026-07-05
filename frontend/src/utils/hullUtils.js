export function computeConvexHull(points) {
  // points: array of { x, y }
  // returns: array of { x, y } in counter-clockwise order
  // returns [] if < 3 points (caller handles degenerate cases)
  
  if (points.length < 2) return []
  if (points.length === 2) return points
  
  // Sort by x, then by y
  const sorted = [...points].sort((a, b) =>
    a.x !== b.x ? a.x - b.x : a.y - b.y
  )
  
  function cross(O, A, B) {
    return (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x)
  }
  
  // Build lower hull
  const lower = []
  for (const p of sorted) {
    while (lower.length >= 2 &&
           cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }
  
  // Build upper hull
  const upper = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 &&
           cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }
  
  // Remove last point of each half (duplicates of first point of other half)
  lower.pop()
  upper.pop()
  
  return [...lower, ...upper]
}

export function expandHull(hull, padding = 28) {
  if (hull.length < 3) return hull
  
  // Compute centroid
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length
  
  // Move each vertex away from centroid by padding
  return hull.map(p => {
    const dx = p.x - cx
    const dy = p.y - cy
    const dist = Math.sqrt(dx*dx + dy*dy) || 1
    return {
      x: p.x + (dx / dist) * padding,
      y: p.y + (dy / dist) * padding
    }
  })
}

export function drawRoundedHull(ctx, hull, radius = 12) {
  if (hull.length < 2) return
  
  ctx.beginPath()
  
  for (let i = 0; i < hull.length; i++) {
    const curr = hull[i]
    const next = hull[(i + 1) % hull.length]
    const prev = hull[(i - 1 + hull.length) % hull.length]
    
    // Midpoints
    const mid1 = { x: (prev.x + curr.x) / 2, y: (prev.y + curr.y) / 2 }
    const mid2 = { x: (curr.x + next.x) / 2, y: (curr.y + next.y) / 2 }
    
    if (i === 0) {
      ctx.moveTo(mid1.x, mid1.y)
    }
    
    // Quadratic curve through the corner
    ctx.quadraticCurveTo(curr.x, curr.y, mid2.x, mid2.y)
  }
  
  ctx.closePath()
}
