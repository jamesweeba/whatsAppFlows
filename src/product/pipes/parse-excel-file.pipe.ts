import {
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';

@Injectable()
export class ParseExcelFilePipe implements PipeTransform {
  private readonly maxSizeBytes = 5 * 1024 * 1024; // 5 MB
  private readonly allowedMimeTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel', // .xls
    'application/wps-office.xlsx',
    'application/wps-office.xls',
  ];

  transform(file: Express.Multer.File): Express.Multer.File {
    if (!file) {
      throw new BadRequestException('No file uploaded.');
    }

    if (file.size > this.maxSizeBytes) {
      throw new BadRequestException(
        `File size exceeds limit of ${this.maxSizeBytes / (1024 * 1024)}MB.`,
      );
    }

    const isAllowedMime = this.allowedMimeTypes.includes(file.mimetype);
    const isAllowedExt = /\.(xlsx|xls)$/i.test(file.originalname);

    if (!isAllowedMime && !isAllowedExt) {
      throw new BadRequestException(
        'Invalid file format. Only Excel files (.xlsx, .xls) are allowed.',
      );
    }

    return file;
  }
}
