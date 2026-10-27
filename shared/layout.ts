/**
 * Program picture layout maths.
 *
 * Pure helpers shared by the browser compositor and the server side program
 * state so that "what the host sees" and "what is encoded" always agree.
 */

/** Column count for a grid of `count` tiles. */
export function gridColumnsFor(count) {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return Math.ceil(Math.sqrt(n));
}

/**
 * Rectangles for a tile grid, in output pixels.
 * @returns {Array<{index: number, x: number, y: number, w: number, h: number}>}
 */
export function computeGridLayout(count, { width = 1280, height = 720, gap = 8, padding = 0 }: any = {}) {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  const cols = gridColumnsFor(n);
  const rows = Math.ceil(n / cols);
  const innerW = Math.max(1, width - padding * 2 - gap * (cols - 1));
  const innerH = Math.max(1, height - padding * 2 - gap * (rows - 1));
  const cellW = innerW / cols;
  const cellH = innerH / rows;
  const tiles = [];
  for (let index = 0; index < n; index += 1) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    tiles.push({
      index,
      x: Math.round(padding + col * (cellW + gap)),
      y: Math.round(padding + row * (cellH + gap)),
      w: Math.round(cellW),
      h: Math.round(cellH),
    });
  }
  return tiles;
}

/**
 * Layout for the on-air picture.
 *
 * - `single` / `screenshare`: one full-frame tile.
 * - `grid`: every requested source laid out together.
 */
export function computeProgramLayout({
  mode = 'single',
  sourceCount = 0,
  width = 1280,
  height = 720,
  gap = 8,
}: any = {}) {
  const count = Math.max(0, Math.floor(sourceCount));
  if (count === 0) return [];
  if (mode === 'grid') {
    return computeGridLayout(count, { width, height, gap, padding: Math.round(gap) });
  }
  return [{ index: 0, x: 0, y: 0, w: Math.round(width), h: Math.round(height) }];
}

/**
 * Which sources are currently on the air, in draw order.
 *
 * @param {object} params
 * @param {Array<object>} params.sources  every registered studio source
 * @param {object} params.program         `{ mode, sourceId, gridIds }`
 * @returns {Array<object>} the sources to composite, in order
 */
export function resolveProgramSources({ sources = [], program = {} }: any = {}) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const mode = program.mode || 'single';

  if (mode === 'grid') {
    const ids = Array.isArray(program.gridIds) ? program.gridIds : [];
    const chosen = ids.map((id) => byId.get(id)).filter(Boolean);
    if (chosen.length) return chosen;
    // Every camera and screen plus the participants who joined the call
    // (`virtual` sources), which is exactly what the server's grid mode picks.
    return sources.filter(
      (source) => source.kind === 'camera' || source.kind === 'screen' || source.kind === 'virtual',
    );
  }

  if (mode === 'screenshare') {
    const screen = program.sourceId ? byId.get(program.sourceId) : null;
    if (screen) return [screen];
    const anyScreen = sources.find((source) => source.kind === 'screen');
    return anyScreen ? [anyScreen] : [];
  }

  const single = program.sourceId ? byId.get(program.sourceId) : null;
  if (single) return [single];
  const fallback = sources.find((source) => source.kind === 'camera') || sources[0];
  return fallback ? [fallback] : [];
}
