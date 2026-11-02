export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

function overlaps(state: WindowState, area: WorkArea): boolean {
  const x = state.x ?? 0
  const y = state.y ?? 0
  return (
    x < area.x + area.width &&
    x + state.width > area.x &&
    y < area.y + area.height &&
    y + state.height > area.y
  )
}

/**
 * Keep a saved window reachable after a monitor is unplugged or the desktop
 * layout changes. The first work area is treated as the primary display.
 */
export function clampWindowState(state: WindowState, workAreas: WorkArea[]): WindowState {
  if (state.x === undefined || state.y === undefined || workAreas.length === 0) {
    return state
  }
  if (workAreas.some((area) => overlaps(state, area))) return state
  const primary = workAreas[0]
  return {
    ...state,
    x: primary.x + Math.round((primary.width - state.width) / 2),
    y: primary.y + Math.round((primary.height - state.height) / 2)
  }
}
