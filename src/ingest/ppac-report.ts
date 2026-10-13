import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import type { PpacRow } from '../types.js';

/**
 * Parser for the PPAC "AI Builder consumption report" export
 * (https://learn.microsoft.com/en-us/ai-builder/administer-consumption-report).
 * Documented columns: Date, UserId, EnvironmentId, EnvironmentName, AIConsumption, IsTrial.
 * Header matching is case/space-insensitive; unknown extra columns are ignored.
 */

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEADER_ALIASES: Record<string, keyof PpacRow> = {
  date: 'date',
  startdatetime: 'date', // schema observed Oct 2026
  userid: 'userId',
  useremail: 'userEmail', // schema observed Oct 2026
  environmentid: 'environmentId',
  environmentname: 'environmentName',
  aiconsumption: 'aiConsumption',
  aiconsumptioncredits: 'aiConsumption',
  consumptionunits: 'aiConsumption', // schema observed Oct 2026
  creditsconsumed: 'aiConsumption',
  istrial: 'isTrial',
};

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return /^(true|yes|1)$/i.test(String(value ?? '').trim());
}

function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  // Already ISO-like
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Common M/D/YYYY export format
  const mdy = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return text;
}

function buildRows(headerCells: string[], dataRows: unknown[][]): PpacRow[] {
  const columnMap = new Map<number, keyof PpacRow>();
  headerCells.forEach((header, index) => {
    const field = HEADER_ALIASES[normalizeHeader(header)];
    if (field) columnMap.set(index, field);
  });
  const mapped = [...columnMap.values()];
  if (!mapped.includes('date') || !mapped.includes('aiConsumption')) {
    throw new Error(
      `Unrecognized PPAC report format. Expected at least Date and AIConsumption columns, got: ${headerCells.join(', ')}`
    );
  }

  const rows: PpacRow[] = [];
  for (const raw of dataRows) {
    if (!raw || raw.every((cell) => cell === null || cell === undefined || String(cell).trim() === '')) {
      continue;
    }
    const row: PpacRow = {
      date: '',
      userId: null,
      userEmail: null,
      environmentId: null,
      environmentName: null,
      aiConsumption: 0,
      isTrial: false,
    };
    for (const [index, field] of columnMap) {
      const cell = raw[index];
      switch (field) {
        case 'date':
          row.date = toIsoDate(cell);
          break;
        case 'aiConsumption':
          row.aiConsumption = Number(cell ?? 0) || 0;
          break;
        case 'isTrial':
          row.isTrial = toBool(cell);
          break;
        case 'userId':
          row.userId = cell === null || cell === undefined ? null : String(cell);
          break;
        case 'userEmail':
          row.userEmail = cell === null || cell === undefined ? null : String(cell);
          break;
        case 'environmentId':
          row.environmentId = cell === null || cell === undefined ? null : String(cell);
          break;
        case 'environmentName':
          row.environmentName = cell === null || cell === undefined ? null : String(cell);
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}

export function parsePpacCsv(text: string): PpacRow[] {
  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    throw new Error(`CSV parse error: ${parsed.errors[0].message} (row ${parsed.errors[0].row})`);
  }
  const [header, ...data] = parsed.data;
  if (!header) throw new Error('CSV file is empty.');
  return buildRows(header, data);
}

export async function parsePpacXlsx(filePath: string): Promise<PpacRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Workbook has no worksheets.');

  const header: string[] = [];
  const data: unknown[][] = [];
  sheet.eachRow((row, rowNumber) => {
    const cells: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = cell.value instanceof Object && 'result' in (cell.value as object)
        ? (cell.value as { result: unknown }).result
        : cell.value;
    });
    if (rowNumber === 1) {
      header.push(...cells.map((c) => String(c ?? '')));
    } else {
      data.push(cells);
    }
  });
  return buildRows(header, data);
}

export async function parsePpacReport(filePath: string): Promise<PpacRow[]> {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.xlsx') return parsePpacXlsx(filePath);
  return parsePpacCsv(readFileSync(filePath, 'utf8'));
}
