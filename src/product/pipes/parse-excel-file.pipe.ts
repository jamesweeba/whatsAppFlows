import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** The largest Excel upload. Also the multer limit, so a bigger body is never buffered. */
export const MAX_EXCEL_BYTES = 5 * 1024 * 1024;
/** An .xlsx is a zip; refuse one that unpacks to more than this (a "zip bomb" would exhaust memory). */
const MAX_UNZIPPED_BYTES = 30 * 1024 * 1024;

const isXlsx = (b: Buffer) => b.length >= 4 && b.readUInt32LE(0) === 0x04034b50; // PK\x03\x04
const isXls = (b: Buffer) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])); // OLE2

/**
 * The total unzipped size of a zip, from its central directory (nothing is inflated), or null
 * when the directory can't be read or uses Zip64 (no spreadsheet template needs that).
 */
export function unzippedSize(zip: Buffer): number | null {
  const searchFrom = Math.max(0, zip.length - 22 - 0xffff);
  let end = -1;
  for (let i = zip.length - 22; i >= searchFrom; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const entries = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) return null;
    const size = zip.readUInt32LE(at + 24);
    if (size === 0xffffffff) return null;
    total += size;
    at += 46 + zip.readUInt16LE(at + 28) + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return total;
}

/** Accepts a real .xlsx or .xls file (checked by its bytes, not its name) that is safe to open. */
@Injectable()
export class ParseExcelFilePipe implements PipeTransform {
  transform(file: Express.Multer.File): Express.Multer.File {
    if (!file) throw new BadRequestException('No file uploaded.');
    if (file.size > MAX_EXCEL_BYTES) throw new BadRequestException(`File size exceeds limit of ${MAX_EXCEL_BYTES / (1024 * 1024)}MB.`);

    if (isXlsx(file.buffer)) {
      const size = unzippedSize(file.buffer);
      if (size === null || size > MAX_UNZIPPED_BYTES) throw new BadRequestException('That Excel file is too large or damaged. Use the template.');
    } else if (!isXls(file.buffer)) {
      throw new BadRequestException('Invalid file format. Only Excel files (.xlsx, .xls) are allowed.');
    }
    return file;
  }
}
