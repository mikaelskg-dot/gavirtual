/**
 * Lector de CSV sencillo para importar el catálogo: detecta el separador (; , o tabulador),
 * admite comillas dobles y saltos de línea de Windows.
 */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const count = (c: string): number => firstLine.split(c).length - 1;
  const delim = [';', '\t', ','].reduce((best, c) => (count(c) > count(best) ? c : best), ';');

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell.trim());
      cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

export interface ImportRow {
  code: string;
  name: string;
  folder: string;
}

export interface ImportParse {
  rows: ImportRow[];
  errors: string[];
}

/** Columnas: código, nombre, carpeta. La primera fila se ignora si parece una cabecera. */
export function parseCatalogCsv(text: string): ImportParse {
  const all = parseCsv(text);
  const head = (all[0]?.[0] ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const body = ['codigo', 'code', 'cod', 'referencia', 'ref'].includes(head) ? all.slice(1) : all;
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  body.forEach((r, i) => {
    const line = i + 1 + (body === all ? 0 : 1);
    const [code = '', name = '', folder = ''] = r;
    if (!code || !name || !folder) {
      errors.push(`Línea ${line}: faltan datos (se necesitan código, nombre y carpeta).`);
      return;
    }
    const key = code.toLowerCase();
    if (seen.has(key)) {
      errors.push(`Línea ${line}: el código ${code} está repetido en el archivo.`);
      return;
    }
    seen.add(key);
    rows.push({ code, name, folder });
  });
  return { rows, errors };
}
