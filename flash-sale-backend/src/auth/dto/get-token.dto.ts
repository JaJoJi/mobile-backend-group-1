import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class GetTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  userId!: string;
}