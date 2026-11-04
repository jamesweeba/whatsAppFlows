import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Form fields sent alongside the Excel file. */
export class BulkUploadDto {
  /** Category for rows whose `category` cell is empty. Optional when every row has one. */
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  categoryId?: string;
}
