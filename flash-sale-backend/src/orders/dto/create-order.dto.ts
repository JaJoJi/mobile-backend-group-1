import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  productId!: string;
}