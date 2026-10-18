export interface ChunkProduct { productId: string; sourceCount: number; identifier?: string }
export interface ChunkPlan { productIds: string[]; sourceCount: number }
export function planChunks(products: ChunkProduct[], chunkImages = 25): ChunkPlan[] {
  if (!Number.isInteger(chunkImages) || chunkImages < 1) throw new Error("Chunk size must be a positive integer.");
  const sorted = [...products].sort((a, b) => (a.identifier ?? a.productId).localeCompare(b.identifier ?? b.productId, "en", { numeric: true }) || a.productId.localeCompare(b.productId));
  const chunks: ChunkPlan[] = [];
  for (const p of sorted) {
    let chunk = chunks.at(-1);
    if (!chunk || chunk.sourceCount + p.sourceCount > chunkImages) { chunk = { productIds: [], sourceCount: 0 }; chunks.push(chunk); }
    chunk.productIds.push(p.productId); chunk.sourceCount += p.sourceCount;
  }
  return chunks;
}
