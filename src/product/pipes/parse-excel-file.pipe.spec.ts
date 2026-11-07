import { BadRequestException } from '@nestjs/common';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { ParseExcelFilePipe, unzippedSize } from './parse-excel-file.pipe.js';

const pipe = new ParseExcelFilePipe();
const upload = (buffer: Buffer, originalname = 'products.xlsx') => ({ buffer, size: buffer.length, originalname, mimetype: 'application/octet-stream' }) as Express.Multer.File;

const workbook = (bookType: 'xlsx' | 'xls') => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['product_name', 'price'], ['Tomatoes', 10]]), 'Products');
  return XLSX.write(book, { type: 'buffer', bookType }) as Buffer;
};

/** A minimal zip with one stored entry whose data is `size` bytes of zeros, deflated. */
const zipOf = (size: number) => {
  const data = deflateRawSync(Buffer.alloc(size));
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  const centralAt = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralAt, 16);
  return Buffer.concat([local, name, data, central, name, end]);
};

describe('ParseExcelFilePipe', () => {
  it('accepts real .xlsx and .xls files', () => {
    expect(() => pipe.transform(upload(workbook('xlsx')))).not.toThrow();
    expect(() => pipe.transform(upload(workbook('xls'), 'products.xls'))).not.toThrow();
  });

  it('refuses a file that only looks like Excel by its name', () => {
    expect(() => pipe.transform(upload(Buffer.from('product_name,price\nTomatoes,10'), 'products.xlsx'))).toThrow(BadRequestException);
  });

  it('refuses a zip that unpacks to far more than it weighs', () => {
    const bomb = zipOf(40 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(100 * 1024);
    expect(unzippedSize(bomb)).toBe(40 * 1024 * 1024);
    expect(() => pipe.transform(upload(bomb))).toThrow(BadRequestException);
    expect(() => pipe.transform(upload(zipOf(1000)))).not.toThrow();
  });
});
