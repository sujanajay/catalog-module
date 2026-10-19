// Reads the `notes` column of a links workbook per identifier (the sheet writer's layout: two header
// rows, "identifier" and "notes" in the first). Used by the completeness check for skipped cells.
import ExcelJS from "exceljs";

export async function sheetNotes(xlsx: Buffer): Promise<Map<string, string>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(xlsx) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0], notes = new Map<string, string>();
  if (!ws) return notes;
  let idCol = 0, notesCol = 0;
  for (let c = 1; c <= ws.columnCount; c++) { const top = ws.getCell(1, c).master.text.trim(); if (top === "identifier") idCol = c; if (top === "notes") notesCol = c; }
  if (idCol && notesCol) for (let r = 3; r <= ws.rowCount; r++) { const id = ws.getCell(r, idCol).text.trim(); if (id) notes.set(id, ws.getCell(r, notesCol).text); }
  return notes;
}
