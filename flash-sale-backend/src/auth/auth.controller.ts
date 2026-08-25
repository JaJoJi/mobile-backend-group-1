import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { GetTokenDto } from './dto/get-token.dto';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('token')
  @HttpCode(200)
  async getToken(@Body() dto: GetTokenDto) {
    return this.authService.getToken(dto.userId);
  }
}